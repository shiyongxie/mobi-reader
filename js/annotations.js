/**
 * annotations.js —— 标注（高亮）与笔记模块
 * -------------------------------------------------------------
 * 位置记录方案（遵循 ReadMe 建议）：
 *   每条标注 = { bookId, secId, start, end, text, color, note, createdAt }
 *   其中 secId 是章节 <section id="sec-N">，start/end 是该章节内
 *   的扁平字符偏移量（相对章节文本起点累计，通过 TreeWalker 计算）。
 *
 * 坐标稳定性技巧：
 *   高亮使用不改变文本内容的 <mark> 包裹 —— 包裹后重新遍历文本节点
 *   时字符序列与原始 HTML 完全一致，因此偏移坐标系始终稳定。
 *   修改标注（换色/删笔记等）时直接用缓存的原始章节 HTML 重建该节，
 *   再统一重新套用全部标注，避免 unwrapping 复杂度。
 */
'use strict';

const Annotations = (() => {

  const COLORS = ['yellow', 'green', 'blue', 'pink'];

  let book = null;      // 当前书籍记录
  let list = [];        // 该书全部标注
  let els = null;       // {content} 阅读容器

  /* ------------------------------ 初始化 ------------------------------ */

  function init(contentEl) {
    els = { content: contentEl };

    // 选区变化 -> 浮动工具栏显示/隐藏
    document.addEventListener('selectionchange', debounce(onSelectionChange, 120));

    // 点击已有高亮 -> 编辑弹窗
    els.content.addEventListener('click', e => {
      const mark = e.target.closest('mark[data-anno-id]');
      if (mark) {
        e.preventDefault();
        openEditor(mark.getAttribute('data-anno-id'));
        clearSelection();
      }
    });

    // 浮动工具栏按钮
    document.getElementById('sel-highlight').addEventListener('click', () => annotate());
    document.getElementById('sel-note').addEventListener('click', () => annotate({ focusNote: true }));
    document.getElementById('sel-copy').addEventListener('click', copySelection);

    // 标注侧栏：导出/导入按钮
    document.getElementById('btn-anno-export').addEventListener('click', exportJson);
    document.getElementById('btn-anno-import').addEventListener('click', () => {
      document.getElementById('anno-import-file').click();
    });
    document.getElementById('anno-import-file').addEventListener('change', e => {
      if (e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });
  }

  /** 打开一本书：加载其全部标注并渲染到 DOM 上 */
  async function activate(bookRecord) {
    book = bookRecord;
    list = await Storage.getAnnotationsByBook(book.id);
    applyAll();
    renderPanel();
  }

  function deactivate() { hideSelToolbar(); }

  /* --------------------------- 偏移计算核心 --------------------------- */

  /**
   * 收集 root 内所有文本节点及其扁平起始偏移。
   * 注意包含 <mark> 内部的文本节点 —— 包裹不改变文本内容，
   * 因此这套坐标与"无标注的原始 HTML"完全一致，可长期复用。
   */
  function collectNodes(root) {
    const out = [];
    let pos = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      out.push({ node: n, start: pos, len: n.nodeValue.length });
      pos += n.nodeValue.length;
    }
    return out;
  }

  /**
   * 求选区 Range 相对 sectionRoot 的 [start,end) 字符偏移。
   * 选区跨出当前章节时返回 null。
   */
  function rangeToOffsets(secRoot, range) {
    if (!secRoot.contains(range.startContainer) || !secRoot.contains(range.endContainer)) {
      return null;
    }
    const nodes = collectNodes(secRoot);
    let start = -1, end = -1;
    for (const m of nodes) {
      if (start < 0 && m.node === range.startContainer) {
        start = m.start + range.startOffset;
      }
      if (m.node === range.endContainer) {
        end = m.start + range.endOffset;
        break;
      }
    }
    if (start < 0 || end < 0 || end <= start) return null;
    return { start, end };
  }

  /* ---------------------------- 高亮包裹 ---------------------------- */

  /**
   * 在 secRoot 上把 [start,end) 的文本包进 <mark data-anno-id=...>。
   * 先对文本节点做一次性快照，再依序处理重叠节点：
   * 用 Text.splitText 精确切分边界后把目标片段包进 mark。
   */
  function wrapRange(secRoot, start, end, annoId, color) {
    // ---- 快照（此刻的顺序与偏移在后续 split 中对本算法依然有效：
    //      每个 split 只影响正在处理的节点自身）----
    const nodes = [];
    let pos = 0;
    const walker = document.createTreeWalker(secRoot, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: pos });
      pos += n.nodeValue.length;
    }

    for (const m of nodes) {
      const len = m.node.nodeValue.length;
      const s = Math.max(start, m.start);
      const e = Math.min(end, m.start + len);
      if (e <= s) continue;

      let target = m.node;
      const localS = s - m.start;
      const localE = e - m.start;

      // 先切掉左侧多余部分
      if (localS > 0) target = target.splitText(localS);
      // 再切掉右侧多余部分（切完左侧后局部偏移左移 localS）
      const remainLen = target.nodeValue.length;
      const need = Math.min(localE - localS, remainLen);
      if (need < remainLen) target.splitText(need);

      const mark = document.createElement('mark');
      mark.className = `hl-${color}`;
      mark.setAttribute('data-anno-id', annoId);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }

  /**
   * 重建某一节的标注：<mark> 会替换文本节点导致后续遍历引用变化，
   * 所以这里先还原原始 HTML，再把该书此节的所有标注统一套回。
   */
  function rebuildSection(secId) {
    const idx = Number(/^sec-(\d+)$/.exec(secId)?.[1]);
    if (!Number.isInteger(idx)) return;
    const srcHtml = book.sections[idx] && book.sections[idx].html;
    const secEl = els.content.querySelector(`#${secId}`);
    if (srcHtml == null || !secEl) return;

    TTS.stopSilentlyIfSpeaking?.();
    secEl.innerHTML = srcHtml;                       // 回到无标注状态
    Reader.resolveImagesIn(secEl);                   // 还原图片 Blob URL

    list.filter(a => a.secId === secId)
      .sort((a, b) => b.start - a.start)
      .forEach(a => wrapRange(secEl, a.start, a.end, a.id, a.color));

    TTS.invalidate?.();                              // TTS 自检恢复
  }

  /** 全书重刷（激活、导入、批量删除后调用） */
  function applyAll() {
    const secIds = new Set(list.map(a => a.secId));
    secIds.forEach(id => rebuildSection(id));
  }

  /* ------------------------------ 标注操作 ------------------------------ */

  /** 由当前选区创建高亮/笔记 */
  async function annotate(opts = {}) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const secEl = range.startContainer.parentElement?.closest('section.mobi-section')
      || range.commonAncestorContainer.closest?.('section.mobi-section');
    if (!secEl) return;

    const offs = rangeToOffsets(secEl, range);
    if (!offs) { ui.toast('请选择同一章节内的文本'); return; }

    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;

    hideSelToolbar();

    let note = '';
    let color = COLORS[Date.now() % COLORS.length];
    if (opts.focusNote) {
      const r = await ui.noteModal({ title: '添加笔记', note: '', colors: COLORS, color });
      if (!r) { clearSelection(); return; }   // 用户取消
      note = r.note;
      color = r.color;
    }

    const record = {
      bookId: book.id,
      secId: secEl.id,
      start: offs.start,
      end: offs.end,
      text,
      color,
      note,
      createdAt: Date.now(),
    };
    record.id = await Storage.addAnnotation(record);
    list.push(record);

    wrapRange(secEl, record.start, record.end, record.id, color);
    renderPanel();
    clearSelection();
    if (note) ui.toast('笔记已保存');
  }

  /** 编辑弹窗：改色 / 笔记 / 删除 */
  function openEditor(annoId) {
    const anno = list.find(a => String(a.id) === String(annoId));
    if (!anno) return;
    ui.noteModal({
      title: '编辑标注',
      note: anno.note,
      colors: COLORS,
      color: anno.color,
      deletable: true,
      quote: anno.text.slice(0, 200),
    }).then(async r => {
      if (r === null) return;                 // 取消
      if (r.deleted) {
        await Storage.deleteAnnotation(anno.id);
        list = list.filter(a => a.id !== anno.id);
        rebuildSection(anno.secId);
        ui.toast('已删除标注');
      } else {
        anno.note = r.note;
        anno.color = r.color;
        await Storage.updateAnnotation(anno);
        rebuildSection(anno.secId);           // 换色需要重画 mark
      }
      renderPanel();
    });
  }

  function copySelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    navigator.clipboard.writeText(sel.toString())
      .then(() => ui.toast('已复制'))
      .catch(() => ui.toast('复制失败（浏览器限制）'));
    hideSelToolbar();
    clearSelection();
  }

  function clearSelection() {
    const sel = window.getSelection();
    sel && sel.removeAllRanges();
    hideSelToolbar();
  }

  /* -------------------------- 浮动选区工具栏 -------------------------- */

  function onSelectionChange() {
    if (!book) return;
    debounceRun(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelToolbar(); return; }
      const range = sel.getRangeAt(0);
      if (!els.content.contains(range.commonAncestorContainer)) { hideSelToolbar(); return; }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { hideSelToolbar(); return; }
      showSelToolbar(rect);
    });
  }

  function showSelToolbar(rect) {
    const bar = document.getElementById('sel-toolbar');
    bar.classList.remove('hidden');
    // 定位策略：水平居中于选区并夹在视口内；竖直方向优先放选区下方
    const bw = bar.offsetWidth || 180, bh = bar.offsetHeight || 40;
    let x = rect.left + (rect.width - bw) / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    let y = rect.bottom + 10;
    if (y + bh > window.innerHeight - 8) y = rect.top - bh - 10;
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  }

  function hideSelToolbar() {
    const bar = document.getElementById('sel-toolbar');
    bar && bar.classList.add('hidden');
  }

  /* ------------------------------ 侧栏面板 ------------------------------ */

  function renderPanel() {
    const ul = document.getElementById('anno-list');
    if (!ul) return;
    ul.innerHTML = '';
    document.getElementById('anno-count').textContent = `${list.length} 条`;
    // 按创建时间倒序展示（最新的在上面）
    [...list].sort((a, b) => b.createdAt - a.createdAt).forEach(a => {
      const li = document.createElement('li');
      li.className = 'anno-item';
      li.innerHTML = `
        <span class="anno-dot hl-${a.color}"></span>
        <div class="anno-body">
          <div class="anno-quote"></div>
          ${a.note ? `<div class="anno-note">📝 </div>` : ''}
          <div class="anno-time">${new Date(a.createdAt).toLocaleString()}</div>
        </div>`;
      li.querySelector('.anno-quote').textContent = a.text.slice(0, 80);
      if (a.note) li.querySelector('.anno-note').textContent += a.note.slice(0, 60);
      li.addEventListener('click', () => jumpTo(a));
      ul.appendChild(li);
    });
    if (!list.length) {
      ul.innerHTML = '<li class="anno-empty">还没有标注。<br>阅读时选中一段文字即可添加高亮或笔记。</li>';
    }
  }

  /** 跳转到某条标注对应的 DOM 位置 */
  function jumpTo(anno) {
    const mark = els.content.querySelector(`mark[data-anno-id="${anno.id}"]`);
    if (mark) {
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      mark.classList.add('flash');
      setTimeout(() => mark.classList.remove('flash'), 1600);
    } else {
      // 高亮元素缺失时的兜底：至少滚回所在章节开头
      els.content.querySelector(`#${CSS.escape(anno.secId)}`)
        ?.scrollIntoView({ block: 'start' });
    }
  }

  /* ----------------------------- 导入导出 ----------------------------- */

  async function exportJson() {
    if (!list.length) { ui.toast('暂无标注可导出'); return; }
    const payload = {
      type: 'mobi-reader-annotations',
      version: 1,
      exportedAt: new Date().toISOString(),
      book: { id: book.id, title: book.title, author: book.author },
      annotations: list,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${book.title}-标注.json`.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.type !== 'mobi-reader-annotations' || !Array.isArray(data.annotations)) {
        throw new Error('格式不符');
      }
      let n = 0;
      for (const raw of data.annotations) {
        // 允许导入到不同书籍实例（同 title/id 匹配更稳，这里简单关联当前书）
        const row = {
          bookId: book.id,
          secId: raw.secId,
          start: raw.start,
          end: raw.end,
          text: String(raw.text || ''),
          color: COLORS.includes(raw.color) ? raw.color : 'yellow',
          note: String(raw.note || ''),
          createdAt: raw.createdAt || Date.now(),
        };
        if (!row.text || !row.secId || row.end <= row.start) continue;
        row.id = await Storage.addAnnotation(row);
        list.push(row);
        n++;
      }
      applyAll();
      renderPanel();
      ui.toast(`成功导入 ${n} 条标注`);
    } catch (err) {
      ui.toast('导入失败：' + err.message);
    }
  }

  /* -------------------------------- 工具 -------------------------------- */

  /** 防抖执行器（selectionchange 专用） */
  let _t = null;
  function debounce(fn, ms = 80) {
    return (...args) => {
      clearTimeout(_t);
      _t = setTimeout(() => fn(...args), ms);
    };
  }
  let _r = null;
  function debounceRun(fn) {
    clearTimeout(_r);
    _r = setTimeout(fn, 50);
  }

  return { init, activate, deactivate, list: () => list };
})();
