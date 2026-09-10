/**
 * scripts/test-voices.mjs —— tts.js 朗读声音选择逻辑自测（零依赖）
 * -------------------------------------------------------------
 * 运行：node scripts/test-voices.mjs
 *
 * 无头 Chrome 里 speechSynthesis.getVoices() 恒为空，跑不出「手机上系统
 * 只装了很少的几个中文声音」这类场景。这里改用一套最小 DOM + 语音合成
 * 桩件，把 js/tts.js 原样加载进 node:vm 执行，直接考察真实代码路径：
 *   - 声音列表的分组、排序与兜底选择
 *   - 「下拉框显示的声音」是否等于「实际交给合成器的声音」
 *   - 设置恢复后是否回写到控件（此前下拉框不会回写，显示与实际不一致）
 *   - 兜底选中的声音会不会被写进用户设置（跨设备互相覆盖的隐患）
 */
import { readFileSync } from 'fs';
import vm from 'node:vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? ' ✓' : ' ✗'} ${name}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failed++;
};

/* ------------------------------ 最小 DOM ------------------------------ */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this._text = '';
    this.classList = {
      toggle() {}, add() {}, remove() {}, contains: () => false,
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }
  appendChild(c) { this.children.push(c); return c; }
  /** 与浏览器一致：DocumentFragment 会被摊平 */
  replaceChildren(...nodes) {
    this.children = [];
    for (const n of nodes) {
      if (!n) continue;
      if (n.isFragment) this.children.push(...n.children);
      else this.children.push(n);
    }
  }
  /** 与浏览器一致：select.options 会摊平 optgroup */
  get options() {
    const out = [];
    for (const c of this.children) {
      if (c.tagName === 'OPTGROUP') out.push(...c.children.filter(x => x.tagName === 'OPTION'));
      else if (c.tagName === 'OPTION') out.push(c);
    }
    return out;
  }
  get value() {
    // 只有 <select> 的 value 是「选中项」；<option>/<input> 存自己的值
    if (this.tagName !== 'SELECT') return this._value === undefined ? '' : this._value;
    const o = this.options.find(x => x.selected);
    return o ? o.value : '';
  }
  /** 与浏览器一致：select 赋一个不存在的值时选中项为空 */
  set value(v) {
    if (this.tagName !== 'SELECT') { this._value = String(v); return; }
    for (const o of this.options) o.selected = (o.value === v);
  }
  set textContent(t) { this._text = String(t); }
  get textContent() { return this._text; }
}

const mkOption = (value, text) => {
  const o = new El('option');
  o.value = value;
  o.textContent = text;
  return o;
};

const mkVoice = (name, lang, localService) =>
  ({ name, lang, voiceURI: `${name}|${lang}`, localService });

/* --------------------------- 载入被测模块 --------------------------- */

