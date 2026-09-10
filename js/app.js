/**
 * app.js —— 主入口：书架管理、文件导入、视图路由、PWA 注册
 * -------------------------------------------------------------
 * 视图路由非常简单（两页应用）：
 *   #view-shelf  书架
 *   #view-reader 阅读器（由 Reader.showView 控制）
 */
'use strict';

const App = (() => {

  let els = null;
  let importing = false;

  /* ------------------------------- 启动 ------------------------------- */

  function init() {
    els = {
      grid: document.getElementById('book-grid'),
      emptyTip: document.getElementById('empty-tip'),
      fileInput: document.getElementById('file-input'),
      progressBox: document.getElementById('import-progress'),
      progressBar: document.getElementById('import-bar'),
      progressText: document.getElementById('import-text'),
    };

    document.getElementById('btn-import').addEventListener('click', () =>
      els.fileInput.click());
    els.fileInput.addEventListener('change', e => {
      importFiles([...e.target.files]);
      e.target.value = '';
    });

    bindDragDrop();
    Reader.init();
    registerPWA();
    renderShareTip();

    // 首屏渲染书架
    renderShelf();

    // 消费安卓分享进来的文件。必须在 renderShelf 之后：导入成功会自己
    // 再刷一次书架，放前面会被这次首屏渲染覆盖掉
    consumeSharedFiles();
  }

  /* ---------------------------- 安卓分享直达 ---------------------------- */

  /**
   * 消费 SW 转存到收件箱的分享文件。
   *
   * 时序：分享面板 → POST → SW 存收件箱（等事务提交完）→ 303 到
   * index.html?share=<id> → 页面在这里取出并交给既有的 importFiles()。
   */
  async function consumeSharedFiles() {
    const m = /[?&]share=([^&]*)/.exec(location.search);
    if (!m) return;
    const raw = decodeURIComponent(m[1]);

    // 立刻清掉查询串：即使后面导入失败、或用户刷新，也不会重复触发
    history.replaceState(null, '', location.pathname + location.hash);

    if (raw === 'empty') { ui.toast('分享内容里没有可导入的电子书文件'); return; }
    if (raw === 'error') {
      ui.toast('接收分享失败，请改用「导入电子书」按钮选择文件', 6000);
      return;
    }
    if (typeof SharedInbox === 'undefined') return;

    try {
      const row = await SharedInbox.take(raw);   // 原子读+删，只会被消费一次
      if (!row || !row.files || !row.files.length) return;  // 已被消费或已清理
      // 必须重建 File 而不是直接用 blob：书籍 ID 与缓存命中都依赖 file.name，
      // 用原名重建，分享导入与手动导入同一本书才能命中同一条缓存
      const files = row.files.map(f => new File([f.blob], f.name || 'shared.epub',
        { type: f.type || '' }));
      await importFiles(files);
    } catch (err) {
      console.error('[分享导入失败]', err);
      ui.toast('分享导入失败：' + err.message, 6000);
    } finally {
      SharedInbox.purge().catch(() => { /* 清理失败无所谓 */ });
    }
  }

  /**
   * 在书架空态下方给一句「怎么用分享直达」的提示。
   * 只在 HTTPS 下出现（http/file:// 连 SW 都没有，提示了也做不到）；
   * 已经装到主屏的话功能本来就可用，不用再提示。
   */
  function renderShareTip() {
    const tip = document.getElementById('share-tip');
    if (!tip) return;
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (location.protocol !== 'https:') return;

    if (isAndroid) {
      const installed = window.matchMedia('(display-mode: standalone)').matches ||
        navigator.standalone === true;
      if (installed) return;   // 已经能用，不必打扰
      tip.textContent = '💡 把本页「添加到主屏幕」后，就能在文件管理器里长按 ' +
        '.epub / .mobi → 分享 → 选择本应用，直接导入。';
    } else if (isIOS) {
      // Safari 不支持网页接收系统分享，明说，免得用户白找
      tip.textContent = '💡 iOS 不支持把文件分享给网页应用，' +
        '请用上方「导入电子书」从「文件」App 里选取。';
    } else {
      return;   // 桌面端保持界面干净
    }
    tip.classList.remove('hidden');
  }

  /* ------------------------------ 文件导入 ------------------------------ */

  const ACCEPT_EXT = /\.(mobi|prc|epub)$/i;
  const ACCEPT_MIME = /\.(mobi|epub)|epub\+zip|mobipocket/i;

  async function importFiles(files) {
    const candidates = files.filter(f => ACCEPT_EXT.test(f.name) || ACCEPT_MIME.test(f.type));
    if (!candidates.length) {
      ui.toast('请选择 .mobi / .prc / .epub 文件（暂不支持 AZW3/KF8 与带 DRM 的书）');
      return;
    }
    if (importing) { ui.toast('正在导入中，请稍候'); return; }
    importing = true;
    els.progressBox.classList.remove('hidden');

    let ok = 0, fail = 0;
    for (const file of candidates) {
      try {
        setProgress(`解析 ${file.name}…`, 3);
        await MobiParser.loadBook(file, (stage, pct) =>
          setProgress(`${file.name}：${stage}`, pct));
        ok++;
      } catch (err) {
        // 完整错误打到控制台（含堆栈），界面上显示首行便于用户回报
        console.error('[导入失败]', file.name, '\n', err);
        const stackHead =
          err && typeof err.stack === 'string'
            ? '（详见浏览器控制台 F12）'
            : '';
        ui.toast(`《${file.name}》导入失败：${err.message}${stackHead}`, 6000);
        fail++;
      }
    }

    els.progressBox.classList.add('hidden');
    importing = false;
    if (ok > 0) {
      ui.toast(`成功导入 ${ok} 本${fail ? `，失败 ${fail} 本` : ''}`);
      await renderShelf();
    }
  }

  function setProgress(text, pct) {
    els.progressText.textContent = text;
    els.progressBar.style.width = pct + '%';
  }

  /* --------------------------- 拖拽导入（桌面端） --------------------------- */

  function bindDragDrop() {
    let dragDepth = 0;
    window.addEventListener('dragenter', e => {
      e.preventDefault();
      dragDepth++;
      document.getElementById('drop-hint').classList.remove('hidden');
    });
    window.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        document.getElementById('drop-hint').classList.add('hidden');
      }
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault();
      dragDepth = 0;
      document.getElementById('drop-hint').classList.add('hidden');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        importFiles([...e.dataTransfer.files]);
      }
    });
  }

  /* -------------------------------- 书架 -------------------------------- */

  async function renderShelf() {
    const books = (await Storage.getAllBooks())
      .sort((a, b) => b.lastOpened - a.lastOpened);

    els.grid.innerHTML = '';
    els.emptyTip.classList.toggle('hidden', books.length > 0);

    for (const b of books) {
      const card = document.createElement('div');
      card.className = 'book-card';

      // 封面：优先解析出的封面图，否则用标题首字占位
      const cover = document.createElement('div');
      cover.className = 'book-cover';
      if (b.cover && b.cover.base64) {
        const img = document.createElement('img');
        img.src = `data:${b.cover.mime};base64,${b.cover.base64}`;
        img.alt = '';
        cover.appendChild(img);
      } else {
        cover.classList.add('no-cover');
        cover.textContent = (b.title || '?').slice(0, 1);
      }

      const meta = document.createElement('div');
      meta.className = 'book-meta';
      meta.innerHTML = `
        <div class="book-title"></div>
        <div class="book-author"></div>
        <div class="book-time">${fmtTime(b.lastOpened)}</div>`;

      card.appendChild(cover);
      card.appendChild(meta);
      card.querySelector('.book-title').textContent = b.title || b.name;
      card.querySelector('.book-author').textContent = b.author || '未知作者';

      // 打开
      card.addEventListener('click', () => openBookById(b.id));

      // 删除按钮（阻止冒泡以免误触打开）
      const del = document.createElement('button');
      del.className = 'book-del';
      del.title = '删除本书';
      del.textContent = '✕';
      del.addEventListener('click', e => {
        e.stopPropagation();
        removeBook(b);
      });
      card.appendChild(del);

      els.grid.appendChild(card);
    }
  }

  async function openBookById(id) {
    try {
      const book = await MobiParser.openById(id);
      await Reader.open(book);
    } catch (err) {
      ui.toast(err.message, 3000);
    }
  }

  /** 删除书籍：同时清掉缓存内容与该书的全部标注（ReadMe 要求） */
  async function removeBook(book) {
    const ok = window.confirm(
      `确定删除《${book.title}》吗？\n将同时删除其缓存内容和全部标注，不可恢复。`);
    if (!ok) return;
    await Storage.removeBookCompletely(book.id);
    ui.toast('已删除');
    renderShelf();
  }

  function fmtTime(ts) {
    if (!ts) return '未读过';
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
      : `${d.getMonth() + 1}-${d.getDate()}`;
  }

  /* ------------------------------ 视图切换钩子 ------------------------------ */

  /** 阅读器关闭后刷新书架的"最近阅读时间" */
  function onReaderClosed() {
    renderShelf();
  }

  /* ------------------------------ PWA 注册 ------------------------------ */

  function registerPWA() {
    // manifest 已改为在 index.html 里静态声明（原因见那里的注释：
    // 动态注入对 share_target 的注册不可靠，且失败时完全静默）。
    if (location.protocol === 'file:') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* file:// 等环境静默跳过 */ });
  }

  return { init, onReaderClosed };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
