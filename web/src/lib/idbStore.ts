import type { CacheEntry, CacheStore } from "./queryCache.ts";

/**
 * A key-value store on one IndexedDB object store, in the few lines `idb-keyval` would add as a
 * dependency. Every call resolves, never rejects: with IndexedDB missing or refused (private
 * mode, storage full) reads return nothing and writes do nothing.
 */
const DB_NAME = "lrbuddy";
const STORE = "queries";

let opening: Promise<IDBDatabase | null> | null = null;

const open = (): Promise<IDBDatabase | null> => {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
};

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> => {
  const db = await open();
  if (!db) return fallback;
  return new Promise<T>((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve((req.result as T | undefined) ?? fallback);
      req.onerror = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
};

const isEntry = (v: unknown): v is CacheEntry =>
  typeof v === "object" && v !== null && typeof (v as { v?: unknown }).v === "string" && typeof (v as { at?: unknown }).at === "number" && "data" in v;

export const idbStore: CacheStore = {
  get: async (key) => {
    const v: unknown = await run<unknown>("readonly", (s) => s.get(key), undefined);
    return isEntry(v) ? v : undefined;
  },
  set: async (key, entry) => {
    await run<unknown>("readwrite", (s) => s.put(entry, key), undefined);
  },
  del: async (key) => {
    await run<unknown>("readwrite", (s) => s.delete(key), undefined);
  },
  keys: async () => {
    const v: unknown = await run<unknown>("readonly", (s) => s.getAllKeys(), []);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  },
};

/** Sign-out: nothing of this session's CC stays on the phone. */
export const clearIdbStore = async (): Promise<void> => {
  await run<unknown>("readwrite", (s) => s.clear(), undefined);
};
