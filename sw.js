// 只為了讓 Android 能「安裝」成全螢幕 App。不快取任何東西，所以每次開啟都是最新版。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
