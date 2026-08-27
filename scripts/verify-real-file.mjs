/**
 * scripts/verify-real-file.mjs —— 用真实 .mobi 文件做端到端验证
 * 用法：node scripts/verify-real-file.mob.js <文件路径>（省略则自动查找目录下第一个 .mobi）
 * 覆盖：PDB 头识别 → PalmDOC 解压 → 元数据 → 分章 → TOC → 图片提取 → HTML 健全性
 */
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
let mobiPath = arg;
if (!mobiPath) {
  // 自动找目录下第一个 .mobi
  const { readdirSync } = await import('fs');
  for (const f of readdirSync(root)) {
    if (/\.mobi$/i.test(f)) { mobiPath = join(root, f); break; }
  }
}
if (!mobiPath) { console.error('未找到 .mobi 文件'); process.exit(1); }

/* ---------- 沙盒加载 worker/parseWorker.js ---------- */
const ctx = {
  console,
  TextDecoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  self: { postMessage() {} },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'worker', 'parseWorker.js'), 'utf8'), ctx);

/* ---------- 同 Worker 一样调用 ---------- */
const fileName = basename(mobiPath);
const buffer = readFileSync(mobiPath);
const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

const progress = [];
ctx.__progressHook = msg => progress.push(msg);
console.log(`文件：${fileName}（${(buffer.length / 1024).toFixed(1)} KB）\n`);

const t0 = Date.now();
let result;
try {
  result = ctx.parseMOBI(ab, fileName.replace(/\.[^.]+$/, ''));
} catch (err) {
  console.error('✗ 解析失败：', err.message);
  process.exit(1);
}
console.log(`解析耗时 ${(Date.now() - t0)} ms；进度事件 ${progress.length} 个（最后: "${progress.at(-1)?.stage}" ${progress.at(-1)?.pct}%）\n`);

/* ---------- 报告 ---------- */
const plainLen = result.sections.reduce((s, x) => s + x.plain.length, 0);
console.log('== 基本信息 ==');
console.log(`书名      : ${result.title}`);
console.log(`作者      : ${result.author || '(EXTH 未提供)'}`);
console.log(`格式      : ${result.meta.format}, 文本记录 ${result.meta.textRecords} 条`);
console.log(`章节数    : ${result.sections.length}`);
console.log(`正文规模  : 共 ${plainLen.toLocaleString()} 字`);
console.log(`图片      : 提取到 ${result.images.length} 张 [${[...new Set(result.images.map(i => i.mime))].join(', ') || '-'}]`);
console.log(`封面      : ${result.cover ? `${result.cover.mime}，base64 ${(result.cover.base64.length / 1024).toFixed(1)} KB` : '无'}`);
console.log(`TOC 条目  : ${result.toc.length}`);

console.log('\n== 目录（前 12 条） ==');
for (const item of result.toc.slice(0, 12)) {
  console.log(`   ${'　'.repeat((item.level - 1) * 2)}[${item.anchor}] L${item.level} ${item.title}`);
}
if (result.toc.length > 12) console.log(`   …（共 ${result.toc.length} 条）`);

console.log('\n== 第一章开头预览（纯文本 300 字） ==');
console.log(result.sections[0].plain.slice(0, 300));

/* ---------- 健全性检查 ---------- */
let fail = 0;
const check = (name, ok) => { console.error(`${ok ? ' ✓' : ' ✗'} ${name}`); if (!ok) fail++; };
console.log('\n== 断言 ==');
check('存在至少 1 个章节', result.sections.length >= 1);
check('正文非空（>1000 字）', plainLen > 1000);
check('每章有 id 与 html 包裹',
  result.sections.every(s => /^sec-\d+$/.test(s.id) && s.html.includes(`id="${s.id}"`)));
check('TOC 锚点都能在章节 HTML 中找到',
  result.toc.every(t => result.sections.some(s => s.html.includes(`id="${t.anchor}"`))));
check('无 script/on* 危险内容',
  !/<script|on\w+=/i.test(result.sections.map(s => s.html).join('')));
check('img 标签都带 data-recindex 且可映射图片',
  (() => {
    const html = result.sections.map(s => s.html).join('');
    const recs = [...html.matchAll(/data-recindex="(\d+)"/g)].map(m => +m[1]);
    return recs.every(n => n >= 1 && n <= result.images.length);
  })());
check('无乱码迹象（抽取文本中文比例正常）',
  (() => {
    const sample = result.sections[Math.floor(result.sections.length / 2)].plain;
    const cjk = (sample.match(/[一-鿿]/g) || []).length;
    return sample.length === 0 || cjk / sample.length > 0.2;
  })());

console.log(fail ? `\n${fail} 项检查未通过` : '\n全部检查通过 ✅');
process.exit(fail ? 1 : 0);
