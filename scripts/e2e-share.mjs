/**
 * scripts/e2e-share.mjs —— 真实浏览器端到端：EPUB 导入 + 安卓分享直达
 * -------------------------------------------------------------
 * 运行：node scripts/e2e-share.mjs
 * 依赖：npm i --no-save puppeteer-core   （跑完可删 node_modules）
 *
 * e2e-chrome.mjs 走的是 file:// + MOBI。本脚本专门覆盖 **Node 里测不了**的
 * 三块接缝（都需要 Service Worker + IndexedDB + 真实渲染）：
 *
 *   A. EPUB 在真实浏览器里的整条导入 → 渲染 → 目录跳转链路
 *   B. sw.js 拦截对分享端点的 POST → 写收件箱 → 303 重定向
 *   C. 页面消费 ?share=<id> → 导入；且同一个 id 再访问不会重复导入
 *
 * 必须起 HTTP 服务：Service Worker 只在安全上下文里可用（localhost 视为安全）。
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRealisticEpub } from './lib/epub-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* --------------------------- 静态服务器 --------------------------- */
/* 与 GitHub Pages 同类：只认 GET/HEAD，POST 一律 405。
   这正是「SW 必须自己接住分享 POST」的原因。
   记下收到的非 GET 次数 —— 它必须是 0，否则说明 SW 没拦住、测试走了旁路。 */
let serverPostHits = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    serverPostHits++;
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('本地服务:', base);

/* 把两本书落到磁盘：setInputFiles / <input type=file> 都只认真实路径 */
const tmpA = join(root, 'scripts', '.e2e-book-a.epub');
const tmpB = join(root, 'scripts', '.e2e-book-b.epub');
writeFileSync(tmpA, makeRealisticEpub({ chapters: 12, title: '端到端测试书甲' }));
writeFileSync(tmpB, makeRealisticEpub({ chapters: 4, title: '端到端测试书乙' }));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? ' ✓' : ' ✗'} ${name}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 820 });

const errors = [];
page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));
page.on('console', msg => {
  if (msg.type() === 'error' && !/net::ERR_FAILED|favicon/i.test(msg.text())) {
    errors.push('CONSOLE: ' + msg.text());
  }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 书架上现在有几本、都叫什么 */
const shelfState = () => page.evaluate(() => ({
  count: document.querySelectorAll('#book-grid .book-card').length,
  titles: [...document.querySelectorAll('#book-grid .book-title')].map(e => e.textContent),
}));

/** 收件箱里还剩几条（用来验证 take() 的读+删是原子的） */
const inboxRows = () => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.open('mobi-reader-inbox', 1);
  req.onerror = () => resolve(-1);
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('inbox')) { resolve(0); return; }
    const g = db.transaction('inbox', 'readonly').objectStore('inbox').getAll();
    g.onsuccess = () => resolve(g.result.length);
    g.onerror = () => resolve(-1);
  };
}));

