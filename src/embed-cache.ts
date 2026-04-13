// File-based embedding cache, keyed on cachePrefix (e.g. model name) + exact content.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const EMBEDDING_CACHE_DIR = "data/embedding_cache";

function batchCacheKey(cachePrefix: string, texts: string[]): string {
  const h = createHash("sha256");
  h.update(cachePrefix);
  for (const t of texts) h.update(`\n${t}`);
  return h.digest("hex");
}

function loadCached(key: string): number[][] | null {
  const path = `${EMBEDDING_CACHE_DIR}/${key}.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveCache(key: string, embeddings: number[][]): void {
  mkdirSync(EMBEDDING_CACHE_DIR, { recursive: true });
  writeFileSync(`${EMBEDDING_CACHE_DIR}/${key}.json`, JSON.stringify(embeddings));
}

export async function embedWithCache(
  texts: string[],
  embedFn: (batch: string[]) => Promise<number[][]>,
  batchSize: number,
  cachePrefix: string,
): Promise<number[][]> {
  const all: number[][] = [];
  let cached = 0;
  let fetched = 0;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const key = batchCacheKey(cachePrefix, batch);
    const hit = loadCached(key);
    if (hit) {
      all.push(...hit);
      cached += batch.length;
      continue;
    }
    const batchEmbeddings = await embedFn(batch);
    saveCache(key, batchEmbeddings);
    all.push(...batchEmbeddings);
    fetched += batch.length;
  }

  console.log(`  Embeddings: ${cached} cached, ${fetched} fetched from API`);
  return all;
}
