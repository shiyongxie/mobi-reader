/**
 * scripts/smoke-live.mjs —— 对**线上部署**做真实浏览器冒烟测试
 * -------------------------------------------------------------
 * 用法：node scripts/smoke-live.mjs [url]
 *       （默认 https://shiyongxie.github.io/mobi-reader）
 *
 * 和 e2e-share.mjs 的分工：那个跑本地 http://，验证代码本身；这个跑真实
 * HTTPS，验证**部署**这一层 —— CDN 上的文件是否齐全、SW 能否安装并接管、
 * 以及 GitHub Pages 对 POST 回 405 时 SW 是否真的截住了分享请求。
 *
 * 部署完（推送后等 Pages 构建好）跑一次，比在手机上盲试快得多。
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRealisticEpub } from './lib/epub-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = (process.argv[2] || 'https://shiyongxie.github.io/mobi-reader').replace(/\/$/, '');
console.log('目标:', BASE);

const tmp = join(root, 'scripts', '.smoke.epub');
writeFileSync(tmp, makeRealisticEpub({ chapters: 6, title: '线上冒烟书' }));

let failed = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? ' ✓' : ' ✗'} ${n}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failed++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-first-run', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 820 });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

try {
  await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 60000 });

  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-api';
    const reg = await navigator.serviceWorker.ready;
    return reg.active ? 'active' : 'no-active';
  });
  check('HTTPS 下 Service Worker 激活', sw === 'active', sw);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 });
  check('页面被 SW 接管（离线壳生效）', true);

  /* ---- 手动导入 EPUB ---- */
  const input = await page.$('#file-input');
  await input.uploadFile(tmp);
  await page.waitForFunction(() => {
    const c = document.querySelector('#book-grid .book-card');
    return c && document.getElementById('import-progress').classList.contains('hidden');
  }, { timeout: 90000, polling: 400 }).catch(() => {});
  let cards = await page.evaluate(() => document.querySelectorAll('#book-grid .book-card').length);
  check('EPUB 在线上导入成功', cards === 1, `${cards} 本`);

  await page.click('#book-grid .book-card');
  await page.waitForFunction(() => !document.getElementById('view-reader').classList.contains('hidden'),
    { timeout: 20000 });
  await sleep(900);

  const r = await page.evaluate(() => ({
    title: document.getElementById('reader-title').textContent,
    secs: document.querySelectorAll('#reader-content section.mobi-section').length,
    ids: [...document.querySelectorAll('#reader-content section.mobi-section')].map(s => s.id),
    imgs: [...document.querySelectorAll('#reader-content img')].filter(i => i.complete && i.naturalWidth > 0).length,
    toc: document.querySelectorAll('#toc-list .toc-item').length,
  }));
  check('章节渲染正确', r.secs === 6 && r.ids.every((x, i) => x === 'sec-' + i), `${r.secs} 节`);
  check('图片解码成功', r.imgs >= 2, `${r.imgs} 张`);
  check('目录渲染', r.toc === 12, `${r.toc} 条`);

  const jump = await page.evaluate(async () => {
    const li = [...document.querySelectorAll('#toc-list .toc-item')]
      .find(e => e.textContent.trim() === '第 4 章的小节');
    if (!li) return { err: '找不到目录项' };
    li.click();
    const sc = document.getElementById('reader-scroll');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      const el = document.getElementById(li.dataset.anchor);
      if (!el) continue;
      if (Math.abs(el.getBoundingClientRect().top - sc.getBoundingClientRect().top) < 40) {
        return { sec: el.closest('section.mobi-section').id };
      }
    }
    return { err: '未滚动到位' };
  });
  check('跨章重名 id 的目录跳转正确', jump.sec === 'sec-3', jump.err || jump.sec);

  await page.click('#btn-back');
  await sleep(400);

  /* ---- 分享 POST（与安卓分享面板同一种 multipart 导航 POST） ---- */
  await page.evaluateOnNewDocument(() => { window.__search0 = location.search; });
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 40000 })
    .then(() => 'ok').catch(e => 'NAVFAIL: ' + e.message);

  const b64 = readFileSync(tmp).toString('base64');
  await page.evaluate((b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], '线上冒烟书.epub', { type: 'application/epub+zip' }));
    const f = document.createElement('form');
    f.method = 'POST'; f.enctype = 'multipart/form-data'; f.action = './index.html';
    const i2 = document.createElement('input');
    i2.type = 'file'; i2.name = 'book'; i2.files = dt.files;
    f.append(i2); document.body.append(f); f.submit();
  }, b64);

  check('分享 POST 导航完成', (await nav) === 'ok');
  await page.waitForFunction(() => window.__search0 !== undefined, { timeout: 20000 }).catch(() => {});
  const landed = await page.evaluate(() => window.__search0);
  check('GitHub Pages 上的 POST 被 SW 接住并 303 到 ?share=<id>',
    /^\?share=\d+$/.test(landed || ''), landed || '(无 share 参数)');

  await page.waitForFunction(() => {
    const c = document.querySelector('#book-grid .book-card');
    return c && document.getElementById('import-progress').classList.contains('hidden');
  }, { timeout: 90000, polling: 400 }).catch(() => {});
  cards = await page.evaluate(() => document.querySelectorAll('#book-grid .book-card').length);
  check('分享的书已导入（共 2 本）', cards === 2, `${cards} 本`);

  await page.screenshot({ path: join(root, 'scripts', '.smoke-live.png') });

  const real = errors.filter(e => !/manifest|favicon|Failed to load resource/i.test(e));
  check('无未预期 JS 报错', real.length === 0, real.slice(0, 2).join(' | ').slice(0, 160));
} catch (e) {
  failed++;
  console.error('中断:', e.message);
} finally {
  await browser.close();
  try { unlinkSync(tmp); } catch { }
}

console.log(failed ? `\n${failed} 项未通过` : '\n线上部署冒烟测试全部通过 ✅');
process.exit(failed ? 1 : 0);
