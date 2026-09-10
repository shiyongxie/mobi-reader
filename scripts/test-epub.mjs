/**
 * scripts/test-epub.mjs —— EPUB 解析器自测（零依赖）
 * -------------------------------------------------------------
 * 运行：node scripts/test-epub.mjs
 *
 * 夹具（两本内存里的最小 EPUB：EPUB3 + nav / EPUB2 + NCX，埋着真实书里那些
 * 会静默出错的脏东西）在 lib/epub-fixture.mjs，与浏览器 e2e 共用一份。
 * 这里把 worker/epubParser.js 原样加载进 node:vm 执行，直接考察真实代码路径。
 *
 * 重点守护的不是「能不能解析」，而是几条**出错时不会报错、只会悄悄画错**的
 * 不变量 —— 它们一旦破了，用户看到的是「高亮跑到别的章节去了」：
 *   - sections[i].id 严格等于 sec-i（annotations.js 靠它直接索引数组）
 *   - 每个 toc[].anchor 都能在某节 html 里找到同名 id（否则目录点了没反应）
 *   - id 跨文档重名被确定性改名（否则 getElementById 跳错位置）
 *   - 同一 buffer 解析两次结果完全一致（标注存的是章节内字符偏移）
 */
import { readFileSync } from 'fs';
import vm from 'node:vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fixtureEpub3, fixtureEpub2, PNG } from './lib/epub-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? ' ✓' : ' ✗'} ${name}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failed++;
};

/* 夹具（含埋进去的脏内容）在 lib/epub-fixture.mjs 里，与浏览器 e2e 共用一份 */
const EPUB3_BIN = fixtureEpub3();
const EPUB2 = fixtureEpub2();

/* ============================ 载入被测模块 ============================ */

const progressLog = [];
const sandbox = {
  console, TextDecoder, TextEncoder, Blob, Response, DecompressionStream, btoa,
  post: msg => progressLog.push(msg),
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'worker', 'epubParser.js'), 'utf8'), ctx,
  { filename: 'epubParser.js' });

const parseEPUB = sandbox.parseEPUB;
check('解析器已导出 parseEPUB', typeof parseEPUB === 'function');

const ab = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/* ================================ 断言 ================================ */

console.log('\n【1】EPUB3 + nav：基本结构与硬契约');
const r1 = await parseEPUB(ab(EPUB3_BIN), '测试用书.epub');
{
  check('书名来自 dc:title', r1.title === '测试用书', r1.title);
  check('作者来自 dc:creator', r1.author === '某作者', r1.author);
  check('识别为 EPUB3', r1.meta.format === 'EPUB3', r1.meta.format);
  check('两篇正文 → 两节', r1.sections.length === 2, `${r1.sections.length} 节`);

  // annotations.js 用 /^sec-(\d+)$/ 抽下标后**直接索引 book.sections[idx]**，
  // 一旦不连续就是静默错位：高亮会画到别的章节去
  check('sections[i].id 严格等于 sec-i（0 基连续）',
    r1.sections.every((s, i) => s.id === 'sec-' + i),
    r1.sections.map(s => s.id).join(','));

  check('每节 html 自带 section.mobi-section 包裹',
    r1.sections.every(s =>
      s.html.startsWith(`<section class="mobi-section" id="${s.id}">`) &&
      s.html.endsWith('</section>')));

  check('plain 非空且含正文', r1.sections.every(s => s.plain.length > 0),
    `第一节 ${r1.sections[0].plain.length} 字`);
}

