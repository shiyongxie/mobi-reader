/**
 * sw.js —— Service Worker（PWA 离线支持）
 * -------------------------------------------------------------
 * 策略：
 *   - App Shell（HTML/CSS/JS/图标）：Cache-First + 版本化更新
 *   - 其他同源 GET 请求（如运行时资源）：命中即回、未命中缓存并返回
 * 注意：书籍内容存于 IndexedDB，IndexedDB 本身不经过 SW，
 *       解析后的书籍天然随浏览器离线可用。
 */
'use strict';

const CACHE_NAME = 'mobi-reader-shell-v3';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles/main.css',
  './styles/reader.css',
  './js/storage.js',
  './js/ui.js',
  './js/mobiParser.js',
  './js/tts.js',
  './js/annotations.js',
  './js/reader.js',
  './js/app.js',
  './worker/parseWorker.js',
  './assets/icon.svg',
];

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
  );
});

/** 请求拦截：缓存优先（Shell 资源），其余网络优先、失败回落缓存 */
self.addEventListener('fetch', event => {
  const req = event.request;
  // 仅处理同源 GET
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

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
