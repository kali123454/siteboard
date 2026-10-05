/* שומר את מסך האפליקציה כדי שייפתח מהר; הנתונים תמיד מגיעים מהשרת */
const CACHE = "siteboard-v4";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/team.html","/manager.html","/admin.html","/icon-192.png"]))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate") {
    const fallback = u.pathname.startsWith("/manager") ? "/manager.html" : u.pathname.startsWith("/admin") ? "/admin.html" : "/team.html";
    e.respondWith(fetch(e.request).catch(() => caches.match(fallback)));
  }
});

/* התראה שקופצת בטלפון */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "לוח עבודות", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    dir: "rtl",
    lang: "he",
    data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if (new URL(c.url).pathname.startsWith(url) && "focus" in c) { c.postMessage("refresh"); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
