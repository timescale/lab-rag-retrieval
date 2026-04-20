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

// Approximate tokens as chars / 2 for batch packing (pessimistic — LaTeX/code
// tokenize into many short tokens). For single-doc limit we use chars/3 since
// real English/LaTeX ratio is ~3-4, and we want to only error on truly long docs.
const CHARS_PER_TOKEN_BATCH = 2;
const CHARS_PER_TOKEN_DOC = 3;
const MAX_TOKENS_PER_BATCH = 200_000;
const MAX_TOKENS_PER_DOC = 8000;
const MAX_CHARS_PER_DOC = MAX_TOKENS_PER_DOC * CHARS_PER_TOKEN_DOC;

function assertDocFits(text: string, idx: number): void {
  if (text.length > MAX_CHARS_PER_DOC) {
    throw new Error(
      `Document at index ${idx} is ${text.length} chars (> ${MAX_CHARS_PER_DOC} = ~${MAX_TOKENS_PER_DOC} tokens). ` +
        `Exceeds text-embedding-3-small 8191-token limit. Preview: ${text.slice(0, 200)}...`,
    );
  }
}

/** Pack texts into batches respecting both count limit and token limit. */
function packBatches(texts: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const t of texts) {
    const tokens = Math.ceil(t.length / CHARS_PER_TOKEN_BATCH);
    if (current.length >= batchSize || currentTokens + tokens > MAX_TOKENS_PER_BATCH) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
    }
    current.push(t);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function embedWithCache(
  texts: string[],
  embedFn: (batch: string[]) => Promise<number[][]>,
  batchSize: number,
  cachePrefix: string,
): Promise<number[][]> {
  texts.forEach(assertDocFits);
  const batches = packBatches(texts, batchSize);
  const all: number[][] = [];
  let cached = 0;
  let fetched = 0;

  for (const batch of batches) {
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
