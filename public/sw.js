/* PhotoQueue service worker - FIXED */

importScripts("/idb.js");

const CACHE_VERSION = "photoqueue-v2"; // ✅ bump when you change SW
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/idb.js",
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("photoqueue-") && k !== CACHE_VERSION)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // ✅ CRITICAL FIX:
  // Do NOT cache non-GET (POST/PUT/DELETE...) and do NOT cache API calls
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req));
    return;
  }

  // Navigation: network first, fallback to cache and offline page
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          return cached || caches.match("/offline.html");
        }),
    );
    return;
  }

  // Static assets: cache first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      });
    }),
  );
});

// ✅ Background Sync
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-uploads") {
    event.waitUntil(uploadQueuedPhotos());
  }
});

async function uploadQueuedPhotos() {
  // PQ_IDB exists because idb.js attaches to self
  const items = await self.PQ_IDB.getAll();

  for (const item of items) {
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataUrl: item.dataUrl,
          createdAt: item.createdAt,
        }),
      });

      if (res.ok) {
        await self.PQ_IDB.del(item.id);
      } else {
        // stop and retry later
        break;
      }
    } catch {
      // offline or server down → keep for next sync
      break;
    }
  }
}

// ✅ Push notifications
self.addEventListener("push", (event) => {
  console.log("[SW] push event received", event);

  let data = { title: "PhotoQueue", body: "Nova obavijest", url: "/" };

  try {
    if (event.data) {
      // očekujemo JSON string iz DevTools push polja
      data = { ...data, ...event.data.json() };
    }
  } catch (err) {
    console.log("[SW] push parse failed", err);
  }

  const options = {
    body: data.body,
    data: { url: data.url },
    badge: "/icons/icon-192.png",
    icon: "/icons/icon-192.png",
  };

  event.waitUntil(
    self.registration
      .showNotification(data.title, options)
      .then(() => {
        console.log("[SW] showNotification resolved", data);
      })
      .catch((err) => {
        console.log("[SW] showNotification failed", err);
      }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const url = event.notification?.data?.url || "/";
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const c of clients) {
          if ("focus" in c) {
            c.navigate(url);
            return c.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
