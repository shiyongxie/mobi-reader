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
    pitch: 1,
    voiceURI: '',              // 用户选择的声音
  };

  const MAX_VOICE_RETRY = 10;    // 音色列表为空时的重试次数（300ms 一次 ≈ 3 秒）

  let voiceSel = null;           // #tts-voice 下拉框（模块级：刷新入口不止一处）
  let cfgReady = null;           // 设置恢复完成的 Promise（init 期启动）
  let cfgLoaded = false;         // 设置是否已从 IndexedDB 恢复
  let voiceRetryTimer = null;    // 有界重试定时器
  let voiceRetryLeft = MAX_VOICE_RETRY;
  let warnedNoZh = false;        // 「无中文语音」提示每次会话只弹一次

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

    // 设置改在 init 期恢复，不再留在 start() 里 —— 见 restoreCfg 注释：
    // 恢复晚于 refreshVoices 会让「下拉框显示的声音 ≠ 实际朗读的声音」
    cfgReady = restoreCfg().then(() => { cfgLoaded = true; });
  }

  /** $(id) + click 快捷方式 */
  function $(sel, onClick) {
    const el = document.querySelector(sel);
    if (el && onClick) el.addEventListener('click', onClick);
    return el;
  }

  /** 数值显示：去掉多余小数位（1.00 → 1，1.25 → 1.25） */
  const fmtNum = v => String(Math.round(v * 100) / 100);

  /**
   * 数值滑杆通用绑定：cfg 与读数即时更新，落盘与重启则防抖。
   * 拖一次滑杆会连发几十个 input，若每个都写 IndexedDB 并重建播放队列，
   * 手机会不停 cancel/speak，朗读明显发颤。
   */
  function bindSlider(id, valId, key, suffix) {
    const input = document.getElementById(id);
    const out = document.getElementById(valId);
    if (!input) return;
    let settle = null;
    const commit = () => {
      clearTimeout(settle);
      settle = null;
      saveCfg();
      if (state === 'playing') softRestart(cur);   // 即时生效：保持进度位置
    };
    input.addEventListener('input', () => {
      cfg[key] = Number(input.value);
      if (out) out.textContent = fmtNum(cfg[key]) + suffix;
      clearTimeout(settle);
      settle = setTimeout(commit, 250);
    });
    input.addEventListener('change', commit);      // 松手立即生效，不等满防抖窗口
  }

  function bindSliders() {
    bindSlider('tts-rate', 'tts-rate-val', 'rate', 'x');
    bindSlider('tts-pitch', 'tts-pitch-val', 'pitch', '');

    // —— 声音下拉框（异步填充：各平台就绪时机差异很大）——
    voiceSel = document.getElementById('tts-voice');
    if (voiceSel && 'speechSynthesis' in window) {
      refreshVoices();
      // 必须用包装函数：直接传 refreshVoices 会把事件对象当成 force 参数
      if (typeof speechSynthesis.addEventListener === 'function') {
        speechSynthesis.addEventListener('voiceschanged', () => refreshVoices());
      } else if ('onvoiceschanged' in speechSynthesis) {
        speechSynthesis.onvoiceschanged = () => refreshVoices();   // 老 WebView 只有属性形式
      }
      voiceSel.addEventListener('change', () => {
        const uri = voiceSel.value;
        if (!uri) return;                       // 占位项，不是真实选择
        cfg.voiceURI = uri;
        saveCfg();
        if (state === 'playing') softRestart(cur);
      });
      voiceSel.addEventListener('blur', () => {
        if (voicePending) { voicePending = false; refreshVoices(true); }
      });
    }

    // —— 设置面板「朗读声音」组：手动刷新 + 安装引导 ——
    const refreshBtn = document.getElementById('btn-tts-refresh-voice');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        voiceRetryLeft = MAX_VOICE_RETRY;      // 手动刷新重置重试预算
        refreshVoices(true);
        ui.toast(speechSynthesis.getVoices().length
          ? '声音列表已刷新' : '仍未读到声音，请确认系统已安装语音包', 3000);
      });
    }
    // 打开设置面板时顺带刷一次：用户多半是刚从系统设置装完语音包回来
    const settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', () => refreshVoices());
    const helpBtn = document.getElementById('btn-tts-voice-help');
    const helpBox = document.getElementById('tts-voice-help');
    if (helpBtn && helpBox) {
      helpBtn.addEventListener('click', () => helpBox.classList.toggle('hidden'));
    }
  }

  /* ------------------------------ 设置存取 ------------------------------ */

  // 注意：setSetting 是整体 put、没有 patch 合并 —— 新增字段必须同时改
  // 这里的写入对象和 restoreCfg 的恢复分支，否则会被静默抹掉
  function saveCfg() {
    Storage.setSetting('tts', {
      rate: cfg.rate, pitch: cfg.pitch, voiceURI: cfg.voiceURI,
    }).catch(() => {});
  }

  /**
   * 恢复朗读偏好并回写控件。必须在 init() 期跑完，不能留在 start() 里 ——
   * 否则 start() 里那次异步读取会让首块先用默认语速/声音播出去。
   */
  function restoreCfg() {
    return Storage.getSetting('tts', {}).then(saved => {
      if (saved) {
        if (saved.rate) cfg.rate = saved.rate;
        if (saved.pitch) cfg.pitch = saved.pitch;
        if (saved.voiceURI) cfg.voiceURI = saved.voiceURI;
      }
      syncCfgUI();
      refreshVoices();     // 让下拉框选中项与恢复出来的 cfg 对齐
    }).catch(() => {});
  }

  /** 把 cfg 回写到控制条与设置面板的控件（下拉框由 refreshVoices 同步） */
  function syncCfgUI() {
    const set = (id, val, outId, text) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
      const out = outId && document.getElementById(outId);
      if (out) out.textContent = text;
    };
    set('tts-rate', cfg.rate, 'tts-rate-val', fmtNum(cfg.rate) + 'x');
    set('tts-pitch', cfg.pitch, 'tts-pitch-val', fmtNum(cfg.pitch));
  }

  /* ------------------------------ 声音列表 ------------------------------ */

  /** 中文音色判定：部分国产引擎报 zh_CN 而非 zh-CN，故不写死连字符 */
  const isZhVoice = v => /^zh([-_]|$)/i.test(v.lang || '');
  /** 普通话（简）判定：zh-CN / zh_CN / zh-Hans-CN / zh-Hans；排除 zh-TW、zh-HK */
  const isZhCNVoice = v => /^zh([-_](cn|hans))/i.test(v.lang || '') ||
    /^zh$/i.test(v.lang || '');
  const byVoiceName = (a, b) => (a.name || '').localeCompare(b.name || '');

  let lastVoiceSig = '';     // 声音列表签名：内容没变就不重建 DOM
  let voicePending = false;  // 焦点在原生选择器上时挂起的刷新

  /**
   * 实际要用的音色：用户选择优先，否则按「离线优先的普通话」兜底。
   * 下拉框显示的值与 speakRange 实际使用的值都取自这里，
   * 「看到的声音」与「读出来的声音」因此始终是同一个。
   *
   * 兜底刻意让 localService 优先：手机上网络合成的音色在语言包缺失时
   * 可能静默回退成默认声音（听着像「选了中文却读英文」），离线音色更稳。
   * 也用 isZhCNVoice 精确匹配，避免拿 zh-TW / zh-HK（粤语）去读简体正文。
   */
  function effectiveVoice() {
    const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];
    if (!voices.length) return null;
    return voices.find(v => v.voiceURI === cfg.voiceURI) ||
      voices.find(v => isZhCNVoice(v) && v.localService) ||
      voices.find(isZhCNVoice) ||
      voices.find(v => isZhVoice(v) && v.localService) ||
      voices.find(isZhVoice) || null;
  }

  /**
   * 填充声音列表。触发时机（全部幂等，靠签名去重）：
   *   1) init 立即          —— 桌面浏览器此时通常已有值
   *   2) voiceschanged      —— Chrome / Android 的异步就绪通知
   *   3) 首次 u.onstart     —— iOS 在用户手势之前 getVoices() 恒为空，
   *                            且 voiceschanged 不触发，只能靠开播这一手补上
   *   4) 有界重试           —— 部分安卓引擎延迟就绪又不发事件
   *   5) 手动「刷新声音列表」/ 打开设置面板
   *
   * 程序化赋 value 不派发 change 事件，所以朗读过程中刷新
   * 不会误触发 softRestart 打断播放。
   */
  function refreshVoices(force) {
    if (!voiceSel || !('speechSynthesis' in window)) return;
    // 原生选择器开着时重建 option，会把用户正在点的那一项换掉
    if (!force && document.activeElement === voiceSel) { voicePending = true; return; }

    const voices = speechSynthesis.getVoices();
    if (!voices.length) {
      scheduleVoiceRetry();
      if (voiceRetryLeft <= 0) setVoicePlaceholder('（未检测到系统语音）');
      return;
    }
    stopVoiceRetry();

    const zh = voices.filter(isZhVoice).sort(byVoiceName);
    const other = voices.filter(v => !isZhVoice(v)).sort(byVoiceName);

    // Chrome 会连发多次内容相同的 voiceschanged；不比对签名就会反复重建
    // DOM，在安卓上还会顺手关掉用户正打开的原生选择列表
    const sig = zh.concat(other).map(v => v.voiceURI).join('|');
    if (sig !== lastVoiceSig) {
      lastVoiceSig = sig;
      const frag = document.createDocumentFragment();
      if (zh.length) frag.appendChild(buildVoiceGroup('中文', zh));
      if (other.length) frag.appendChild(buildVoiceGroup('其他语言', other));
      voiceSel.replaceChildren(frag);   // 一次替换，不留「零 option」的中间帧
    }

    // 选中项只认 effectiveVoice()，绝不把兜底结果写回 cfg.voiceURI ——
    // 否则桌面选好的声音一到手机就会被改写成手机的第一个音色，跨设备互相覆盖
    const v = effectiveVoice();
    voiceSel.value = v ? v.voiceURI : '';
    updateVoiceStat(voices.length, zh.length);
  }

  /** 列表始终为空时，把占位项从「读取中」改成明确结论 */
  function setVoicePlaceholder(text) {
    if (!voiceSel) return;
    const opt = voiceSel.options[0];
    if (voiceSel.options.length === 1 && opt && opt.value === '') {
      opt.textContent = text;
    }
  }

  function buildVoiceGroup(label, list) {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const v of list) {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      // 标出离线/联网：系统内置语音响应更稳，在线语音音质更好但依赖网络
      opt.textContent = `${v.name} (${v.lang} · ${v.localService ? '离线' : '联网'})`;
      group.appendChild(opt);
    }
    return group;
  }

  /** 设置面板里的统计文字；一个中文声音都没有时额外提示一次 */
  function updateVoiceStat(total, zhCount) {
    const stat = document.getElementById('tts-voice-stat');
    if (stat) {
      stat.textContent = zhCount
        ? `检测到 ${total} 个声音，其中中文 ${zhCount} 个`
        : `检测到 ${total} 个声音，但没有中文语音`;
    }
    // 只在朗读进行中提示：书架页刚加载就弹 TTS 的提示纯属噪音，
    // 而用户点下朗读时正是他真正需要知道这件事的时刻
    if (!zhCount && !warnedNoZh && state !== 'stopped') {
      warnedNoZh = true;
      try { ui.toast('未检测到中文语音，可在「⚙ 设置 → 朗读声音」查看如何安装', 3500); }
      catch (e) { /* ui 未就绪时忽略 */ }
    }
  }

  function scheduleVoiceRetry() {
    if (voiceRetryTimer || voiceRetryLeft <= 0) return;
    voiceRetryLeft--;
    voiceRetryTimer = setTimeout(() => {
      voiceRetryTimer = null;
      refreshVoices();
    }, 300);
  }

  function stopVoiceRetry() {
    if (voiceRetryTimer) { clearTimeout(voiceRetryTimer); voiceRetryTimer = null; }
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

    // 找到第一个结束位置超过起点的句子
    let idx = sentences.findIndex(s => s.end > startAbs);
    if (idx < 0) idx = 0;
    everSpoke = false;        // 新一轮朗读重置引擎可用性探测
    errBeforeStart = 0;
    state = 'playing';
    showBar(true);            // UI 立即可见，不等设置读完

    // 设置已在 init() 期恢复，快路径下这里无需等待。冷启动万一还没读完就补一次
    // then —— 仍落在 iOS 的用户激活窗口内（beginFrom 本身另有 30ms 延迟）
    const go = () => { if (state === 'playing') beginFrom(sentences[idx].start); };
    if (cfgLoaded || !cfgReady) go();
    else cfgReady.then(go);
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
    u.pitch = cfg.pitch;
    const voice = effectiveVoice();
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
      const firstEver = !everSpoke;   // 先取快照：下面就要把它置真
      everSpoke = true;
      errBeforeStart = 0;
      // iOS 的 getVoices() 在首次用户手势之前恒为空、且 voiceschanged 不触发，
      // 只能靠开播这一手补上（内部有签名去重，重复调用几乎零成本）
      if (firstEver) refreshVoices();
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

      // 分诊：这几类都不是「系统没装语音」，一律报成同一句话会把用户
      // 引到完全错误的方向（跑去系统设置里翻语音包，越翻越少）
      if (ev.error === 'not-allowed' || ev.error === 'audio-busy') {
        stop();
        ui.toast(ev.error === 'not-allowed'
          ? '请先在页面上点一下，再开始朗读' : '音频被其他应用占用，请稍后再试', 3500);
        return;
      }
      // 所选声音的语言包不可用（Chrome Android 常见）：清掉用户选择，
      // 让 effectiveVoice() 的兜底链接管。cfg.voiceURI 置空后本分支不再命中，
      // 天然只触发一次，不会形成重试环
      if (ev.error === 'voice-unavailable' || ev.error === 'language-unavailable') {
        if (cfg.voiceURI) {
          cfg.voiceURI = '';
          ui.toast('所选声音不可用，已切回系统默认中文声音', 3000);
        }
        finishUp();
        return;
      }

      // 尚未播出任何内容就连续失败 → 判定引擎不可用（如系统未装语音），
      // 快速终止而不是让缓冲机制把整本书逐块报错空转一遍
      if (!everSpoke && ++errBeforeStart >= 3) {
        stop();
        ui.toast('语音合成启动失败，请检查系统是否安装了可用的朗读语音。', 4000);
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

  /** 改语速/音调/换声音后的平滑重启：保持原句位置接着播 */
  function softRestart(idx) {
    // idx < 0 表示首块尚未 onstart、cur 还没落定 —— 此时若照旧 clamp 到 0，
    // 会把正在开播的书整个弹回第一句
    if (!sentences.length || idx < 0) return;
    beginFrom(sentences[Math.min(idx, sentences.length - 1)].start);
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
