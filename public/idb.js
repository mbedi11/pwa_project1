/* idb.js - works in window AND service worker */

(() => {
  const DB_NAME = "photoqueue-db";
  const STORE = "queue";
  const DB_VER = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const out = fn(store);

      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  }

  const api = {
    async put(item) {
      return withStore("readwrite", (store) => store.put(item));
    },
    async getAll() {
      return withStore("readonly", (store) => {
        return new Promise((resolve, reject) => {
          const r = store.getAll();
          r.onsuccess = () => resolve(r.result || []);
          r.onerror = () => reject(r.error);
        });
      });
    },
    async del(id) {
      return withStore("readwrite", (store) => store.delete(id));
    },
    async clear() {
      return withStore("readwrite", (store) => store.clear());
    },
  };

  // ✅ Works in page (window) and in service worker (self)
  const g = typeof window !== "undefined" ? window : self;
  g.PQ_IDB = api;
})();