try {
  /* ============================ A. EPUB 导入 ============================ */
  console.log('\n【A】EPUB 在真实浏览器里的导入与渲染');

  await page.goto(base + '/index.html', { waitUntil: 'load' });

  // SW 必须先就绪并接管页面：后面的分享 POST 全靠它
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-api';
    const reg = await navigator.serviceWorker.ready;
    return reg.active ? 'active' : 'no-active';
  });
  check('Service Worker 已激活', swState === 'active', swState);
  await page.reload({ waitUntil: 'load' });   // 首次注册的页面尚未被接管
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10000 });
  check('当前页面已被 SW 接管', true);

  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(tmpA);
  await page.waitForFunction(() => {
    const card = document.querySelector('#book-grid .book-card');
    return card && document.getElementById('import-progress').classList.contains('hidden');
  }, { timeout: 60000, polling: 300 });

  let shelf = await shelfState();
  check('EPUB 导入成功并出现在书架', shelf.count === 1, shelf.titles.join(','));

  /* ---- 打开并检查渲染 ---- */
  await page.click('#book-grid .book-card');
  await page.waitForFunction(() =>
    !document.getElementById('view-reader').classList.contains('hidden'), { timeout: 10000 });
  await sleep(900);   // 让进度恢复定位跑完，免得覆盖后面的滚动断言

  const rendered = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('#reader-content section.mobi-section')];
    return {
      title: document.getElementById('reader-title').textContent,
      sections: secs.length,
      ids: secs.map(s => s.id),
      chars: document.getElementById('reader-content').textContent.replace(/\s/g, '').length,
      // 只数正文里的图。document.images 会连书架的 icon.svg 一起算进去，
      // 那样即便正文的图一张没解码出来，断言也照样绿
      imgs: [...document.querySelectorAll('#reader-content img')]
        .filter(i => i.complete && i.naturalWidth > 0).length,
      tocItems: document.querySelectorAll('#toc-list .toc-item').length,
    };
  });
  check('进入阅读视图', !!rendered.title, `标题「${rendered.title}」`);
  check('12 篇正文 → 12 节', rendered.sections === 12, `${rendered.sections} 节`);
  check('sections[i].id 严格为 sec-i（annotations.js 靠它索引）',
    rendered.ids.every((id, i) => id === 'sec-' + i), rendered.ids.join(','));
  check(`正文已渲染（${rendered.chars} 字）`, rendered.chars > 500);
  check('内嵌图片经 Blob URL 加载成功', rendered.imgs >= 4, `${rendered.imgs} 张`);
  check('目录条目已渲染（12 章 + 12 小节）',
    rendered.tocItems === 24, `${rendered.tocItems} 条`);

  /* ---- 目录跳转：跨章重名 id 改写后仍要跳对章 ---- */
  // 每章 h2 都叫 id="note"，第 2 章起被改名为 sec-N--note。
  // 跳错的表现是「点了没反应」或「跳回第 1 章」，都不报错 —— 只能靠真实滚动结果断言。
  const jumpTo = async (title, expectSec) => page.evaluate(async (title, expectSec) => {
    const li = [...document.querySelectorAll('#toc-list .toc-item')]
      .find(e => e.textContent.trim() === title);
    if (!li) return { err: '目录里找不到「' + title + '」' };
    li.click();
    // scrollIntoView 是 smooth 的，轮询等它停
    const scroller = document.getElementById('reader-scroll');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      const el = document.getElementById(li.dataset.anchor);
      if (!el) continue;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (Math.abs(top) < 40) {
        const sec = el.closest('section.mobi-section');
        return { sec: sec && sec.id, top: Math.round(top) };
      }
    }
    const el = document.getElementById(li.dataset.anchor);
    return { err: '滚动未停在目标处', found: !!el, expectSec };
  }, title, expectSec);

  const j5 = await jumpTo('第 5 章的小节', 'sec-4');
  check('点「第 5 章的小节」跳到第 5 节（跨章重名 id 改写正确）',
    j5.sec === 'sec-4', j5.err || `落在 ${j5.sec}`);

  const j11 = await jumpTo('第 11 章的小节', 'sec-10');
  check('点「第 11 章的小节」跳到第 11 节',
    j11.sec === 'sec-10', j11.err || `落在 ${j11.sec}`);

  const j1 = await jumpTo('第 1 章的小节', 'sec-0');
  check('点第 1 章的小节仍回到第 1 节（未被改名波及）',
    j1.sec === 'sec-0', j1.err || `落在 ${j1.sec}`);

  const jCh7 = await jumpTo('第 7 章', 'sec-6');
  check('点章级目录项跳到对应章', jCh7.sec === 'sec-6', jCh7.err || `落在 ${jCh7.sec}`);

  /* ---- 标注落点：选中第 3 节里的字，验证 section 归属正确 ---- */
  const anno = await page.evaluate(() => {
    const sec = document.getElementById('sec-3');
    const p = sec.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return { text: sel.toString().slice(0, 12), paras: sec.querySelectorAll('p').length };
  });
  check('正文可被选中（标注入口可用）', anno.text.length > 0 && anno.paras > 0,
    `「${anno.text}…」`);

  await page.click('#btn-back');   // 回书架，准备分享阶段
  await sleep(300);

  /* ======================= B. 分享 POST 拦截 ======================= */
  console.log('\n【B】sw.js 拦截 POST → 收件箱 → 303');

  /* 在页面脚本跑之前把「新文档加载时的 location.search」记下来。
     不能等导航完再读 location.search —— 页面消费完会立刻 replaceState 清掉它，
     等测试读到时就只剩空字符串了（这正是第一版测试误判的原因）。 */
  await page.evaluateOnNewDocument(() => { window.__search0 = location.search; });

  const before = serverPostHits;
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 })
    .then(() => 'ok').catch(e => 'NAVFAIL: ' + e.message);

  // 提交一个货真价实的 multipart 表单 **导航** —— 这正是安卓分享面板发出的
  // 那一种请求（不是 fetch），也只有它才能验证 303 会被浏览器跟成 GET。
  await page.evaluate((b64, name) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/epub+zip' }));

    const form = document.createElement('form');
    form.method = 'POST';
    form.enctype = 'multipart/form-data';
    form.action = './index.html';             // = manifest.share_target.action
    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'book';                      // = share_target.params.files[0].name
    input.files = dt.files;
    form.append(input);
    document.body.append(form);
    form.submit();
  }, readFileSync(tmpB).toString('base64'), '端到端测试书乙.epub');

  const navResult = await nav;
  check('分享 POST 由 SW 接住，压根没落到静态服务器上',
    serverPostHits === before, `服务器收到 ${serverPostHits - before} 次 POST`);
  check('POST 导航顺利完成', navResult === 'ok', navResult);

  // 真实导航应当已经跟着 303 落到 ?share=<id>
  await page.waitForFunction(() => document.getElementById('book-grid') && window.__search0 !== undefined,
    { timeout: 20000 }).catch(() => {});
  const landed = await page.evaluate(() => window.__search0);
  check('303 后被浏览器跟成 GET 并带上 ?share=<id>',
    /^\?share=\d+$/.test(landed || ''), landed || '(没有 share 参数)');

  await page.waitForFunction(() => {
    const card = document.querySelector('#book-grid .book-card');
    return card && document.getElementById('import-progress').classList.contains('hidden');
  }, { timeout: 60000, polling: 300 }).catch(() => {});

  // 页面消费完会立刻把查询串清掉（防刷新重复导入）
  check('页面消费后立刻清掉 ?share 查询串（刷新不会重复导入）',
    (await page.evaluate(() => location.search)) === '',
    await page.evaluate(() => location.search) || '(已清空)');

  shelf = await shelfState();
  check('分享的书已导入书架（共 2 本）',
    shelf.count === 2, shelf.titles.join(','));
  check('收件箱记录已被取走（take 读+删原子）',
    (await inboxRows()) === 0, `${await inboxRows()} 条残留`);

  /* ===================== C. 重复消费不会重复导入 ===================== */
  console.log('\n【C】同一个 ?share=<id> 再访问一次');

  const again = await page.evaluate(async (url) => {
    const r = await fetch(url);
    return { ok: r.ok, text: (await r.text()).length > 100 };
  }, `${base}/index.html?share=999999`);
  check('已失效的 share id 不会让页面崩（正常返回首页）', again.ok && again.text);

  await page.goto(`${base}/index.html?share=999999`, { waitUntil: 'load' });
  await sleep(800);
  shelf = await shelfState();
  check('不存在的 id 不新增书籍（仍 2 本）', shelf.count === 2, `${shelf.count} 本`);
  check('不存在的 id 不留脏查询串',
    (await page.evaluate(() => location.search)) === '');

  await page.screenshot({ path: join(root, 'scripts', '.e2e-share-shelf.png') });

  /* ---------------------------- 收尾 ---------------------------- */
  console.log('\n【D】运行期报错检查');
  const real = errors.filter(e => !/manifest|Failed to load resource/i.test(e));
  check('全程无未预期的 JS 报错', real.length === 0,
    real.slice(0, 3).join(' | ').slice(0, 200));

} catch (err) {
  failed++;
  console.error('\n测试中断:', err.message);
  try { await page.screenshot({ path: join(root, 'scripts', '.e2e-share-fail.png') }); }
  catch { /* 页面可能已经没了 */ }
} finally {
  await browser.close();
  server.close();
  for (const f of [tmpA, tmpB]) { try { unlinkSync(f); } catch { /* 已删 */ } }
}

console.log(failed ? `\n${failed} 项未通过` : '\n分享直达与 EPUB 导入端到端全部通过 ✅');
process.exit(failed ? 1 : 0);