/** 在桩件环境里加载 js/tts.js，返回句柄供断言使用 */
function boot({ voices = [], saved = {}, contentText = '第一句。第二句。第三句。' } = {}) {
  const ids = {};
  const el = id => (ids[id] ||= new El(id === 'tts-voice' ? 'select' : 'div'));

  // 下拉框初始状态 = index.html 里的占位项
  const voiceSel = el('tts-voice');
  voiceSel.appendChild(mkOption('', '正在读取声音…'));

  const queried = {};
  const content = new El('article');
  const textNodes = contentText
    ? [{ nodeValue: contentText, parentElement: { tagName: 'P' } }] : [];

  const document = {
    activeElement: null,
    // index.html 里这些 id 都真实存在，故按需建出同名元素而从不返回 null ——
    // 返回 null 会让 bindSlider 的 `if (!input) return` 直接跳过绑定，
    // 测试就成了「什么都没接上」的假绿
    getElementById: id => el(id),
    querySelector: sel => (queried[sel] ||= new El('button')),
    createElement: tag => new El(tag),
    createDocumentFragment: () => { const f = new El('#fragment'); f.isFragment = true; return f; },
    createTreeWalker: () => {
      let i = -1;
      return {
        get currentNode() { return textNodes[i]; },
        nextNode() { i++; return i < textNodes.length; },
      };
    },
  };

  const store = { ...saved };
  const writes = [];
  const toasts = [];
  const engine = {
    voices,
    spoken: [],
    getVoices() { return this.voices; },
    addEventListener() {},
    speak(u) { this.spoken.push(u); },
    cancel() {}, pause() {}, resume() {},
    speaking: false, pending: false,
  };

  const sandbox = {
    console,
    document,
    Storage: {
      getSetting: (k, d) => Promise.resolve(k in store ? store[k] : d),
      setSetting: (k, v) => { writes.push({ k, v }); store[k] = v; return Promise.resolve(); },
    },
    ui: { toast: m => toasts.push(m) },
    speechSynthesis: engine,
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CSS: { highlights: { set() {}, delete() {} } },
    performance: { now: () => Date.now() },
    alert: m => toasts.push('ALERT:' + m),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Object, Array, Math, String, Number, RegExp, JSON, Set, Date,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};

  const ctx = vm.createContext(sandbox);
  const src = readFileSync(join(root, 'js', 'tts.js'), 'utf8');
  vm.runInContext(src + '\n;globalThis.__TTS = TTS;', ctx, { filename: 'tts.js' });

  sandbox.__TTS.init({
    content,
    scroll: new El('div'),
    main: new El('div'),
  });

  return { TTS: sandbox.__TTS, ids, el, voiceSel, engine, writes, toasts, store, textNodes };
}

/** 让 init 期启动的 cfgReady 与 voiceschanged 之类的微任务跑完 */
const settle = (ms = 0) => new Promise(r => setTimeout(r, ms));

/* ================================ 用例 ================================ */

const VOICES = [
  mkVoice('Microsoft David', 'en-US', true),
  mkVoice('婷婷', 'zh-CN', true),
  mkVoice('Google 普通话（中国大陆）', 'zh_CN', false),
  mkVoice('美佳', 'zh-TW', false),
];

console.log('【1】声音列表的分组与排序');
{
  const t = boot({ voices: VOICES });
  await settle();
  const groups = t.voiceSel.children.filter(c => c.tagName === 'OPTGROUP');
  check('分成「中文」「其他语言」两组',
    groups.length === 2 && groups[0].label === '中文' && groups[1].label === '其他语言',
    groups.map(g => g.label).join(' / '));
  check('中文组在前且收全了 zh / zh_CN / zh-TW 三种写法',
    groups[0] && groups[0].children.length === 3,
    `中文 ${groups[0] ? groups[0].children.length : 0} 项`);
  check('占位项已被真实列表替换', t.voiceSel.options.every(o => o.value !== ''));

  const first = groups[0].children[0];
  check('选项标注了语言与离线/联网',
    /·\s*(离线|联网)/.test(first.textContent), first.textContent);
}

console.log('\n【2】兜底选音色：离线优先、且优先普通话而非 zh-TW');
{
  const t = boot({ voices: VOICES });
  await settle();
  check('未设置偏好时自动选中离线的普通话「婷婷」，而非 zh-TW「美佳」',
    t.voiceSel.value === '婷婷|zh-CN', t.voiceSel.value);
}

console.log('\n【3】只有联网普通话时也能选中它');
{
  const t = boot({ voices: [mkVoice('Microsoft David', 'en-US', true),
    mkVoice('Google 普通话（中国大陆）', 'zh_CN', false)] });
  await settle();
  check('zh_CN 下划线写法可被识别为普通话',
    t.voiceSel.value === 'Google 普通话（中国大陆）|zh_CN', t.voiceSel.value);
}

