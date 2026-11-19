// 背景程式：讓 Android 能「安裝」成全螢幕 App，並確保每次開啟拿到的都是最新版。
// 不另外存任何東西；只是每次要檔案時，都先問伺服器「有沒有更新」（沒更新就用瀏覽器原本暫存的，很快）。
// 沒有這一步的話，剛發布新版的十分鐘內，手機可能拿到新舊混在一起的檔案。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // Google 的連線不經過這裡
  e.respondWith(fetch(e.request, { cache: "no-cache" }).catch(() => fetch(e.request)));
});
