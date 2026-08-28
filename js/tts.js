/**
 * tts.js —— 语音朗读模块（Web Speech API）
 * -------------------------------------------------------------
 * 设计要点：
 *  1. 分块缓冲调度：若以单句为最小单位逐句 speak，即使预取入队，
 *     每个 utterance 结束时合成器仍有引擎级“换挡”延迟，句间卡顿
 *     明显。因此把若干连续句子合并为一个播放块（~350 字），整块
 *     创建一个 utterance 交给浏览器，再维持深度 2 的预取队列 ——
 *     引擎每 30~60 秒才“换挡”一次，听感近乎连续；而块内的句间
 *     停顿由标点韵律自然产生，节奏不受影响。
 *  2. 双层同步高亮不修改 DOM：
 *     - 优先使用 CSS Custom Highlight API（Highlight 范围注册，
 *       浏览器原生渲染，滚动无需重绘，性能最佳）；
 *     - 不支持的浏览器降级为「矩形贴片覆盖层」（Range.getClientRects()
 *       取屏幕矩形画到透明覆盖层上）。
 *     当前句用「双 pass text-shadow」做加粗观感 —— 相比真正改
 *     font-weight，它不改变字形前进宽度，阅读区版面不会随朗读
 *     跳动；不支持 highlight 的浏览器退回背景色贴片。
 *  3. 词级边界：监听 utterance.onboundary，charIndex 映射回全局
 *     偏移定位当前词；不触发时自动只剩句子层。
 *  4. 移动端兜底：不少手机引擎（iOS 部分声音、国产 WebView、
 *     部分安卓系统 TTS）完全不触发 onboundary —— 此时高亮会纹丝
 *     不动。因此开播时先同步句层高亮到本块起点，并在收不到边界
 *     事件时按「累计朗读时长 × 每秒字数估算」推进句子高亮。
 */
'use strict';

