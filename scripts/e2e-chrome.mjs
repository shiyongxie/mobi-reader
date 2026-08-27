/**
 * scripts/e2e-chrome.mjs —— 真实 Chrome 端到端测试
 * -------------------------------------------------------------
 * 完全复刻用户"双击 index.html"的场景（file:// 协议）：
 *   打开页面 → 选择 .mobi 导入 → 检查书架卡片 → 打开书检查渲染
 *   → 刷新页面验证 IndexedDB 缓存直接可用
 * 运行：node scripts/e2e-chrome.mjs <可选:mobi路径>
 */
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* 找一本可用的 mobi：优先命令行参数，其次项目目录，再退到桌面/下载 */
function findMobi() {
  if (process.argv[2]) return process.argv[2];
  const dirs = [root, join(root, '..', 'Desktop'), 'C:\\Users\\Abner\\Downloads'];
  for (const d of dirs) {
    try {
      const hit = readdirSync(d).find(f => /\.mobi$/i.test(f));
      if (hit) return join(d, hit);
    } catch { /* 目录不存在则跳过 */ }
  }
  return null;
}

const mobiPath = findMobi();
if (!mobiPath) { console.error('未找到 .mobi 测试文件'); process.exit(1); }
console.log('测试文件:', mobiPath);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 820 });

/* 收集页面内的报错，便于失败时直接呈现根因 */
const errors = [];
page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));
page.on('console', msg => {
  if (msg.type() === 'error' && !/net::ERR_FAILED|favicon/i.test(msg.text())) {
    errors.push('CONSOLE: ' + msg.text());
  }
});

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? ' ✓' : ' ✗'} ${name}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failed++;
};

