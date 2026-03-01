function createNoopAdapter() {
  return {
    async load() {
      return null;
    },
    async save() {
      return false;
    },
    async remove() {
      return false;
    },
    watch() {
      return () => {};
    }
  };
}

export function createIndexedDbAdapter(options = {}) {
  if (typeof indexedDB === "undefined") {
    return createNoopAdapter();
  }

  const dbName = String(options.dbName || "iceland-trip");
  const storeName = String(options.storeName || "kv");
  const version = Number.isFinite(Number(options.version))
    ? Number(options.version)
    : 1;

  let openPromise = null;

  function openDatabase() {
    if (openPromise) {
      return openPromise;
    }

    openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error || new Error("IndexedDB open failed"));
      };
    });

    return openPromise;
  }

  async function withStore(mode, callback) {
    try {
      const db = await openDatabase();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const objectStore = transaction.objectStore(storeName);
        const result = callback(objectStore);

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () =>
          reject(transaction.error || new Error("IndexedDB transaction failed"));
      });
    } catch {
      return null;
    }
  }

  async function load(key) {
    return withStore("readonly", (store) => {
      return new Promise((resolve, reject) => {
        const request = store.get(String(key));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async function save(key, value) {
    const result = await withStore("readwrite", (store) => {
      store.put(value, String(key));
      return true;
    });
    return Boolean(result);
  }

  async function remove(key) {
    const result = await withStore("readwrite", (store) => {
      store.delete(String(key));
      return true;
    });
    return Boolean(result);
  }

  return {
    load,
    save,
    remove,
    watch() {
      return () => {};
    }
  };
}

