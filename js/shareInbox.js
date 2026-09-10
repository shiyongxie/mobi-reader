/**
 * shareInbox.js —— 安卓「分享直达」的临时收件箱
 * -------------------------------------------------------------
 * 用户从文件管理器把 .epub/.mobi 分享到本应用时，浏览器发出的是一个
 * POST 导航（multipart/form-data），而静态托管服务器处理不了 POST。
 * 唯一能接下它的是 Service Worker：SW 把文件存进这里的收件箱，
 * 再 303 重定向到首页，由页面把文件取出来交给既有的导入流程。
 *
 * 为什么单开一个库（`mobi-reader-inbox`）而不是塞进 js/storage.js：
 * SW 与页面会同时打开这个库，若与主库共用就会牵扯到 DB_VERSION 的升级
 * 时序（一边要升版、另一边还开着旧版连接 → 阻塞或报错）。分开后
 * **js/storage.js 的 schema 与 DB_VERSION 一个字节都不用动**。
 *
 * 本文件是收件箱 schema 的**唯一真相源**，页面与 SW 共用同一份，
 * 避免两侧各写一份导致「写进去了但读不到」的静默漂移。
 * SW 侧靠 importScripts 加载，页面侧靠 <script> 加载。
 */
'use strict';

(function (scope) {

  const DB_NAME = 'mobi-reader-inbox';
  const DB_VERSION = 1;
  const STORE = 'inbox';
  /** 页面始终没打开（用户分享完就切走了）时的兜底清理时限 */
  const TTL = 60 * 60 * 1000;

  function open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('打开分享收件箱失败'));
      req.onblocked = () => reject(new Error('分享收件箱被其他标签页占用'));
    });
  }

  /**
   * 跑一次事务。**关键：等 tx.oncomplete 才 resolve**，不是在请求的
   * onsuccess 里 —— 后者只代表请求被处理，数据尚未落盘。SW 必须等真正
   * 提交完才返回 303，否则页面可能先开始加载、读到一个还不存在的 id。
   * @param {(store: IDBObjectStore) => void} fn 在事务里发请求；结果写进闭包
   */
  function withStore(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      let tx;
      const done = err => {
        try { db.close(); } catch (_) { /* 已关闭 */ }
        if (err) reject(err); else resolve();
      };
      try {
        tx = db.transaction(STORE, mode);
      } catch (e) {
        done(e);
        return;
      }
      tx.oncomplete = () => done(null);
      tx.onerror = () => done(tx.error || new Error('收件箱事务失败'));
      tx.onabort = () => done(tx.error || new Error('收件箱事务被中止'));
      try { fn(tx.objectStore(STORE)); }
      catch (e) { try { tx.abort(); } catch (_) { /* 已中止 */ } done(e); }
    }));
  }

  /**
   * SW 侧：存入一批分享来的文件，返回收件箱 id。
   */
  async function put(files) {
    const box = {};
    await withStore('readwrite', store => {
      const req = store.add({
        // File 是 Blob 的子类，结构化克隆可存；name/type 必须单独留一份，
        // 因为书籍 ID 与缓存命中都依赖 file.name
        files: files.map(f => ({ name: f.name || '', type: f.type || '', blob: f })),
        createdAt: Date.now(),
      });
      req.onsuccess = () => { box.id = req.result; };
    });
    return box.id;
  }

  /**
   * 页面侧：原子地「读取并删除」。
   * 读与删在**同一个 readwrite 事务**里，因此两个并发消费者只有一个拿得到，
   * 刷新页面也不会重复导入。
   */
  async function take(id) {
    const box = { row: null };
    await withStore('readwrite', store => {
      // 从 URL 查询串来的 id 是字符串，而 keyPath 存的是数字 ——
      // 直接 get('5') 取不到 5，表现为「分享进来什么都没发生」
      const n = Number(id);
      const key = Number.isFinite(n) && String(n) === String(id).trim() ? n : id;
      const req = store.get(key);
      req.onsuccess = () => {
        box.row = req.result || null;
        if (box.row) store.delete(key);
      };
    });
    return box.row;
  }

  /** 清理超时残留（页面启动与 SW activate 各调用一次） */
  async function purge(ttl) {
    const box = { n: 0 };
    await withStore('readwrite', store => {
      const cutoff = Date.now() - (ttl || TTL);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (!cur.value || !cur.value.createdAt || cur.value.createdAt < cutoff) {
          cur.delete();
          box.n++;
        }
        cur.continue();
      };
    });
    return box.n;
  }

  scope.SharedInbox = { DB_NAME, DB_VERSION, STORE, TTL, put, take, purge };

})(typeof self !== 'undefined' ? self : globalThis);