try {
  await page.goto('file:///' + root.replaceAll('\\', '/') + '/index.html', { waitUntil: 'load' });

  /* ---------- 导入书籍 ---------- */
  await page.waitForSelector('#btn-import');
  await page.setInputFilesFallback?.(0); // no-op 占位（避免误用）
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(mobiPath);
  await page.click('#btn-import');

  // 轮询等待：书架出现卡片 或 失败 Toast
  const outcome = await page.waitForFunction(() => {
    const card = document.querySelector('#book-grid .book-card');
    const toast = document.getElementById('ui-toast');
    if (card && document.getElementById('import-progress').classList.contains('hidden')) {
      return { ok: true, title: card.querySelector('.book-title').textContent };
    }
    if (toast && toast.classList.contains('show') && /导入失败|无法|错误|失败/.test(toast.textContent)) {
      return { ok: false, msg: toast.textContent };
    }
    return false;
  }, { timeout: 60000, polling: 500 }).then(h => h.jsonValue());

  check('导入成功并出现在书架', outcome.ok,
    outcome.ok ? `标题「${outcome.title}」` : `失败提示: ${outcome.msg}`);
  if (!outcome.ok) throw new Error('导入阶段终止: ' + JSON.stringify(outcome));

  /* ---------- 打开书籍检查阅读页 ---------- */
  await page.click('#book-grid .book-card');
  await page.waitForFunction(() =>
    !document.getElementById('view-reader').classList.contains('hidden'), { timeout: 10000 });
  // 给"进度恢复定位帧"留出完成窗口，避免测试滚动被其覆盖（竞态）
  await new Promise(r => setTimeout(r, 900));
  const info = await page.evaluate(() => ({
    title: document.getElementById('reader-title').textContent,
    sections: document.querySelectorAll('.mobi-section').length,
    chars: document.getElementById('reader-content').textContent.replace(/\s/g, '').length,
    imgs: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length,
    tocItems: document.querySelectorAll('#toc-list .toc-item').length,
  }));
  check('进入阅读视图', !!info.title, `标题「${info.title}」`);
  check(`章节已渲染 (${info.sections} 节 / ${info.chars} 字)`, info.sections >= 5 && info.chars > 50000);
  check('内嵌图片正常加载', info.imgs >= 1, `${info.imgs} 张`);
  check(`目录条目 ${info.tocItems}`, info.tocItems >= 10);
  await page.screenshot({ path: join(root, 'scripts', '.e2e-reader.png') });

  /* ---------- TTS 冒烟：预取缓冲播放的控制流 ---------- */
  // 无头环境可能没有任何朗读语音，此时只做"不崩"检查而非功能断言
  const hasVoices = await page.evaluate(() => window.speechSynthesis &&
    speechSynthesis.getVoices().length > 0);
  if (!hasVoices) {
    console.log(' (无可用朗读语音，TTS 仅做烟雾级检查)');
  }
  try {
    await page.click('#btn-tts-toggle');            // 从视口位置开始朗读
    await new Promise(r => setTimeout(r, 400));
    const started = await page.evaluate(() => TTS.isActive());
    await page.click('#btn-tts-next');              // 跳下一句：重建缓冲队列
    await new Promise(r => setTimeout(r, 200));
    await page.click('#btn-tts-toggle');            // 暂停
    const pausedIcon = await page.evaluate(() =>
      document.getElementById('btn-tts-toggle').textContent.includes('朗读'));
    await page.click('#btn-tts-toggle');            // 恢复（含失效队列自愈路径）
    await new Promise(r => setTimeout(r, 200));
    const resumed = await page.evaluate(() => TTS.isActive());
    await page.click('#btn-tts-stop');
    const stopped = await page.evaluate(() => !TTS.isActive());
    const hlApi = await page.evaluate(() =>
      !!(window.CSS && CSS.highlights && window.Highlight));
    if (hasVoices) {
      check('TTS 控制（开始/跳句/暂停/恢复/停止）',
        started && pausedIcon && resumed && stopped,
        `playing=${started} 暂停图标=${pausedIcon} 恢复=${resumed} 停止=${stopped}`);
    } else {
      check('TTS 操作过程无 JS 异常', stopped);
    }
    console.log(` (朗读高亮通道: ${hlApi ? 'CSS Custom Highlight 假加粗' : '覆盖层贴片'})`);
  } catch (e) {
    check('TTS 控制流程', false, e.message.split('\n')[0]);
  }

  /* ---------- 刷新验证缓存与进度恢复 ---------- */
  // 先滚到中间制造一个进度
  await page.evaluate(() => {
    const el = document.getElementById('reader-scroll');
    el.scrollTop = el.scrollHeight * 0.3;
  });
  await new Promise(r => setTimeout(r, 2600));   // 等 2s 节流保存
  await page.reload({ waitUntil: 'load' });
  await page.click('#book-grid .book-card');
  await page.waitForFunction(() =>
    !document.getElementById('view-reader').classList.contains('hidden'), { timeout: 10000 });
  // 轮询等待恢复定位生效（此前单次读取会抢在两帧恢复动画之前）
  let restored = false, restoredTop = 0;
  try {
    await page.waitForFunction(
      () => document.getElementById('reader-scroll').scrollTop > 1000,
      { timeout: 6000, polling: 250 });
    restored = true;
    restoredTop = await page.evaluate(
      () => document.getElementById('reader-scroll').scrollTop);
  } catch { /* 超时保持 false */ }
  check('刷新后重新打开跳回原进度', restored, `scrollTop=${restoredTop}`);
  // 无需重新导入即可打开 = 缓存生效（本次 reload 直接点卡片即证明）
  console.log('\n(刷新后书架仍有书籍卡片且可直接打开 —— IndexedDB 缓存有效)');
} catch (err) {
  failed++;
  console.error('\n测试中断:', err.message);
} finally {
  if (errors.length) {
    console.log('\n== 页面捕获到的报错 ==');
    errors.slice(0, 12).forEach(e => console.log('  ', e.split('\n')[0]));
  } else {
    console.log('（页面无任何 JS 报错）');
  }
  await browser.close();
}

console.log(failed ? `\n${failed} 项未通过` : '\n端到端全部通过 ✅');
process.exit(failed ? 1 : 0);
