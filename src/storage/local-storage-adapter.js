export function createLocalStorageAdapter(storageRef) {
  const storage =
    storageRef ||
    (typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null);

  function load(key) {
    if (!storage) {
      return null;
    }

    try {
      const raw = storage.getItem(String(key));
      if (!raw) {
        return null;
      }
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function save(key, value) {
    if (!storage) {
      return false;
    }

    try {
      storage.setItem(String(key), JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function remove(key) {
    if (!storage) {
      return false;
    }
    try {
      storage.removeItem(String(key));
      return true;
    } catch {
      return false;
    }
  }

  function watch(key, handler) {
    if (
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function" ||
      typeof handler !== "function"
    ) {
      return () => {};
    }

    const storageKey = String(key);
    const listener = (event) => {
      if (event.storageArea !== storage || event.key !== storageKey) {
        return;
      }

      let nextValue = null;
      try {
        nextValue = event.newValue ? JSON.parse(event.newValue) : null;
      } catch {
        nextValue = null;
      }
      handler(nextValue);
    };

    window.addEventListener("storage", listener);
    return () => {
      window.removeEventListener("storage", listener);
    };
  }

  return {
    load,
    save,
    remove,
    watch
  };
}