console.log('\n【4】恢复设置后回写到控件（此前的显示与实际不一致）');
{
  const t = boot({ voices: VOICES, saved: { tts: { rate: 1.5, pitch: 1.2, voiceURI: '美佳|zh-TW' } } });
  await settle();
  check('下拉框回写到用户存的声音', t.voiceSel.value === '美佳|zh-TW', t.voiceSel.value);
  check('语速滑杆回写', Number(t.el('tts-rate').value) === 1.5, t.el('tts-rate').value);
  check('音调滑杆回写', Number(t.el('tts-pitch').value) === 1.2, t.el('tts-pitch').value);
  check('语速/音调读数同步', t.el('tts-rate-val').textContent === '1.5x' &&
    t.el('tts-pitch-val').textContent === '1.2', t.el('tts-rate-val').textContent);
}

console.log('\n【5】实际朗读用的声音 == 下拉框显示的声音');
{
  const t = boot({ voices: VOICES, saved: { tts: { rate: 1, pitch: 1, voiceURI: '美佳|zh-TW' } } });
  await settle();
  t.TTS.start(0);
  await settle(120);                     // 等 beginFrom 的 30ms 延迟把块排进合成队列
  const used = t.engine.spoken[0];
  check('已把内容交给语音合成器', !!used, used ? `“${used.text.slice(0, 6)}…”` : '未收到');
  check('合成器拿到的正是下拉框上显示的那个声音',
    !!used && used.voice && used.voice.voiceURI === t.voiceSel.value,
    used && used.voice ? `${used.voice.voiceURI} vs ${t.voiceSel.value}` : '');
  check('音调被真正传给合成器', !!used && used.pitch === 1, used ? String(used.pitch) : '');
  t.TTS.stop();
}

console.log('\n【6】选中的声音在当前设备不存在时，不把它写进用户设置');
{
  const t = boot({ voices: VOICES, saved: { tts: { rate: 1, voiceURI: '桌面才有的声音|zh-CN' } } });
  await settle();
  check('界面回退到本机可用的普通话', t.voiceSel.value === '婷婷|zh-CN', t.voiceSel.value);
  // 拖动语速滑杆会触发落盘；此时写入的 voiceURI 应保持用户原值，
  // 否则「桌面选好的声音」会被手机上的兜底结果覆盖掉
  t.el('tts-rate').value = '1.25';
  t.el('tts-rate').fire('input');
  await settle(320);                     // 越过 250ms 防抖
  const last = t.writes[t.writes.length - 1];
  check('落盘写的是用户原本的选择，没有被兜底结果覆盖',
    !!last && last.v.voiceURI === '桌面才有的声音|zh-CN',
    last ? JSON.stringify(last.v) : '未落盘');
  check('语速本身正常落盘', !!last && last.v.rate === 1.25, last ? String(last.v.rate) : '');
}

console.log('\n【7】列表为空时不崩、保留占位提示');
{
  const t = boot({ voices: [] });
  await settle(50);
  check('只有占位项且不报错',
    t.voiceSel.options.length === 1 && t.voiceSel.value === '',
    t.voiceSel.options[0] ? t.voiceSel.options[0].textContent : '无');
}

console.log('\n【8】一个中文声音都没有时，朗读中给出提示');
{
  const t = boot({ voices: [mkVoice('Microsoft David', 'en-US', true)] });
  await settle();
  check('未朗读时不打扰用户（书架页不该弹 TTS 提示）', t.toasts.length === 0,
    t.toasts.join(' | '));
  t.TTS.start(0);
  await settle(120);
  const u = t.engine.spoken[0];
  if (u && u.onstart) u.onstart();       // 真实浏览器里由合成器回调，桩件下手动触发
  await settle();
  check('开始朗读后提示去设置里装语音',
    t.toasts.some(m => /未检测到中文语音/.test(m)), t.toasts.join(' | '));
  t.TTS.stop();
}

console.log(failed ? `\n${failed} 项未通过` : '\n音色逻辑全部通过 ✅');
process.exit(failed ? 1 : 0);