console.log('\n【2】目录：每个 anchor 都必须能真正解析到');
{
  const allHtml = r1.sections.map(s => s.html).join('');
  const dangling = r1.toc.filter(t => !allHtml.includes(`id="${t.anchor}"`));
  // 这是最容易静默失败的一条：reader.js 的 jumpToAnchor 找不到 id 时
  // 什么都不做、也不报错，用户只看到「点了目录没反应」
  check('每个 toc[].anchor 都能在某节 html 里找到同名 id',
    r1.toc.length > 0 && dangling.length === 0,
    dangling.length ? `悬空: ${dangling.map(t => t.anchor).join(',')}` : `${r1.toc.length} 条`);

  // 上面那条只保证「全书某处找得到」，还不够：若两章的锚点都叫 note3，
  // getElementById 一样找得到、一样不报错 —— 只是跳到第一章去了。
  // 所以还要断言 id 全局唯一，且目录项落在它该在的那一节。
  const idsAll = [...allHtml.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dupIds = idsAll.filter((x, i) => idsAll.indexOf(x) !== i);
  check('全书 id 全局唯一（getElementById 才无歧义）',
    dupIds.length === 0, dupIds.join(','));

  const ch2Entry = r1.toc.find(t => /第二章/.test(t.title));
  check('指向第二章的目录项落在第二节内（而不是跳回第一章）',
    !!ch2Entry && r1.sections[1].html.includes(`id="${ch2Entry.anchor}"`) &&
    !r1.sections[0].html.includes(`id="${ch2Entry.anchor}"`),
    ch2Entry ? ch2Entry.anchor : '找不到该目录项');
  check('目录标题正确', r1.toc[0] && r1.toc[0].title === '第一章',
    r1.toc[0] ? r1.toc[0].title : '无');
  check('嵌套层级被保留（出现 level≥2）',
    r1.toc.some(t => t.level >= 2), r1.toc.map(t => t.level).join(','));
}

console.log('\n【3】跨文档重名 id 的确定性改名');
{
  // ch1 与 ch2 都用了 id="note3"。先出现的保留原名，后出现的加 sec-1-- 前缀，
  // 否则 document.getElementById 会跳到第一章去
  check('首篇的 id 保持原样', r1.sections[0].html.includes('id="note3"'));
  check('后出现的一篇被加上 sec-1-- 前缀',
    r1.sections[1].html.includes('id="sec-1--note3"'));
  const dups = [...r1.sections[0].html.matchAll(/\sid="([^"]*)"/g)]
    .map(m => m[1]).filter(x => /dup/.test(x));
  check('同文档内重复 id 被拆成两个不同的 id（改名形状不限，唯一即达标）',
    dups.length === 2 && new Set(dups).size === 2, dups.join(','));
  check('跨文档锚点被改写指向改名后的 id',
    r1.sections[0].html.includes('href="#sec-1--note3"'));
  check('同文档锚点仍指向本节',
    r1.sections[0].html.includes('href="#note3"'));
}

console.log('\n【4】链接改写：死链要摘掉，外链要加 rel');
{
  const h = r1.sections[0].html;
  check('指向不存在文档的链接被摘成无动作', h.includes('href="#"'));
  check('文字本身保留（只是不再可点）', h.includes('指向不存在的文档'));
  check('外链保留且带 target/rel',
    /href="https:\/\/example\.com\/x"[^>]*target="_blank"/.test(h) &&
    /rel="noopener noreferrer"/.test(h));
}

console.log('\n【5】清洗：EPUB 是不可信输入');
{
  const h = r1.sections.map(s => s.html).join('');
  check('无 <script', !/<script/i.test(h));
  check('无 on* 事件属性', !/\son[a-z]+\s*=/i.test(h));
  check('无 javascript: 协议', !/javascript\s*:/i.test(h));
  check('无 <iframe / <base / <style', !/<(iframe|base|style)\b/i.test(h));
  check('style 属性里的远程 url() 被丢弃', !/url\s*\(/i.test(h));
  // 可见文本不该因为清洗而消失
  check('危险链接的文字仍在', h.includes('危险链接'));
}

console.log('\n【6】图片管线');
{
  check('图片被抽成 data-recindex', /data-recindex="1"/.test(r1.sections[0].html));
  check('img 上不再有 src（走 Blob URL 惰性管线）',
    !/<img[^>]*\ssrc=/i.test(r1.sections[0].html.replace(/<img[^>]*data-recindex[^>]*>/g, '')));
  // 同一张图被 <img> 和 <svg><image> 各引用一次，去重后只该占一个槽位
  check('同一张图跨引用去重（只占 1 个槽位）', r1.images.length === 1,
    `${r1.images.length} 张`);
  check('mime 由魔数嗅探得出', r1.images[0] && r1.images[0].mime === 'image/png',
    r1.images[0] ? r1.images[0].mime : '无');
  // 注意：不能用 instanceof —— vm 沙盒是另一个 realm，两边 ArrayBuffer 构造器不同，
  // 跨 realm 只能靠 Object.prototype.toString。真正要验的是字节完整，
  // 因为 reader.js 会 new Blob([im.buffer], {type: im.mime}) 直接交给 <img>
  const imgBuf = r1.images[0] && r1.images[0].buffer;
  check('图片 buffer 字节完整且可独立传输',
    Object.prototype.toString.call(imgBuf) === '[object ArrayBuffer]' &&
    imgBuf.byteLength === PNG.length &&
    Buffer.from(new Uint8Array(imgBuf)).equals(PNG),
    imgBuf ? `${imgBuf.byteLength} 字节` : '无');

  const idx = [...r1.sections[0].html.matchAll(/data-recindex="(\d+)"/g)].map(m => Number(m[1]));
  // reader.js 用 Number(...) - 1 直接索引 images[]，越界会渲染出空白图
  check('所有 recindex 都落在 1..images.length 内',
    idx.every(n => n >= 1 && n <= r1.images.length), idx.join(','));
}

console.log('\n【7】确定性（守护标注偏移）');
{
  const r2 = await parseEPUB(ab(EPUB3_BIN), '测试用书.epub');
  // 标注存的是「章节 + 章节内字符偏移」，解析结果一变，全书标注就集体错位
  check('同一 buffer 解析两次，sections 完全一致',
    JSON.stringify(r1.sections) === JSON.stringify(r2.sections));
  check('两次的 TOC 也一致',
    JSON.stringify(r1.toc) === JSON.stringify(r2.toc));
}

console.log('\n【8】EPUB2 + NCX 分支');
{
  const r3 = await parseEPUB(ab(EPUB2), '旧格式书.epub');
  check('识别为 EPUB2', r3.meta.format === 'EPUB2', r3.meta.format);
  check('书名/作者正确', r3.title === '旧格式书' && r3.author === '老作者',
    `${r3.title} / ${r3.author}`);
  check('NCX 目录被解析出来', r3.toc.length === 2, `${r3.toc.length} 条`);
  const all = r3.sections.map(s => s.html).join('');
  check('NCX 的每个 anchor 也能解析到',
    r3.toc.every(t => all.includes(`id="${t.anchor}"`)),
    r3.toc.map(t => t.anchor).join(','));
  check('封面按 <meta name="cover"> 取到',
    !!r3.cover && r3.cover.mime === 'image/png', r3.cover ? r3.cover.mime : '无');
  check('封面 base64 不带 data: 前缀',
    !!r3.cover && !/^data:/.test(r3.cover.base64) && r3.cover.base64.length > 0);
}

console.log('\n【9】异常输入给出明确报错，而不是静默产出空书');
{
  const notZip = Buffer.from('这不是一个 ZIP 文件，只是一段中文文本。', 'utf8');
  let msg = '';
  try { await parseEPUB(ab(notZip), 'x.epub'); } catch (e) { msg = e.message; }
  check('非 ZIP 输入抛出中文错误', /EPUB|ZIP/.test(msg), msg || '（没有抛错！）');
}

console.log('\n【10】进度回调');
{
  check('解析过程中上报了进度',
    progressLog.length > 0 && progressLog.every(m => m.type === 'progress'),
    `${progressLog.length} 次`);
  check('进度百分比在 0–100 之间',
    progressLog.every(m => m.pct >= 0 && m.pct <= 100));
}

console.log('\n【11】格式分发（parseWorker.js 的统一入口）');
{
  /* 复刻 Worker 的加载方式：先跑 parseWorker.js，它的顶层 importScripts
     自己把 epubParser.js 拉进来 —— 这条路径与主线程降级（先 <script> 注入
     epubParser.js）不同，两条都得能跑，所以单独验一次。 */
  const sbox = {
    console, TextDecoder, TextEncoder, DataView, Uint8Array, Promise, Math,
    JSON, Object, Array, String, Number, RegExp, Set, Map, Date, Error,
    Blob, Response, DecompressionStream, btoa,   // EPUB 解压链路要用
    postMessage() {},
  };
  sbox.self = sbox;
  sbox.globalThis = sbox;
  const sctx = vm.createContext(sbox);
  sbox.importScripts = name => {
    vm.runInContext(readFileSync(join(root, 'worker', name), 'utf8'), sctx,
      { filename: name });
  };

  vm.runInContext(readFileSync(join(root, 'worker', 'parseWorker.js'), 'utf8'), sctx,
    { filename: 'parseWorker.js' });

  const sbook = sbox.parseBook;
  check('importScripts 把 EPUB 解析器带了进来',
    typeof sbox.parseEPUB === 'function');
  check('MOBI 解析入口未被覆盖', typeof sbox.parseMOBI === 'function');
  check('parseBook 已导出', typeof sbook === 'function');

  check('按魔数把 EPUB 认出来（不看扩展名）',
    sbox.detectFormat(new Uint8Array(ab(EPUB3_BIN)), '改过名的.mobi') === 'epub');
  check('魔数不符时按扩展名兜底',
    sbox.detectFormat(new Uint8Array([0x42, 0x4f, 0x4f, 0x4b]), 'x.epub') === 'epub');
  check('普通 MOBI 判为 mobi',
    sbox.detectFormat(new Uint8Array([0x00, 0x10, 0x00, 0x00]), 'x.mobi') === 'mobi');

  // EPUB 分支必须返回 Promise —— 上层是 await 它的，若改回同步返回值，
  // Worker 里 postMessage 会把未 settle 的 Promise 克隆成空对象，静默丢书
  const p = sbook(ab(EPUB3_BIN), '测试用书.epub');
  check('EPUB 分支返回 Promise（上层才能 await）',
    p && typeof p.then === 'function');
  const viaDispatch = await p;
  check('经 parseBook 走通的 EPUB 结果与直接调用一致',
    JSON.stringify(viaDispatch.sections) === JSON.stringify(r1.sections),
    `${viaDispatch.sections.length} 节`);

  // MOBI 分支走的是同步路径，且不该被 EPUB 逻辑串味
  let mobiMsg = '';
  try { sbook(new Uint8Array([0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49]).buffer, 'x.mobi'); }
  catch (e) { mobiMsg = e.message; }
  check('MOBI 分支报的是 MOBI 的错，没有串到 EPUB 上',
    !!mobiMsg && !/EPUB|ZIP/i.test(mobiMsg), mobiMsg || '（没有抛错）');
}

console.log(failed ? `\n${failed} 项未通过` : '\nEPUB 解析器与格式分发全部通过 ✅');
process.exit(failed ? 1 : 0);
