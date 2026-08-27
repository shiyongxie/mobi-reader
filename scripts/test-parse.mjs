/**
 * scripts/test-parse.mjs —— 解析器端到端自测（Node 环境）
 * -------------------------------------------------------------
 * 在 Node 的 vm 虚拟上下文中加载 worker/parseWorker.js（无需浏览器），
 * 手工构造一个最小合法的 MOBI 二进制，验证：
 *   书名 / 作者（EXTH）/ 解压正文 / 分章与 TOC / 图片提取 / 封面
 *
 * 运行：node scripts/test-parse.mjs
 */
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- 1. 加载解析脚本到沙盒上下文 ---------- */
const ctx = {
  console,
  TextDecoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  self: { postMessage() {} },   // Worker 消息桩（不经过它）
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const src = readFileSync(join(root, 'worker', 'parseWorker.js'), 'utf8');
vm.runInContext(src, ctx);
const parseMOBI = ctx.parseMOBI;

/* ---------- 2. 构造最小合法 MOBI ---------- */

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function str(s) { return Buffer.from(s, 'utf8'); }

/** PalmDOC 编码器：把任意字节按"字面量块"规则转义（测试够用） */
function encodePalmDoc(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const part = bytes.subarray(i, Math.min(i + 8, bytes.length));
    chunks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat(chunks);
}

const TITLE = '测试书籍';
const AUTHOR = '张三';
// 正文：两个章节 + 一个标题 + 一张图片引用
const HTML =
  `<html><body><h1>第一章</h1><p>春风又绿江南岸。明月何时照我还！</p>` +
  `<img recindex="00001">` +
  `<mbp:pagebreak/>` +
  `<h1>第二章</h1><p>夜来风雨声，花落知多少？</p></body></html>`;
const htmlBytes = str(HTML);

/* --- 记录 0：PalmDOC 头(16B) + MOBI 头 + EXTH --- */
const palmDoc = Buffer.concat([
  u16(1), u16(0), u32(htmlBytes.length), u16(1), u16(4096), u16(0), u16(0),
]);

// EXTH 先构造，好知道它的长度再填 headerLength
const exthBody = Buffer.concat([
  u32(100), u32(8 + str(AUTHOR).length), str(AUTHOR),   // 作者
  u32(201), u32(12), u32(1),                            // 封面 = 第 1 张图片记录
]);
const exth = Buffer.concat([str('EXTH'), u32(12 + exthBody.length), u32(2), exthBody]);

// MOBI 头主体固定长度 232 (0xE8)，各字段先置零再按需写入
const mobiHdrLen = 232;
const mobi = Buffer.alloc(mobiHdrLen);
str('MOBI').copy(mobi, 0);
u32(mobiHdrLen).copy(mobi, 4);
u32(2).copy(mobi, 8);            // type=Book
u32(65001).copy(mobi, 12);       // UTF-8
// 84=0x54 fullname 偏移、88=0x58 全名长度 —— 值相对记录 0 起点
u16(65001 >> 16).copy(mobi, 68); // 占位无意义，避免未写区域的歧义
mobi.writeUInt32BE(0, 68);
// 记录0 布局：16(palmDoc)+232(mobi头)+exth+title；fullname 放在最后
const fnOffValue = 16 + mobiHdrLen + exth.length;
Buffer.concat([u32(fnOffValue)]).copy(mobi, 0x54 - 16);
// 全名长度是"字节数"（UTF-8），不是字符数
Buffer.concat([u32(Buffer.byteLength(TITLE, 'utf8'))]).copy(mobi, 0x58 - 16);
u32(6).copy(mobi, 24);           // version=6
Buffer.concat([u32(2)]).copy(mobi, 108 - 16);   // 0x6C firstImageIndex（指向假 JPEG 记录）
Buffer.concat([u32(0x40)]).copy(mobi, 128 - 16); // 0x80 有 EXTH

const record0 = Buffer.concat([palmDoc, mobi, exth, str(TITLE)]);

/* --- 记录 1：压缩后的正文文本；记录 2：假 JPEG --- */
const fakeJpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(20, 0xab),
]);
const record1 = encodePalmDoc(htmlBytes);
const records = [record0, record1, fakeJpeg];

/* --- PDB 头 + 记录表 + 数据 --- */
const numRecords = records.length;
const headerSize = 78 + numRecords * 8;
const offsets = [];
let cursor = headerSize;
for (const r of records) { offsets.push(cursor); cursor += r.length; }

const pdb = Buffer.alloc(headerSize);
u16(numRecords).copy(pdb, 76);
records.forEach((r, i) => {
  u32(offsets[i]).copy(pdb, 78 + i * 8);
  pdb.set([i + 1], 78 + i * 8 + 7); // uniqueId 低字节随意
});
const finalBuffer = Buffer.concat([pdb, ...records]);

/* ---------- 3. 断言 ---------- */

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}

console.log('开始解析器端到端测试…');
try {
  // 进度钩子走通主线程降级路径
  globalThis.__progressHook = null;
  ctx.__progressHook = msg => void msg;
  const result = parseMOBI.call(null, finalBuffer.buffer.slice(
    finalBuffer.byteOffset, finalBuffer.byteOffset + finalBuffer.length), 'test.mobi');

  check('书名来自 fullname', result.title === TITLE);
  check('作者来自 EXTH(type 100)', result.author === AUTHOR);
  check('正文解压正确（含原文句子）',
    result.sections[0].plain.includes('春风又绿江南岸'));
  check('按 pagebreak 切成两章', result.sections.length === 2);
  check('TOC 含两个章节标题',
    result.toc.length >= 2 && result.toc[0].title === '第一章');
  check('recindex 转换为 data-recindex',
    /data-recindex="1"/.test(result.sections[0].html));
  check('提取到 1 张图片', result.images.length === 1 &&
    result.images[0].mime === 'image/jpeg');
  check('封面 base64 存在', !!result.cover && !!result.cover.base64);
  check('script 标签被清理',
    !/<script/i.test(result.sections[0].html));
} catch (err) {
  failed++;
  console.error('  ✗ 解析过程抛出异常:', err.message);
  console.error(err.stack.split('\n').slice(0, 6).join('\n'));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
