import { createStore } from "./state/app-state.js";
import { createActions, stateSanitizers } from "./state/actions.js";
import { createLocalStorageAdapter } from "./storage/local-storage-adapter.js";
import { createIndexedDbAdapter } from "./storage/indexeddb-adapter.js";
import { createSupabaseAdapter } from "./storage/supabase-adapter.js";

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_APP_STATE_KEY = "icelandAppStateV1";
const DEFAULT_RECEIPTS_META_KEY = "icelandReceiptsMetaV1";
const DEFAULT_RECEIPTS_BLOB_STORE = "receipts";

function toSchemaVersion(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.round(numeric)
    : DEFAULT_SCHEMA_VERSION;
}

function createDefaultState(schemaVersion) {
  return {
    schemaVersion,
    packItems: [],
    budget: {
      maxBudgetISK: 0,
      expenses: []
    },
    activeTab: "home",
    moduleCollapse: {},
    syncSettings: {
      tripId: "",
      autoSync: true
    },
    todayOverview: {
      lastUpdatedAt: null
    }
  };
}

export function migrateState(rawState, targetSchemaVersion = DEFAULT_SCHEMA_VERSION) {
  const schemaVersion = toSchemaVersion(targetSchemaVersion);
  const base = createDefaultState(schemaVersion);
  const raw = rawState && typeof rawState === "object" ? rawState : {};

  return {
    ...base,
    ...raw,
    schemaVersion,
    packItems: stateSanitizers.sanitizePackItems(raw.packItems),
    budget: stateSanitizers.sanitizeBudgetState(raw.budget),
    moduleCollapse:
      raw.moduleCollapse && typeof raw.moduleCollapse === "object"
        ? raw.moduleCollapse
        : {},
    syncSettings: {
      tripId: String(
        raw.syncSettings && typeof raw.syncSettings.tripId === "string"
          ? raw.syncSettings.tripId
          : ""
      )
        .trim()
        .toLowerCase()
        .slice(0, 80),
      autoSync:
        !raw.syncSettings || raw.syncSettings.autoSync !== false
    },
    todayOverview:
      raw.todayOverview && typeof raw.todayOverview === "object"
        ? raw.todayOverview
        : { lastUpdatedAt: null }
  };
}

function mergeInitialState(schemaVersion, persistedState, providedState) {
  const defaults = createDefaultState(schemaVersion);
  const persisted = migrateState(persistedState, schemaVersion);
  const provided = migrateState(providedState, schemaVersion);

  return {
    ...defaults,
    ...persisted,
    ...provided,
    budget: {
      ...defaults.budget,
      ...persisted.budget,
      ...provided.budget
    },
    syncSettings: {
      ...defaults.syncSettings,
      ...persisted.syncSettings,
      ...provided.syncSettings
    },
    moduleCollapse: {
      ...defaults.moduleCollapse,
      ...persisted.moduleCollapse,
      ...provided.moduleCollapse
    },
    todayOverview: {
      ...defaults.todayOverview,
      ...persisted.todayOverview,
      ...provided.todayOverview
    }
  };
}

function createPersistence(adapterSet, options = {}) {
  const localStorage = adapterSet.localStorage;
  const indexeddb = adapterSet.indexeddb;
  const supabase = adapterSet.supabase;
  const appStateStorageKey = String(options.appStateStorageKey || DEFAULT_APP_STATE_KEY);
  const receiptsMetaStorageKey = String(
    options.receiptsMetaStorageKey || DEFAULT_RECEIPTS_META_KEY
  );

  return {
    loadDomain(key, fallbackValue) {
      const value = localStorage.load(key);
      return value === null || value === undefined ? fallbackValue : value;
    },

    saveDomain(key, value) {
      return localStorage.save(key, value);
    },

    removeDomain(key) {
      return localStorage.remove(key);
    },

    loadAppSnapshot() {
      return localStorage.load(appStateStorageKey);
    },

    saveAppSnapshot(snapshot) {
      return localStorage.save(appStateStorageKey, snapshot);
    },

    loadReceiptsMeta() {
      const meta = localStorage.load(receiptsMetaStorageKey);
      return meta && typeof meta === "object" ? meta : {};
    },

    saveReceiptsMeta(meta) {
      return localStorage.save(receiptsMetaStorageKey, meta || {});
    },

    async saveReceiptBlob(receiptId, blobOrValue) {
      return indexeddb.save("receipt:" + String(receiptId), blobOrValue);
    },

    async loadReceiptBlob(receiptId) {
      return indexeddb.load("receipt:" + String(receiptId));
    },

    async removeReceiptBlob(receiptId) {
      return indexeddb.remove("receipt:" + String(receiptId));
    },

    async saveSharedState(key, value) {
      return supabase.save(key, value);
    },

    async loadSharedState(key) {
      return supabase.load(key);
    },

    watchSharedState(key, handler) {
      return supabase.watch(key, handler);
    }
  };
}

export function createAppRuntime(options = {}) {
  const schemaVersion = toSchemaVersion(options.schemaVersion);

  const adapters = {
    localStorage: createLocalStorageAdapter(options.localStorage),
    indexeddb: createIndexedDbAdapter({
      dbName: options.indexeddbName || "iceland-trip",
      storeName: options.indexeddbStoreName || DEFAULT_RECEIPTS_BLOB_STORE,
      version: options.indexeddbVersion || 1
    }),
    supabase: createSupabaseAdapter({
      client: options.supabaseClient,
      table: options.supabaseTable || "",
      keyColumn: options.supabaseKeyColumn || "key",
      valueColumn: options.supabaseValueColumn || "value"
    })
  };

  const persistence = createPersistence(adapters, {
    appStateStorageKey: options.appStateStorageKey,
    receiptsMetaStorageKey: options.receiptsMetaStorageKey
  });

  const persistedState = persistence.loadAppSnapshot();
  const initialState = mergeInitialState(
    schemaVersion,
    persistedState,
    options.initialState
  );

  const store = createStore(initialState);
  const actions = createActions(store);

  function migrateSyncedPayload(payload) {
    const parsed = payload && typeof payload === "object" ? payload : {};
    const payloadVersion = toSchemaVersion(parsed.schemaVersion);

    if (payloadVersion <= 1) {
      return {
        schemaVersion,
        packItems: stateSanitizers.sanitizePackItems(parsed.packItems),
        budgetState: stateSanitizers.sanitizeBudgetState(parsed.budgetState),
        syncSettings:
          parsed.syncSettings && typeof parsed.syncSettings === "object"
            ? parsed.syncSettings
            : null
      };
    }

    return {
      schemaVersion,
      packItems: stateSanitizers.sanitizePackItems(parsed.packItems),
      budgetState: stateSanitizers.sanitizeBudgetState(parsed.budgetState),
      syncSettings:
        parsed.syncSettings && typeof parsed.syncSettings === "object"
          ? parsed.syncSettings
          : null
    };
  }

  return {
    schemaVersion,
    store,
    actions,
    adapters,
    persistence,
    migrateState,
    migrateSyncedPayload
  };
}

