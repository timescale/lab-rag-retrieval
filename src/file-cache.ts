// Generic file-based keyed cache.
//
// Stores JSON-serializable values under `<dir>/<key>.json`. Caller owns the
// key derivation (usually a hash of the inputs that produced the value).
// Used for embedding batch results, chunk-tag extraction, and anything else
// where recomputing is expensive and the value is JSON.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface FileCache<T> {
  get(key: string): T | null;
  set(key: string, value: T): void;
  /** Hash helper: blake2b-free, sha256-based; combine parts with NUL separator. */
  key(...parts: string[]): string;
}

export function createFileCache<T>(dir: string): FileCache<T> {
  return {
    get(key) {
      const p = `${dir}/${key}.json`;
      if (!existsSync(p)) return null;
      try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return null; }
    },
    set(key, value) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${key}.json`, JSON.stringify(value));
    },
    key(...parts) {
      const h = createHash("sha256");
      for (const p of parts) { h.update(p); h.update("\0"); }
      return h.digest("hex");
    },
  };
}
