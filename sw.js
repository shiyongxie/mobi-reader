/**
 * sw.js —— Service Worker（PWA 离线支持 + 安卓分享接收）
 * -------------------------------------------------------------
 * 策略：
 *   - App Shell（HTML/CSS/JS/图标）：Cache-First + 版本化更新
 *   - 其他同源 GET 请求（如运行时资源）：命中即回、未命中缓存并返回
 *   - 分享端点上的 POST：转存到收件箱后 303 回首页（见 handleShare）
 * 注意：书籍内容存于 IndexedDB，IndexedDB 本身不经过 SW，
 *       解析后的书籍天然随浏览器离线可用。
 */
'use strict';

/* 版本号必须随资源清单变化而提升：GET 走的是 cache-first 且命中永不回源，
   不升版本的话，已装 PWA 的用户永远拿不到新加的文件
   （v3 → v4 新增 epubParser.js / shareInbox.js 与 POST 处理）。 */
const CACHE_NAME = 'mobi-reader-shell-v4';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles/main.css',
  './styles/reader.css',
  './js/storage.js',
  './js/ui.js',
  './js/mobiParser.js',
  './js/shareInbox.js',
  './js/tts.js',
  './js/annotations.js',
  './js/reader.js',
  './js/app.js',
  './worker/parseWorker.js',
  './worker/epubParser.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

/* 分享端点。必须要有一个**静态服务器接不住**的落点：share_target 提交的是
   POST 导航，GitHub Pages 之类对 POST 只会回 405，所以由 SW 在这里截下。 */
const SHARE_PATH = new URL('./index.html', self.location.href).pathname;
const HOME_URL = new URL('./index.html', self.location.href).href;

/* 收件箱脚本必须在**顶层** importScripts。
   Service Worker 的「脚本资源表」在安装时随主脚本一起冻结，运行期（例如
   在 fetch 事件里）再调 importScripts 会被直接拒绝并抛 NetworkError，
   **而且根本不会发出网络请求** —— 服务器侧看不到任何访问，报错只有一句
   "The script ... failed to load"，极难定位。普通 Worker 没有这条限制，
   所以这是个只在 SW 里才会踩到的坑。
   用 try/catch 包住：真加载失败时 SW 照样能装好（离线能力不受牵连），
   分享进来会在 handleShare 里明确落到 ?share=error。

   ⚠️ 改了这个文件的内容后，记得同时提升 CACHE_NAME。SW 主脚本每次导航都会
   绕过 HTTP 缓存重新拉取，但 importScripts 的**被导入脚本**默认走
   `updateViaCache: 'imports'` —— 可能命中 HTTP 缓存，于是 SW 拿到旧的
   shareInbox.js、页面拿到新的，正是本文件开头警告的那种 schema 漂移。 */
try {
  importScripts('./js/shareInbox.js');
} catch (e) {
  console.warn('[sw] 分享收件箱加载失败，分享直达将不可用:', e);
}

/** 安装：预缓存应用壳 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/** 激活：清理旧版本缓存 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
      .then(purgeInbox)
  );
});

/**
 * 接收系统分享：把 multipart 里的文件存进收件箱，再 303 回首页。
 * 用 303 而非 302，是为了让浏览器明确改用 GET —— 否则用户刷新时
 * 会把 POST 重放一遍，重复导入同一本书。
 */
async function handleShare(request) {
  try {
    // 不能在这里 importScripts（运行期会被 Service Worker 拒绝，见文件顶部注释）
    if (typeof SharedInbox === 'undefined') throw new Error('分享收件箱不可用');
    const form = await request.formData();
    const files = form.getAll('book')
      .filter(f => f && typeof f.arrayBuffer === 'function' && f.size > 0);
    if (!files.length) return Response.redirect(HOME_URL + '?share=empty', 303);
    const id = await SharedInbox.put(files);   // 等事务真正提交完
    return Response.redirect(HOME_URL + '?share=' + encodeURIComponent(id), 303);
  } catch (err) {
    console.warn('[sw] 接收分享失败:', err);
    return Response.redirect(HOME_URL + '?share=error', 303);
  }
}

/** 清理久未消费的分享残留（用户分享后没打开页面就切走了） */
function purgeInbox() {
  try {
    if (typeof SharedInbox === 'undefined') return Promise.resolve();
    return SharedInbox.purge().catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

/** 请求拦截：分享 POST 单独处理，其余同源 GET 缓存优先 */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* 分享分支必须放在下面的 GET 早退**之前**：POST 导航一旦落到
     `req.method !== 'GET'` 那一行就会被直接放行给服务器，而静态服务器
     接不住 POST —— 表现为分享完页面报 405，且没有任何页面侧的线索。 */
  if (url.pathname === SHARE_PATH && req.method === 'POST') {
    event.respondWith(handleShare(req));
    return;
  }

  // 仅处理同源 GET
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        // 顺手把成功的响应放进缓存，供离线时使用
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => cached || Response.error());
    })
  );
});
