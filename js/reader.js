/**
 * reader.js —— 阅读器核心
 * -------------------------------------------------------------
 * 职责：
 *  1. 渲染书籍正文（章节 section + 图片 Blob URL 还原）
 *  2. 阅读设置：字号 / 行距 / 主题（护眼色）/ 字体家族 / 滚动·分页模式
 *  3. 目录侧栏生成与跳转、滚动时高亮当前目录项
 *  4. 阅读进度：节流保存（滚动比例 + 当前章节），打开时恢复
 *  5. 协调 TTS 与标注模块的挂载与重建通知
 */
'use strict';

const Reader = (() => {

  /* ------------------------------ 运行状态 ------------------------------ */

  let book = null;         // 当前书籍记录
  let els = null;          // 缓存的 DOM 引用
  let imgUrls = new Map(); // bookId -> [objectURL]   图片 Blob URL 会话缓存
  let saveTimer = null;    // 进度保存节流
  let scrollMax = 1;

  const THEME_LIST = ['light', 'sepia', 'green', 'dark'];

  /* ------------------------------ 初始化 ------------------------------ */

  function init() {
    els = {
      content: document.getElementById('reader-content'),
      scroll: document.getElementById('reader-scroll'),
      main: document.getElementById('reader-main'),
      title: document.getElementById('reader-title'),
      tocList: document.getElementById('toc-list'),
    };

    /* ---- 工具栏按钮 ---- */
    document.getElementById('btn-back').addEventListener('click', close);
    document.getElementById('btn-toc').addEventListener('click',
      () => ui.togglePanel('panel-toc'));
    document.getElementById('btn-anno-list').addEventListener('click',
      () => { ui.togglePanel('panel-annos'); });
    document.getElementById('btn-settings').addEventListener('click',
      () => ui.togglePanel('panel-settings'));

    /* ---- TTS 与标注模块挂载 ---- */
    TTS.init({ content: els.content, scroll: els.scroll, main: els.main });
    Annotations.init(els.content);

    /* ---- 滚动事件：目录高亮 + 进度节流保存 ---- */
    els.scroll.addEventListener('scroll', onScroll, { passive: true });

    /* ---- 设置面板控件 ---- */
    bindSettings();

    /* ---- 键盘：分页模式左右翻页，Esc 关闭面板 ---- */
    document.addEventListener('keydown', e => {
      if (!book || !isVisible()) return;
      if (e.key === 'Escape') { ui.closeAllPanels(); }
      if (settings.mode === 'page') {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') pageStep(1);
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') pageStep(-1);
      }
    });

    loadSettings();
  }

  function isVisible() {
    return !document.getElementById('view-reader').classList.contains('hidden');
  }

  /* ------------------------------ 打开/关闭 ------------------------------ */

  /** 渲染一本书进入阅读视图 */
  async function open(bookRecord) {
    book = bookRecord;

    /* 关键保护（两个都要）：
       1) 先给进度赋值快照 —— 后面的 applySettings/setMode 会触发 saveNow，
          若不快照，"当前位置=0"会先污染刚从数据库读出的进度；
       2) 打开期间抑制一切进度写入，直到恢复定位完成。 */
    const savedProgress = bookRecord.progress;
    suppressSaveUntil = Date.now() + 1500;

    stopProgressSaving();

    // 若正在读另一本，先收尾
    if (TTS.isActive()) TTS.stop();
    Annotations.deactivate();

    els.title.textContent = book.title;
    els.content.innerHTML = '';

    // 章节渲染（HTML 来自解析缓存，已含 <section id="sec-N"> 包裹）
    for (const sec of book.sections) {
      sec._fragment = document.createRange().createContextualFragment(sec.html);
      els.content.appendChild(sec._fragment);
      delete sec._fragment;
    }

    resolveImagesIn(els.content);
    applySettings();                       // 先应用字号/主题再恢复进度

    renderToc();

    await Annotations.activate(book);

    showView(true);
    restoreProgress(savedProgress, () => {   // 恢复上次阅读位置
      // 恢复完成后立即落盘一次，把"已恢复的位置"作为基线保存
      suppressSaveUntil = 0;
      saveNow();
    });
    startProgressSaving();
  }

  /** 返回书架前收尾 */
  function close() {
    saveNow();
    stopProgressSaving();
    if (TTS.isActive()) TTS.stop();
    Annotations.deactivate();
    showView(false);
    App.onReaderClosed();
  }

  function showView(readerVisible) {
    document.getElementById('view-shelf').classList.toggle('hidden', readerVisible);
    document.getElementById('view-reader').classList.toggle('hidden', !readerVisible);
    // 移动端切回阅读区后重算分页宽度
    if (readerVisible) requestAnimationFrame(relayoutPaged);
  }

  /**
   * 把 img[data-recindex="N"] 指向第 N 张提取出的图片 Blob URL。
   * recindex 是 MOBI 内图片的 1 基序号（由 Worker 记录提取顺序）。
   */
  function resolveImagesIn(scope) {
    if (!book) return;
    scope.querySelectorAll('img[data-recindex]').forEach(img => {
      const idx = Number(img.getAttribute('data-recindex')) - 1;
      const url = getImageUrl(idx);
      if (url) { img.src = url; img.removeAttribute('data-recindex'); }
      else img.removeAttribute('data-recindex');
    });
  }

  function getImageUrl(idx) {
    const urls = getImgUrlsForBook();
    return urls[idx] || null;
  }

  function getImgUrlsForBook() {
    let arr = imgUrls.get(book.id);
    if (!arr) {
      arr = (book.images || []).map(im =>
        im && im.buffer ? URL.createObjectURL(new Blob([im.buffer], { type: im.mime })) : '');
      imgUrls.set(book.id, arr);
    }
    return arr;
  }

  /* ------------------------------- 目录 ------------------------------- */

  function renderToc() {
    const ul = els.tocList;
    ul.innerHTML = '';
    const toc = book.toc.length ? book.toc : fallbackToc();
    toc.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = `toc-item lvl-${Math.min(item.level || 1, 3)}`;
      li.dataset.anchor = item.anchor;
      li.innerHTML = `<span class="toc-text"></span>`;
      li.querySelector('.toc-text').textContent = item.title;
      li.addEventListener('click', () => {
        jumpToAnchor(item.anchor);
        ui.closeAllPanels();
      });
      ul.appendChild(li);
    });
  }

  /** 书籍没有可识别标题时的兜底目录：每个章节一条 */
  function fallbackToc() {
    return book.sections.map(s => ({
      anchor: s.id,
      title: `第 ${Number(s.id.slice(4)) + 1} 节`,
      level: 1,
    }));
  }

  function jumpToAnchor(anchor) {
    if (settings.mode === 'page') setMode('scroll'); // 分页模式锚点跳转退回滚动
    const el = document.getElementById(anchor)
      || els.content.querySelector(`#${CSS.escape(anchor)}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** 滚动时把最近的标题高亮为当前目录项（节流） */
  let tocTick = false;
  function highlightCurrentToc() {
    if (tocTick) return;
    tocTick = true;
    requestAnimationFrame(() => {
      tocTick = false;
      const items = [...els.tocList.children];
      if (!items.length) return;
      const viewTop = els.scroll.getBoundingClientRect().top + 60;
      let best = -1;
      items.forEach((li, i) => {
        const target = document.getElementById(li.dataset.anchor);
        if (!target) return;
        const rect = target.getBoundingClientRect();
        if (rect.top <= viewTop) best = i;
      });
      items.forEach((li, i) => li.classList.toggle('current', i === best));
      currentAnchorId = best >= 0 ? items[best].dataset.anchor : null;
    });
  }
  let currentAnchorId = null;

  /* -------------------------- 阅读进度持久化 -------------------------- */

  /** 打开书籍后的短暂窗口内禁止保存进度：
      避免恢复定位的延迟帧与用户立即滚动的操作互相踩踏 */
  let suppressSaveUntil = 0;

  function onScroll() {
    highlightCurrentToc();
    scheduleSave();
  }

  function scheduleSave() {
    if (Date.now() < suppressSaveUntil) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 2000);       // 2s 节流
  }

  function startProgressSaving() {
    window.addEventListener('beforeunload', saveOnceOnUnload);
    scheduleSave();
  }

  function stopProgressSaving() {
    clearTimeout(saveTimer);
    window.removeEventListener('beforeunload', saveOnceOnUnload);
  }

  let saving = false;
  function saveNow() {
    if (!book || saving) return;
    if (Date.now() < suppressSaveUntil) return;   // 打开期抑制，防污染待恢复的进度
    saving = true;
    try {
      const ratio = settings.mode === 'page'
        ? clamp01(els.scroll.scrollLeft / Math.max(1, maxPageScroll()))
        : clamp01(els.scroll.scrollTop / Math.max(1, els.scroll.scrollHeight - els.scroll.clientHeight));
      book.progress = {
        mode: settings.mode === 'page' ? 'scroll' : settings.mode,
        ratio,
        secId: currentSectionAtRatio(ratio),
      };
      Storage.putBook(book).catch(() => {});
    } finally {
      setTimeout(() => { saving = false; }, 100);
    }
  }

  function saveOnceOnUnload() { try { saveNow(); } catch (e) { /* ignore */ } }

  /** 由滚动比例推算所在章节 id（只用于展示性信息） */
  function currentSectionAtRatio(_ratio) {
    if (!book) return null;
    return currentAnchorId ||
      (book.sections[0] && book.sections[0].id) || null;
  }

  /** 恢复进度；完成（或确认无需恢复）后调用 done 回调 */
  function restoreProgress(progress, done) {
    const finish = fn => { try { fn && fn(); } catch (e) { /* ignore */ } };
    // 用延时而非 rAF：后台标签页 / 部分无头环境会节流挂起 rAF，
    // setTimeout(…,60) 触发的强制布局最可靠。
    setTimeout(() => {
      void els.content.offsetHeight;   // 强制刷新布局，保证高度已就绪
      if (!progress) { els.scroll.scrollTop = 0; finish(done); return; }
      if (progress.mode === 'page' && settings.mode === 'page') {
        els.scroll.scrollLeft = progress.ratio * maxPageScroll();
        finish(done);
        return;
      }
      const max = els.scroll.scrollHeight - els.scroll.clientHeight;
      els.scroll.scrollTop = Math.round(progress.ratio * Math.max(0, max));
      // 注意：secId 主要用于展示层信息；实际定位以滚动比例为准，
      // 这样跨字号/窗口变化时也能近似回到原位置。
      finish(done);
    }, 60);
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* ------------------------------ 阅读设置 ------------------------------ */

  const DEFAULTS = {
    fontSize: 18,     // px
    lineHeight: 1.8,
    theme: 'light',   // light | sepia | green | dark
    font: 'serif',    // serif | sans
    mode: 'scroll',   // scroll | page
  };
  let settings = { ...DEFAULTS };

  async function loadSettings() {
    settings = { ...DEFAULTS, ...(await Storage.getSetting('settings', {})) };
    syncSettingsUI();
    applySettings();
  }

  async function saveSettingsPatch(patch) {
    Object.assign(settings, patch);
    await Storage.setSetting('settings', settings).catch(() => {});
    applySettings();
  }

  function bindSettings() {
    const $ = id => document.getElementById(id);

    $('set-font-size').addEventListener('input', e =>
      saveSettingsPatch({ fontSize: Number(e.target.value) }));
    $('set-line-height').addEventListener('input', e =>
      saveSettingsPatch({ lineHeight: Number(e.target.value) }));

    // 主题：四枚圆形色块按钮
    document.querySelectorAll('[data-theme-btn]').forEach(btn =>
      btn.addEventListener('click', () =>
        saveSettingsPatch({ theme: btn.dataset.themeBtn })));

    // 字体家族
    document.querySelectorAll('[data-font-btn]').forEach(btn =>
      btn.addEventListener('click', () =>
        saveSettingsPatch({ font: btn.dataset.fontBtn })));

    // 滚动 / 分页切换
    document.querySelectorAll('[data-mode-btn]').forEach(btn =>
      btn.addEventListener('click', () => setMode(btn.dataset.modeBtn)));

    // 分页模式的前进后退按钮
    document.getElementById('page-prev').addEventListener('click', () => pageStep(-1));
    document.getElementById('page-next').addEventListener('click', () => pageStep(1));

    window.addEventListener('resize', relayoutPaged);
  }

  function syncSettingsUI() {
    const $ = id => document.getElementById(id);
    $('set-font-size').value = settings.fontSize;
    $('set-font-size-val').textContent = settings.fontSize + 'px';
    $('set-line-height').value = settings.lineHeight;
    $('set-line-height-val').textContent = settings.lineHeight.toFixed(1);
    updateGroupActive('[data-theme-btn]', 'themeBtn', settings.theme);
    updateGroupActive('[data-font-btn]', 'fontBtn', settings.font);
    updateGroupActive('[data-mode-btn]', 'modeBtn', settings.mode);
  }

  function updateGroupActive(selector, dataKey, value) {
    document.querySelectorAll(selector).forEach(b =>
      b.classList.toggle('active', b.dataset[dataKey] === value));
  }

  /** 把设置落到 DOM 上（读区内部样式统一作用于 #reader-content） */
  function applySettings() {
    els.content.style.fontSize = settings.fontSize + 'px';
    els.content.style.lineHeight = String(settings.lineHeight);
    els.content.style.fontFamily = settings.font === 'sans'
      ? "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
      : "'Georgia', 'Songti SC', SimSun, 'Noto Serif SC', serif";
    document.body.dataset.theme = settings.theme;
    setMode(settings.mode, true);
    syncSettingsUI();
  }

  /* ----------------------------- 滚动 vs 分页 ----------------------------- */

  const PAGE_GAP = 48;

  /** 切换滚动/分页阅读模式（force 用于初次应用时不重复动画） */
  function setMode(mode, silent) {
    const prevMode = settings.mode;
    settings.mode = mode;
    if (mode === 'page' && prevMode !== 'page') {
      // 从滚动模式进入分页：记住纵向比例便于返回
      els.content.style.columnGap = PAGE_GAP + 'px';
      els.scroll.classList.add('paged');
    } else if (mode === 'scroll' && prevMode !== 'scroll') {
      els.scroll.classList.remove('paged');
      els.content.style.height = '';
      els.content.style.columnWidth = '';
      els.content.style.columnGap = '';
      els.scroll.scrollLeft = 0;
    }
    relayoutPaged();
    document.body.classList.toggle('is-paged', mode === 'page');
    if (!silent) Storage.setSetting('settings', settings).catch(() => {});
    updateGroupActive('[data-mode-btn]', 'modeBtn', mode);
    saveNow();
  }

  /** 计算/刷新分页布局参数（窗口尺寸或字号变化时调用） */
  function relayoutPaged() {
    if (!els || settings.mode !== 'page') return;
    els.content.style.height =
      (els.scroll.clientHeight - els.content.offsetTop * 2) + 'px';
    els.content.style.columnWidth = els.scroll.clientWidth + 'px';
    pageIndicator();
  }

  function maxPageScroll() {
    return els.scroll.scrollWidth - els.scroll.clientWidth;
  }

  function pageStep(dir) {
    els.scroll.scrollBy({ left: dir * (els.scroll.clientWidth + PAGE_GAP), behavior: 'smooth' });
  }

  function pageIndicator() {
    const span = document.getElementById('page-pos');
    if (!span) return;
    const total = Math.max(1, Math.round(
      (els.content.scrollHeight || 1) / (els.content.clientHeight || 1)));
    const cur = Math.max(1, Math.min(total,
      Math.round(els.scroll.scrollLeft / (els.scroll.clientWidth + PAGE_GAP)) + 1));
    span.textContent = `${cur} / ${total}`;
  }

  /* ------------------------- 给外部模块的接口 ------------------------- */

  /** 标注模块重建章节 DOM 后需要重新解析该节内的图片引用 */
  function reapplyImages(scopeEl) {
    resolveImagesIn(scopeEl);
  }

  return { init, open, close, resolveImagesIn, isOpen: isVisible };
})();
