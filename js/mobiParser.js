/**
 * mobiParser.js —— 主线程侧的 MOBI 解析封装
 * -------------------------------------------------------------
 * 职责：
 *  1. 计算书籍 ID（文件名 + 大小 哈希），用于 IndexedDB 缓存命中判断
 *  2. 把文件 ArrayBuffer 交给 Web Worker 解析，转发进度事件
 *  3. 与 storage.js 协作完成"缓存优先"的加载策略
 */
'use strict';

const MobiParser = (() => {

  /* ---------- 书籍 ID：SHA-256(文件名 + 大小) 前 32 个十六进制字符 ---------- */

  async function bookId(fileName, size) {
    const text = `${fileName}:${size}`;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    } catch (e) {
      // 极少数环境（非安全上下文）无 crypto.subtle，退化为 FNV-1a
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, '0').repeat(4);
    }
  }

  /* ---------- Worker 封装：优先用 Worker，异常时自动降级主线程 ----------
     注意不能靠"预探测"判断 Worker 可用性：
     - Chrome 在 file:// 下禁止 Dedicated Worker 加载本地脚本，
       但 new Worker(fileURL) 在部分版本并不抛同步异常，
       而是异步触发 onerror —— 预探测不可靠。
     因此采用「先试 → 失败/超时则自动重跑主线程」的兜底模型，
     两条路径最终都调用同一份 parseWorker.js 的 parseMOBI()。           */

  /** 主线程降级：动态注入解析脚本后调用全局 parseMOBI() */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('无法加载解析脚本: ' + src));
      document.head.appendChild(s);
    });
  }

  async function parseOnMainThread(file, onProgress) {
    // EPUB 解析器必须在 parseWorker.js 之前就位：后者的 parseBook() 会调用它
    if (typeof self.parseEPUB !== 'function') await loadScript('worker/epubParser.js');
    if (typeof self.parseBook !== 'function') await loadScript('worker/parseWorker.js');
    self.__progressHook = msg => {
      if (msg.type === 'progress' && onProgress) onProgress(msg.stage, msg.pct);
    };
    // 让 UI 先渲染一次进度提示再进入同步解析
    await new Promise(r => setTimeout(r, 30));
    try {
      const buffer = await file.arrayBuffer();
      // 必须 await：parseBook 对 EPUB 返回 Promise，直接 return 会让 finally
      // 在解析真正结束**之前**就清掉 __progressHook —— 进度条停在 3%，
      // 且此后的 post() 会落回 self.postMessage（window 上没有这个方法）直接抛错
      return await self.parseBook(buffer, file.name);
    } finally {
      self.__progressHook = null;
    }
  }

  /* Worker 无响应多久算「环境不可用」。这不是「解析要多久」的上限，而是
     「多久没吭声」的上限 —— 每收到一条进度消息就重新计时（见 parseInWorker）。
     固定超时对 EPUB 是误杀：一本 24MB 的书解压 + 解析超过 5 秒很正常，
     一旦误判就会静默丢掉 Worker、在主线程重跑一遍，UI 卡死几十秒。 */
  const WORKER_IDLE_TIMEOUT = 8000;

  /** 真实 Worker 路径：返回从未 settle 过的 Promise 包装（见 runParse） */
  function parseWithWorker(file, onProgress) {
    return new Promise((resolve, reject) => {
      /* 注意：file:// 下 Chrome 会在"构造"时就同步抛出
         SecurityError（而非异步 onerror），必须在这里就地捕获，
         否则会以业务错误的身份漏到用户界面。 */
      let worker;
      try {
        worker = new Worker('worker/parseWorker.js');
      } catch (e) {
        reject(Object.assign(
          new Error('worker-construct-failed:' + e.message),
          { __silent: true }));
        return;
      }
      let settled = false;
      worker.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'progress') {
          onProgress && onProgress(msg.stage, msg.pct);
        } else if (msg.type === 'done' && !settled) {
          settled = true;
          worker.terminate();
          resolve(msg.payload);
        } else if (msg.type === 'error' && !settled) {
          settled = true;
          worker.terminate();
          // 解析器自身的业务错误（如 DRM 提示）直接透传
          reject(Object.assign(new Error(msg.message), { __fromParser: true }));
        }
      };
      worker.onerror = err => {
        if (!settled) {
          settled = true;
          worker.terminate();
          reject(Object.assign(
            new Error('worker-load-failed:' + (err.message || '')),
            { __silent: true }));   // 触发主线程重试，不向用户展示
        }
      };
      file.arrayBuffer()
        .then(buf => worker.postMessage({ buffer: buf, fileName: file.name }, [buf]))
        .catch(reject);
    });
  }

  /**
   * 统一入口：先走 Worker；加载失败或「静默超时」则切到主线程重跑一遍。
   * 超时判定是**进度感知**的：只要 Worker 还在报进度就一直续期，
   * 只有连续 WORKER_IDLE_TIMEOUT 毫秒一声不吭才认为环境不可用。
   */
  async function parseInWorker(file, onProgress) {
    let timer = null;
    let settled = false;
    let fireTimeout;
    const timeoutRun = new Promise((_, rej) => { fireTimeout = rej; });
    // 给会输的那一侧挂空处理器，避免事后拒绝触发 "Unhandled promise rejection"
    const guardTimeout = timeoutRun.catch(() => { });

    const bump = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fireTimeout(
        Object.assign(new Error('worker-timeout'), { __silent: true })), WORKER_IDLE_TIMEOUT);
    };

    bump();                                   // 起跑即开始计时
    const workerRun = parseWithWorker(file, (stage, pct) => {
      bump();                                 // 每条进度都是「还活着」的证据
      onProgress && onProgress(stage, pct);
    });
    const guard = workerRun.catch(() => { });

    try {
      return await Promise.race([workerRun, timeoutRun]);
    } catch (err) {
      void guard;
      // 解析器的业务性错误（DRM/HUFF 等）不属于环境问题，直接抛给用户
      if (err && err.__fromParser) throw err;
      if (err && err.__silent) {
        console.warn('[mobiParser] Worker 不可用（可能是 file:// 协议），改为主线程解析。', err.message);
        return parseOnMainThread(file, onProgress);
      }
      throw err;
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      void guardTimeout;   // 输掉的那一侧已挂空处理器，这里只是表明有意忽略
    }
  }

  /* ---------- 高层入口：缓存优先的加载 ---------- */

  /**
   * 加载（必要时导入并解析）一本书。
   * @param {File} file
   * @param {(stage:string,pct:number)=>void} onProgress 进度回调
   * @returns {Promise<{book:object, fromCache:boolean}>}
   */
  async function loadBook(file, onProgress) {
    // 各阶段包裹 try/catch：报错时明确指出是哪一层出了问题，
    // （计算 ID / 读缓存 / 解析 / 写缓存）方便定位环境差异。
    let id;
    try {
      id = await bookId(file.name, file.size);
    } catch (err) {
      throw new Error(`[计算书籍ID] ${err.message}`);
    }

    let cached;
    try {
      cached = await Storage.getBook(id);
    } catch (err) {
      throw new Error(`[读取缓存] ${err.message}`);
    }

    // 1. 缓存命中 —— 直接返回，跳过整个解析过程（验收标准 4）
    if (cached) {
      onProgress && onProgress('缓存命中', 100);
      cached.lastOpened = Date.now();
      try {
        await Storage.putBook(cached);
      } catch (err) {
        throw new Error(`[更新缓存] ${err.message}`);
      }
      return { book: cached, fromCache: true };
    }

    // 2. 未命中 —— Worker 中解析（验收标准 1）
    let parsed;
    try {
      parsed = await parseInWorker(file, onProgress);
    } catch (err) {
      // 已带方括号前缀的属于解析器自身的业务错误（如 DRM），原样抛出
      if (/^\[/m.test(err.message)) throw err;
      throw new Error(`[解析] ${err.message}`);
    }

    const book = {
      id,
      name: file.name,
      size: file.size,
      title: parsed.title,
      author: parsed.author,
      meta: parsed.meta,
      sections: parsed.sections,   // [{id, html}]
      toc: parsed.toc,             // [{anchor, title, level}]
      images: parsed.images,       // [{mime, buffer}] —— 惰性转 Blob URL
      cover: parsed.cover,         // {mime, base64}
      addedAt: Date.now(),
      lastOpened: Date.now(),
      progress: null,              // {mode, ratio} 阅读进度
    };

    try {
      await Storage.putBook(book);
    } catch (err) {
      throw new Error(`[保存到数据库] ${err.message}`);
    }
    return { book, fromCache: false };
  }

  /** 根据 ID 打开书架里已有的书（不经过 File 对象） */
  async function openById(id) {
    const book = await Storage.getBook(id);
    if (!book) throw new Error('未找到该书，可能已被删除');
    book.lastOpened = Date.now();
    await Storage.putBook(book);
    return book;
  }

  return { bookId, loadBook, openById };
})();
