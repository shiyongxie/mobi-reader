/**
 * scripts/mutate-epub.mjs —— 变异测试：证明 test-epub.mjs 不是空断言
 * -------------------------------------------------------------
 * 用法：node scripts/mutate-epub.mjs
 *
 * 逐条破坏 worker/epubParser.js 的一处逻辑（id 改名、锚点映射、清洗、图片
 * 索引……），跑一遍 test-epub.mjs，看它是否变红。**没变红的就是存活变异**，
 * 说明对应断言是空的 —— 测试全绿但什么也没守住。
 *
 * 本项目就是靠它抓到一条真漏洞：早期「anchor 能在 html 里找到」的断言太弱，
 * 两章都有 id="note3" 时照样通过，而真实症状是「点第二章跳回第一章」。
 *
 * 每个变异都会先确认替换目标**恰好命中一次**，命中数不对就报「变异未生效」
 * 而不是当成通过 —— 否则一次静默失败的替换会被误读成「测试守住了」。
 * 无论成败都在 finally 里还原原文件。
 */
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'worker', 'epubParser.js');
const original = readFileSync(target, 'utf8');

const MUTATIONS = [
  ['A 取消跨文档 id 改名',
    "if (usedIds.has(final)) final = secId + '--' + orig;",
    '/*mutated*/'],

  ['B TOC 直接用原始 fragment 当锚点',
    "const anchor = (frag && idMap.get(target + '#' + frag)) || idMap.get(target);",
    'const anchor = frag || idMap.get(target);'],

  ['C 不清洗 on* 事件属性',
    ".replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '')",
    ''],

  ['D 不拦 javascript: 协议',
    "if (/^\\s*(javascript|vbscript)\\s*:/i.test(v)) return ' ' + name + '=\"#\"';",
    ''],

  ['E id 映射丢掉片段（只留文档级）',
    "if (!idMap.has(docPath + '#' + orig)) idMap.set(docPath + '#' + orig, final);",
    ''],

  ['F 图片索引改成 0 基',
    'images.push({ mime, buffer: toArrayBuffer(bytes) });\n        idx = images.length;',
    'images.push({ mime, buffer: toArrayBuffer(bytes) });\n        idx = images.length - 1;'],

  ['G 清洗循环只跑一轮（嵌套绕过）',
    'for (let i = 0; i < 5 && out !== prev; i++) {',
    'for (let i = 0; i < 1; i++) {'],
];

let survivors = 0;
try {
  for (const [label, from, to] of MUTATIONS) {
    const hits = original.split(from).length - 1;
    if (hits !== 1) {
      console.log(` ? ${label} —— 替换目标命中 ${hits} 处（应为 1），变异未生效`);
      survivors++;
      continue;
    }
    writeFileSync(target, original.replace(from, to));
    let out = '';
    try {
      out = execFileSync('node', [join(root, 'scripts', 'test-epub.mjs')],
        { encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    const caught = /项未通过/.test(out);
    const detail = out.split('\n').filter(l => l.startsWith(' ✗')).map(l => l.trim());
    console.log(`${caught ? ' ✓ 被抓住' : ' ✗ 存活!'} ${label}`);
    if (!caught) survivors++;
    else detail.slice(0, 2).forEach(d => console.log(`        ${d}`));
  }
} finally {
  writeFileSync(target, original);       // 无论成败都还原
}

console.log(survivors
  ? `\n${survivors} 个变异存活 —— 对应断言存在漏洞`
  : '\n全部变异均被抓住 ✅');
process.exit(survivors ? 1 : 0);