const TTS = (() => {

  /* ------------------------------ 状态 ------------------------------ */

  let els = null;              // {content, scroll, main} 主线程 DOM 引用
  let overlay = null;          // 降级用的高亮覆盖层 <div id="tts-overlay">
  let sentences = [];          // [{start,end,text}] 句子切分结果
  let chunks = [];             // [{first,last,start,end}] 朗读块 = 连续句合并
  let sentToChunk = [];        // 句下标 -> 所属块下标
  let nodeMap = [];            // [{node,start,len}] 文本节点 -> 全局偏移映射
  let plainText = '';
  let cur = -1;                // 当前正在读的句子下标
  let state = 'stopped';       // stopped | playing | paused

  const cfg = {
    rate: 1,
    voiceURI: '',              // 用户选择的声音
  };

  // 句子/词两个高亮的 Range 缓存（两套绘制通道共用）
  let sentRange = null;
  let wordRange = null;

  /* ------------------------------ 初始化 ------------------------------ */

  function init(refs) {
    els = refs;
    overlay = document.createElement('div');
    overlay.id = 'tts-overlay';
    els.main.appendChild(overlay);

    // 降级绘制通道需要跟随滚动重绘；Highlight 通道由浏览器自适应
    els.scroll.addEventListener('scroll', () => paint(), { passive: true });
    window.addEventListener('resize', () => paint());

    // 绑定底部朗读控制条按钮
    $('#btn-tts-toggle', () => toggle());        // 工具栏上的 ▶/⏸
    $('#bar-play', () => toggle());              // 朗读控制条里的 ⏯
    $('#btn-tts-stop', () => stop());
    $('#btn-tts-prev', () => step(-1));
    $('#btn-tts-next', () => step(1));
    $('#btn-tts-close', () => stop());

    bindSliders();
  }

  /** $(id) + click 快捷方式 */
  function $(sel, onClick) {
    const el = document.querySelector(sel);
    if (el && onClick) el.addEventListener('click', onClick);
    return el;
  }

  function bindSliders() {
    // 语速滑杆
    const rateInput = document.getElementById('tts-rate');
    const rateVal = document.getElementById('tts-rate-val');
    if (rateInput) {
      rateInput.addEventListener('input', () => {
        cfg.rate = Number(rateInput.value);
        if (rateVal) rateVal.textContent = cfg.rate.toFixed(2).replace(/0$/, '') + 'x';
        saveCfg();
        // 语速即时生效：重启当前块（保持进度位置）
        if (state === 'playing') { const c = cur; softRestart(c); }
      });
    }
    // 声音下拉框（异步填充）
    const voiceSel = document.getElementById('tts-voice');
    if (voiceSel) {
      refreshVoices(voiceSel);
      if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.addEventListener('voiceschanged', () => refreshVoices(voiceSel));
      }
      voiceSel.addEventListener('change', () => {
        cfg.voiceURI = voiceSel.value;
        saveCfg();
        if (state === 'playing') { softRestart(cur); }
      });
    }
  }

  function saveCfg() {
    Storage.setSetting('tts', { rate: cfg.rate, voiceURI: cfg.voiceURI }).catch(() => {});
  }

  function restoreCfg() {
    Storage.getSetting('tts', {}).then(saved => {
      if (saved && saved.rate) cfg.rate = saved.rate;
      if (saved && saved.voiceURI) cfg.voiceURI = saved.voiceURI;
      const rateInput = document.getElementById('tts-rate');
      const rateVal = document.getElementById('tts-rate-val');
      if (rateInput) rateInput.value = cfg.rate;
      if (rateVal) rateVal.textContent = cfg.rate + 'x';
    }).catch(() => {});
  }

  /** 获取并填充声音列表；中文声音排在前面 */
  function refreshVoices(select) {
    const voices = speechSynthesis.getVoices();
    if (!voices.length || !select) return;
    const sorted = [...voices].sort((a, b) => {
      const azh = /^zh/i.test(a.lang) ? 0 : 1, bzh = /^zh/i.test(b.lang) ? 0 : 1;
      return azh - bzh || a.name.localeCompare(b.name);
    });
    select.innerHTML = '';
    sorted.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.voiceURI === cfg.voiceURI || (!cfg.voiceURI && /^zh-CN/i.test(v.lang))) {
        opt.selected = true;
        cfg.voiceURI = v.voiceURI;
      }
      select.appendChild(opt);
    });
  }

  /* ------------------------ 正文建模：文本节点映射 ------------------------ */

  /**
   * TreeWalker 收集 #reader-content 内全部可见文本节点，
   * 记录每个节点的全局起始偏移 → 形成扁平坐标系；
   * 随后切句、把句子合并为朗读块。
   */
  function buildModel() {
    nodeMap = [];
    let pos = 0;
    const walker = document.createTreeWalker(
      els.content,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          const t = n.nodeValue.replace(/\s+/g, '');
          const p = n.parentElement;
          if (!t) return NodeFilter.FILTER_REJECT;
          if (p && /^(script|style)$/i.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    while (walker.nextNode()) {
      const n = walker.currentNode;
      nodeMap.push({ node: n, start: pos, len: n.nodeValue.length });
      pos += n.nodeValue.length;
    }
    plainText = nodeMap.map(m => m.node.nodeValue).join('');
    sentences = splitSentences(plainText);
    buildChunks();
  }

  /**
   * 中英文混合的句子切分：在中止标点处断句；
   * 单句过长时在逗号/顿号附近找机会补断，避免超长文本触发
   * 部分平台的合成异常。
   */
  function splitSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const strongBreak =
        '。！？!?…；;\n\r'.includes(ch) ||
        ('.!?'.includes(ch) &&
          (i + 1 >= text.length || /\s/.test(text[i + 1]))); // 英文缩写中的点不断句
      if (!strongBreak) continue;
      // 吃掉连续标点与尾随空白
      let end = i + 1;
      while (end < text.length && /[。！？!?…；;”’"\n\r ]/.test(text[end])) end++;
      out.push({ start, end, text: text.slice(start, end) });
      start = end;
      i = end - 1;
    }
    if (start < text.length) out.push({ start, end: text.length, text: text.slice(start) });

    // 过长句子二次切分
    const refined = [];
    for (const s of out) {
      if (s.text.length <= 240) { refined.push(s); continue; }
      let cursor = s.start;
      while (cursor < s.end) {
        let hard = Math.min(cursor + 240, s.end);
        if (hard >= s.end) {
          refined.push({ start: cursor, end: s.end, text: text.slice(cursor, s.end) });
          break;
        }
        // 在 [cursor+120, hard] 里倒着找弱停顿符号
        let cut = -1;
        for (let j = hard; j > cursor + 120; j--) {
          if ('，,、 　'.includes(text[j])) { cut = j + 1; break; }
        }
        cut = cut > cursor ? cut : hard;
        refined.push({ start: cursor, end: cut, text: text.slice(cursor, cut) });
        cursor = cut;
      }
    }
    return refined.filter(s => s.text.trim().length > 0);
  }

  /**
   * 把连续句子合并为朗读块：目标 ~350 字。
   * 太小则引擎频繁换挡（卡顿回来），太大则 seek/跳句浪费重播量。
   * 块只做“多少字一播”，句间停顿仍由标点韵律负责，不受影响。
   */
  const CHUNK_TARGET = 350;

  function buildChunks() {
    chunks = [];
    let first = -1;
    for (let k = 0; k < sentences.length; k++) {
      if (first < 0) first = k;
      const reachEnd = k === sentences.length - 1;
      const enough =
        !reachEnd &&
        (sentences[k].end - sentences[first].start) >= CHUNK_TARGET;
      if (enough || reachEnd) {
        chunks.push({
          first, last: k,
          start: sentences[first].start,
          end: sentences[k].end,
        });
        first = -1;
      }
    }
    sentToChunk = new Array(sentences.length);
    chunks.forEach((c, ci) => {
      for (let k = c.first; k <= c.last; k++) sentToChunk[k] = ci;
    });
  }

  /** 全局偏移 -> 所在块下标（块有序不相交，二分查找） */
  function chunkIndexAt(abs) {
    let lo = 0, hi = chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (chunks[mid].end <= abs) lo = mid + 1;
      else hi = mid;
    }
    return lo < 0 ? 0 : lo;
  }

  /* --------------------------- 偏移 <-> DOM --------------------------- */

  /** 全局字符偏移 -> {node, offset}（二分查找节点映射） */
  function locateChar(abs) {
    let lo = 0, hi = nodeMap.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nodeMap[mid].start + nodeMap[mid].len <= abs) lo = mid + 1;
      else hi = mid;
    }
    const m = nodeMap[lo];
    return { node: m.node, offset: Math.min(abs - m.start, m.len) };
  }

  /** 由全局偏移区间构造 Range（跨节点安全）；空区间返回 null */
  function makeRange(a, b) {
    if (nodeMap.length === 0 || a == null || b == null || a >= b) return null;
    a = Math.max(0, a);
    b = Math.min(b, plainText.length);
    const s = locateChar(a), e = locateChar(Math.max(a, b));
    try {
      const r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      return r.collapsed ? null : r;
    } catch (err) { return null; }
  }

  /* ----------------------------- 高亮绘制 ----------------------------- */

  let hlSupport = false;   // CSS Custom Highlight API 可用性探测结果

  function detectHighlightAPI() {
    try {
      hlSupport = !!(window.CSS && CSS.highlights &&
                     typeof window.Highlight === 'function');
    } catch (e) { hlSupport = false; }
  }

  /**
   * 绘制两层高亮：
   *  - Highlight 通道：把 Range 注册进 CSS.highlights，样式由样式表
   *    的 ::highlight() 定义（句=阴影假加粗+淡底色；词=变色）。
   *  - 降级通道：矩形贴片覆盖层。
   */
  function paint() {
    if (hlSupport) {
      try {
        if (sentRange) CSS.highlights.set('tts-sentence', new Highlight(sentRange));
        else CSS.highlights.delete('tts-sentence');
        if (wordRange) CSS.highlights.set('tts-word', new Highlight(wordRange));
        else CSS.highlights.delete('tts-word');
        return;
      } catch (e) {
        hlSupport = false;   // Range 失效等异常 -> 永久走降级通道
        clearHighlights();
      }
    }
    paintOverlay();
  }

  function clearHighlights() {
    try { CSS.highlights.delete('tts-sentence'); } catch (e) { /* ignore */ }
    try { CSS.highlights.delete('tts-word'); } catch (e) { /* ignore */ }
  }

  /** 把 Range 的每个客户端矩形画到覆盖层上（降级通道） */
  function paintOverlay() {
    overlay.innerHTML = '';
    paintRects(sentRange, 'tts-sentence');
    paintRects(wordRange, 'tts-word');
  }

  function paintRects(range, className) {
    if (!range) return;
    const base = overlay.getBoundingClientRect();
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      const box = document.createElement('div');
      box.className = 'tts-patch ' + className;
      box.style.left = (rect.left - base.left) + 'px';
      box.style.top = (rect.top - base.top) + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      overlay.appendChild(box);
    }
  }

  /* ------------------------------ 播放流程 ------------------------------ */

  /**
   * 开始朗读。
   * @param {number} startAbs 全局字符偏移起点（默认 0 即从头开始）
   */
  function start(startAbs = 0) {
    if (!('speechSynthesis' in window)) { alert('当前浏览器不支持语音合成'); return; }
    stop(false);
    buildModel();
    restoreCfg();

    // 找到第一个结束位置超过起点的句子
    let idx = sentences.findIndex(s => s.end > startAbs);
    if (idx < 0) idx = 0;
    everSpoke = false;        // 新一轮朗读重置引擎可用性探测
    errBeforeStart = 0;
    state = 'playing';
    showBar(true);
    beginFrom(sentences[idx].start);
  }

  /* --------------------- 分块 + 预取缓冲的播放核心 --------------------- */

  const PREFETCH = 2;           // 缓冲深度：当前块之外再排几个块
  const enqueued = new Set();   // 已进入合成队列的块（数字=整块，'eN'=中途切入的半块）
  let everSpoke = false;        // 本次朗读以来是否有任何内容真正开播
  let errBeforeStart = 0;       // 开播成功前的连续失败计数（防无语音环境空转）

  /** 把第 ci 个整块加入合成队列（去重） */
  function ensureChunk(ci) {
    if (state !== 'playing' || ci < 0 || ci >= chunks.length) return;
    if (enqueued.has(ci)) return;
    enqueued.add(ci);
    speakRange(chunks[ci].start, chunks[ci].end, ci);
  }

  /**
   * 从第 si 句所在的块切入；若该句不在块头，先造一个
   * 「句首 -> 块尾」的半块 utterance，后续块照常整块预取。
   */
  function beginFrom(absOffset) {
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    enqueued.clear();
    state = 'playing';
    syncToggleIcon();

    // Chrome 的 cancel() 与紧随的 speak() 同帧调用时会吞掉新语句，
    // 延迟一帧再入队更稳；期间用户按了停止则放弃
    setTimeout(() => {
      if (state !== 'playing') return;
      const ci = chunkIndexAt(absOffset);
      const c = chunks[ci];
      if (c && absOffset > c.start && absOffset < c.end) {
        // 半块：起点不在块头（跳上一句/进度续播场景）
        enqueued.add('e' + ci);
        speakRange(absOffset, c.end, ci);
      } else {
        ensureChunk(ci);
      }
      ensureChunk(ci + 1);
      ensureChunk(ci + PREFETCH);
    }, 30);
  }

  /** 构造 [st,en) 文本的 utterance 并挂接事件（块/半块共用） */
  function speakRange(st, en, ci) {
    const u = new SpeechSynthesisUtterance(plainText.slice(st, en));
    u.rate = cfg.rate;
    u.pitch = 1;
    const voice = pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    else u.lang = 'zh-CN';

    // —— 无边界事件兜底（移动端部分引擎不触发 onboundary）——
    let boundaryFired = false;    // 该 utterance 是否收到过边界事件
    let fallbackTimer = null;     // 估算推进句高亮的定时器
    let spokenMs = 0;             // 累计朗读毫秒数（暂停时不累计）
    let lastTick = 0;

    // 每秒朗读字数估算：中文引擎约 4~5 字/秒，英文约 14 字/秒
    const cps = (() => {
      const text = plainText.slice(st, en);
      let cjk = 0;
      for (const ch of text) if (/[㐀-鶿一-鿿]/.test(ch)) cjk++;
      return (cjk / text.length > 0.3 ? 4.5 : 14) * cfg.rate;
    })();

    function stopFallback() {
      boundaryFired = true;
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    }

    // 开播成功：解除引擎不可用的快速失败判定
    u.onstart = () => {
      if (state === 'stopped') return;
      everSpoke = true;
      errBeforeStart = 0;
      // 立刻点亮本块第一句：即使引擎从不触发边界事件，句子层高亮
      // 也至少从开播这一刻起可见
      if (!boundaryFired) syncSentenceTo(st);
      // 边界兜底：迟迟无 onboundary 时按时间估算推进句层高亮
      lastTick = performance.now();
      fallbackTimer = setInterval(() => {
        const now = performance.now();
        if (boundaryFired || state !== 'playing') { lastTick = now; return; }
        spokenMs += now - lastTick;
        lastTick = now;
        if (spokenMs < 800) return;          // 给边界事件一点时间
        const est = Math.min(st + Math.floor(spokenMs / 1000 * cps), en - 1);
        syncSentenceTo(est);
      }, 200);
    };

    // 边界回调同时驱动句层与词层高亮（charIndex 相对 utterance 起点）
    u.onboundary = e => {
      if (state !== 'playing') return;
      stopFallback();
      if (e.name === 'sentence') { syncSentenceTo(st + e.charIndex); return; }
      if (e.name === 'word' || e.name == null) syncWordTo(st + e.charIndex);
    };

    const finishUp = () => {
      stopFallback();
      enqueued.delete(ci);
      enqueued.delete('e' + ci);
      if (state !== 'playing') return;
      // 读完后确保后续块仍在缓冲里（正常时早已排好）
      ensureChunk(ci + 1);
      ensureChunk(ci + PREFETCH);
      if (ci === chunks.length - 1 && !speechSynthesis.pending) finishAll();
    };
    u.onend = finishUp;
    u.onerror = ev => {
      stopFallback();
      // interrupted/canceled 属于正常停止流程，忽略
      if (ev.error === 'interrupted' || ev.error === 'canceled') return;
      console.warn('朗读出错:', ev.error);
      if (state !== 'playing') return;
      // 尚未播出任何内容就连续失败 → 判定引擎不可用（如系统未装语音），
      // 快速终止而不是让缓冲机制把整本书逐块报错空转一遍
      if (!everSpoke && ++errBeforeStart >= 3) {
        stop();
        alert('语音合成启动失败，请检查系统是否安装了可用的朗读语音。');
        return;
      }
      finishUp();
    };

    speechSynthesis.speak(u);
  }

  /** 全局偏移 -> 定位到所在句子：必要时切换句层高亮与跟随滚动 */
  function syncSentenceTo(abs) {
    let si = 0;
    let lo = 0, hi = sentences.length - 1;
    while (lo <= hi) {                       // 找最后一个 end <= abs 的句
      const mid = (lo + hi) >> 1;
      if (sentences[mid].end <= abs) lo = mid + 1;
      else hi = mid - 1;
    }
    si = Math.min(Math.max(lo, 0), sentences.length - 1);
    if (si === cur) return;
    cur = si;
    const s = sentences[si];
    sentRange = makeRange(s.start, s.end);
    wordRange = null;
    paint();
    followVisible(s.start);
    updateBarInfo();
  }

  /** 词级高亮：从 abs 向后扫到下一个分词边界（空格/标点） */
  function syncWordTo(abs) {
    let si = Math.min(Math.max(cur, 0), sentences.length - 1);
    if (!(abs >= sentences[si].start && abs < sentences[si].end)) {
      // 词跨到了下一句：先补一次句层同步
      syncSentenceTo(abs);
      si = cur;
    }
    const sEnd = sentences[si].end;
    let len = 0;
    while (abs + len < sEnd && len < 24 &&
           !/[\s。．，、！？!?…；;：“”‘’()（）<>《》]/.test(plainText[abs + len] || '')) len++;
    if (len === 0) len = 1;
    wordRange = makeRange(abs, abs + len);
    paint();
  }

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    return voices.find(v => v.voiceURI === cfg.voiceURI) ||
           voices.find(v => /^zh-CN/i.test(v.lang)) ||
           voices.find(v => /^zh/i.test(v.lang)) || null;
  }

  /** 让正在朗读的位置进入可视区（温和滚动，不打断朗读） */
  function followVisible(abs) {
    const r = makeRange(abs, abs + 1);
    if (!r) return;
    const rect = r.getBoundingClientRect();
    const view = els.scroll.getBoundingClientRect();
    const pad = 80;
    if (rect.top < view.top + pad || rect.bottom > view.bottom - pad) {
      r.startContainer.parentElement &&
        r.startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* ------------------------------ 控制接口 ------------------------------ */

  /** 播放/暂停切换（工具栏主按钮） */
  function toggle() {
    if (state === 'stopped') {
      // 默认从第一屏可见文本处开始更贴心：取当前视口顶部对应偏移
      const abs = offsetAtViewportTop();
      start(abs);
      return;
    }
    if (state === 'playing') {
      speechSynthesis.pause();
      state = 'paused';
      showBar(true); syncToggleIcon();
    } else if (state === 'paused') {
      state = 'playing';
      try { speechSynthesis.resume(); } catch (e) { /* ignore */ }
      syncToggleIcon();
      // Windows Chrome 的 pause/resume 兼容性一般：若恢复后发现队列
      // 已失效（不再播放也没有待播），从当前句重建缓冲继续
      setTimeout(() => {
        if (state === 'playing' && !speechSynthesis.speaking && !speechSynthesis.pending) {
          beginFrom(sentences[cur >= 0 ? cur : 0].start);
        }
      }, 100);
    }
  }

  /** 估算视口顶部对应的字符偏移，用于"从当前位置继续朗读" */
  function offsetAtViewportTop() {
    if (!nodeMap.length) { buildModel(); }
    const viewTop = els.scroll.getBoundingClientRect().top;
    for (const m of nodeMap) {
      const r = document.createRange();
      r.selectNodeContents(m.node);
      const rect = r.getBoundingClientRect();
      if (rect.bottom > viewTop + 10) return m.start;
    }
    return 0;
  }

  function stop(showToastStyleUI = true) {
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    state = 'stopped';
    enqueued.clear();
    sentRange = wordRange = null;
    paint();                                  // 清掉两层高亮
    if (showToastStyleUI) { showBar(false); syncToggleIcon(); }
  }

  /** 上/下一句（dir=-1 或 1）：清空旧队列，从目标句所在位置重建缓冲 */
  function step(dir) {
    if (state === 'stopped') return;
    const target = cur + dir;
    if (target < 0 || target >= sentences.length) return;
    beginFrom(sentences[target].start);
  }

  /** 改语速/换声音后的平滑重启：保持原句位置接着播 */
  function softRestart(idx) {
    const si = Math.max(0, idx);
    if (!sentences.length) return;
    beginFrom(sentences[si].start);
  }

  function finishAll() {
    stop();
  }

  /* ------------------------- 标注重建时的自我修复 ------------------------- */

  /**
   * 标注模块重建了某章节的 DOM（<mark> 包裹会替换文本节点），
   * 已有的 nodeMap 失效 —— 若正在朗读则记住位置、重建映射并续播。
   */
  function invalidate() {
    if (state === 'stopped' && cur < 0) return;
    const resumeAt = cur >= 0 ? sentences[cur].start : 0;
    const wasActive = state !== 'stopped';
    enqueued.clear();
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    buildModel();
    let idx = sentences.findIndex(s => s.end > resumeAt);
    if (idx < 0) idx = 0;
    if (wasActive) beginFrom(sentences[idx].start);   // 队列重建后继续缓冲播放
  }

  /* -------------------------------- UI -------------------------------- */

  function showBar(visible) {
    const bar = document.getElementById('tts-bar');
    if (bar) bar.classList.toggle('hidden', !visible);
    syncToggleIcon();
    updateBarInfo();
  }

  function syncToggleIcon() {
    const btn = document.getElementById('btn-tts-toggle');
    if (btn) btn.textContent = state === 'playing' ? '⏸ 暂停' : '▶ 朗读';
  }

  function updateBarInfo() {
    const info = document.getElementById('tts-info');
    if (info && sentences.length && cur >= 0) {
      info.textContent = `第 ${cur + 1} / ${sentences.length} 句`;
    } else if (info) info.textContent = '';
  }

  return {
    init, start, stop, toggle, step, invalidate,
    isActive: () => state !== 'stopped',
  };
})();
