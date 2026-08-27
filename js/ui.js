/**
 * ui.js —— 界面通用工具：Toast 提示、模态弹窗
 * -------------------------------------------------------------
 * 全站共用的小型交互组件，被 reader / annotations / app 调用。
 */
'use strict';

const ui = (() => {

  /* ------------------------------ Toast ------------------------------ */

  let toastTimer = null;

  /** 底部浮出提示，2 秒后自动消失 */
  function toast(message, ms = 2000) {
    let el = document.getElementById('ui-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ui-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ------------------------------ 模态弹窗 ------------------------------ */

  /**
   * 笔记编辑弹窗（Promise 化）。
   * @param {object} opts
   *   title     弹窗标题
   *   quote     展示的摘录文本（可省）
   *   note      初始笔记内容
   *   colors    可选颜色数组（['yellow','green',...]，对应 CSS 类）
   *   color     初始颜色
   *   deletable 是否显示"删除"按钮
   * @returns Promise<
   *   {note,color}        点击确定
   * | {deleted:true}      点击删除
   * | null                取消 / 点遮罩关闭
   * >
   */
  function noteModal(opts = {}) {
    const mask = document.getElementById('modal-mask');
    const box = document.getElementById('modal-box');

    box.innerHTML = `
      <h3>${escapeHtml(opts.title || '笔记')}</h3>
      ${opts.quote ? `<blockquote class="modal-quote"></blockquote>` : ''}
      <textarea id="modal-note" rows="4"
        placeholder="写下你的想法…（可留空）"></textarea>
      <div class="color-row">
        ${(opts.colors || []).map(c => `
          <button type="button" class="swatch sw-${c}"
                  data-color="${c}" title="${c}"></button>`).join('')}
      </div>
      <div class="modal-actions">
        ${opts.deletable ? '<button class="btn danger" id="modal-del">删除</button>' : ''}
        <span style="flex:1"></span>
        <button class="btn" id="modal-cancel">取消</button>
        <button class="btn primary" id="modal-ok">保存</button>
      </div>`;

    if (opts.quote) box.querySelector('.modal-quote').textContent = `“${opts.quote}”`;
    const textarea = box.querySelector('#modal-note');
    textarea.value = opts.note || '';
    let color = opts.color;
    syncSwatches();

    function syncSwatches() {
      box.querySelectorAll('.swatch').forEach(s =>
        s.classList.toggle('active', s.dataset.color === color));
    }
    box.querySelectorAll('.swatch').forEach(s =>
      s.addEventListener('click', () => { color = s.dataset.color; syncSwatches(); }));

    textarea.focus();

    return new Promise(resolve => {
      const done = value => {
        mask.classList.add('hidden');
        cleanup();
        resolve(value);
      };
      const onCloseClick = e => {
        if (e.target === mask) done(null);
      };
      const onKey = e => {
        if (e.key === 'Escape') { done(null); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          done({ note: textarea.value.trim(), color });
        }
      };
      function cleanup() {
        document.getElementById('modal-ok').removeEventListener('click', okHandler);
        document.getElementById('modal-cancel').removeEventListener('click', cancelHandler);
        const del = document.getElementById('modal-del');
        del && del.removeEventListener('click', delHandler);
        mask.removeEventListener('mousedown', onCloseClick);
        document.removeEventListener('keydown', onKey);
      }
      const okHandler = () => done({ note: textarea.value.trim(), color });
      const cancelHandler = () => done(null);
      const delHandler = () => done({ deleted: true });

      document.getElementById('modal-ok').addEventListener('click', okHandler);
      document.getElementById('modal-cancel').addEventListener('click', cancelHandler);
      const delBtn = document.getElementById('modal-del');
      delBtn && delBtn.addEventListener('click', delHandler);
      mask.addEventListener('mousedown', onCloseClick);
      document.addEventListener('keydown', onKey);

      mask.classList.remove('hidden');
    });
  }

  /* -------------------------------- 工具 -------------------------------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 关闭所有侧边面板 */
  function closeAllPanels() {
    document.querySelectorAll('.side-panel.show')
      .forEach(p => p.classList.remove('show'));
  }

  /** 面板互斥开关：已打开则收起，否则独占展开 */
  function togglePanel(id) {
    const panel = document.getElementById(id);
    const wasOpen = panel.classList.contains('show');
    closeAllPanels();
    if (!wasOpen) panel.classList.add('show');
    return !wasOpen;
  }

  return { toast, noteModal, escapeHtml, togglePanel, closeAllPanels };
})();
