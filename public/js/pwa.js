// 註冊 PWA 的 Service Worker（讓手機可以「加入主畫面」成為 App）。
// 失敗不影響網站正常使用；沒有 HTTPS（非 localhost）時瀏覽器本來就不支援，會直接略過。
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function (err) {
            console.warn('Service Worker 註冊失敗（不影響使用）:', err);
        });
    });
}
