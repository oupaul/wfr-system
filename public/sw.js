/*
 * 資金週報 PWA Service Worker（刻意保守）
 *
 * 這是財務系統：餘額、收支、登入狀態都不能顯示過期或被快取的內容，
 * 而且系統常常更新，快取舊的 JS/HTML 會造成「新 API 配舊畫面」的問題。
 * 所以只做兩件事：
 *   1. 快取 App 圖示與「需要連線」頁（讓離線時不是瀏覽器的恐龍畫面）
 *   2. 網頁導覽（開頁面）失敗時改顯示 /offline.html
 * 其餘（頁面、JS、CSS、所有 /api/ 請求）一律直接走網路，不快取、不攔截。
 * 要改這個檔案的快取內容時，把 CACHE_NAME 的版本號加一，舊快取會在啟用時被清掉。
 */
const CACHE_NAME = 'zjzb-shell-v1';
const PRECACHE = [
    '/offline.html',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return; // 資料請求絕不經過快取

    // App 圖示：快取優先
    if (url.pathname.startsWith('/icons/')) {
        event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
        return;
    }

    // 開頁面：走網路，連不上才顯示離線頁
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(() => caches.match('/offline.html'))
        );
    }
    // 其他請求不攔截，由瀏覽器照常處理
});
