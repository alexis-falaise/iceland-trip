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

export function createSupabaseAdapter(options = {}) {
  const client = options.client || null;
  const table = String(options.table || "");
  const keyColumn = String(options.keyColumn || "key");
  const valueColumn = String(options.valueColumn || "value");

  if (!client || !table) {
    return createNoopAdapter();
  }

  async function load(key) {
    try {
      const response = await client
        .from(table)
        .select(valueColumn)
        .eq(keyColumn, String(key))
        .limit(1)
        .maybeSingle();

      if (response.error) {
        return null;
      }
      return response.data ? response.data[valueColumn] : null;
    } catch {
      return null;
    }
  }

  async function save(key, value) {
    try {
      const response = await client
        .from(table)
        .upsert(
          [{ [keyColumn]: String(key), [valueColumn]: value }],
          { onConflict: keyColumn }
        );
      return !response.error;
    } catch {
      return false;
    }
  }

  async function remove(key) {
    try {
      const response = await client
        .from(table)
        .delete()
        .eq(keyColumn, String(key));
      return !response.error;
    } catch {
      return false;
    }
  }

  function watch(key, handler) {
    if (typeof handler !== "function" || typeof client.channel !== "function") {
      return () => {};
    }

    const watchedKey = String(key);
    const channelName =
      "storage_watch_" + table + "_" + watchedKey + "_" + Math.random().toString(36).slice(2, 8);

    const channel = client
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: keyColumn + "=eq." + watchedKey
        },
        (payload) => {
          const row = payload && payload.new ? payload.new : null;
          handler(row ? row[valueColumn] : null);
        }
      )
      .subscribe();

    return () => {
      try {
        client.removeChannel(channel);
      } catch {
        // Non-blocking cleanup.
      }
    };
  }

  return {
    load,
    save,
    remove,
    watch
  };
}

