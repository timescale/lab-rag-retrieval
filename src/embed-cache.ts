// File-based embedding cache with exact token-aware batching.
//
// Uses js-tiktoken to count tokens exactly (cl100k_base encoding used by
// text-embedding-3-small). This avoids brittle chars/token heuristics that
// were tripping over LaTeX, code, and long docs.

import { createHash } from "node:crypto";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { createFileCache } from "./file-cache.ts";

const cache = createFileCache<number[][]>("data/embedding_cache");

// Must match the legacy hashing scheme so pre-refactor cache entries still hit.
function batchCacheKey(cachePrefix: string, texts: string[]): string {
  const h = createHash("sha256");
  h.update(cachePrefix);
  for (const t of texts) h.update(`\n${t}`);
  return h.digest("hex");
}

// Hard limits from OpenAI:
// - Per-request total: 300k tokens
// - Per-document:       8191 tokens (text-embedding-3-small)
const MAX_TOKENS_PER_BATCH = 240_000; // OpenAI limit is 300k; js-tiktoken can undercount vs OpenAI's server-side count by up to 12% on code-heavy content (leetcode corpus), so large headroom needed
const MAX_TOKENS_PER_DOC = 8000;      // leave small headroom

// Lazily initialize encoding (loading the BPE tables isn't free).
let _enc: Tiktoken | null = null;
function enc(): Tiktoken {
  if (!_enc) _enc = getEncoding("cl100k_base");
  return _enc;
}

/** Ensure every doc fits the per-doc token limit, truncating if needed. */
function truncateOverlong(texts: string[]): { safe: string[]; truncated: number; maxOriginal: number } {
  let truncated = 0;
  let maxOriginal = 0;
  const safe = texts.map((t) => {
    const tokens = enc().encode(t);
    if (tokens.length > MAX_TOKENS_PER_DOC) {
      truncated++;
      if (tokens.length > maxOriginal) maxOriginal = tokens.length;
      return enc().decode(tokens.slice(0, MAX_TOKENS_PER_DOC));
    }
    return t;
  });
  return { safe, truncated, maxOriginal };
}

/** Pack texts into batches respecting count limit and exact token limit. */
function packBatches(
  texts: string[],
  tokenCounts: number[],
  batchSize: number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]!;
    const tokens = tokenCounts[i]!;
    if (
      current.length >= batchSize ||
      (current.length > 0 && currentTokens + tokens > MAX_TOKENS_PER_BATCH)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
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
  // Step 1: truncate any doc that exceeds per-doc token limit.
  const { safe, truncated, maxOriginal } = truncateOverlong(texts);
  if (truncated > 0) {
    console.log(
      `  Truncated ${truncated}/${texts.length} docs to ${MAX_TOKENS_PER_DOC} tokens (max was ${maxOriginal})`,
    );
  }

  // Step 2: compute exact token counts once and pack batches.
  const tokenCounts = safe.map((t) => enc().encode(t).length);
  const batches = packBatches(safe, tokenCounts, batchSize);

  const all: number[][] = [];
  let cached = 0;
  let fetched = 0;

  for (const batch of batches) {
    const key = batchCacheKey(cachePrefix, batch);
    const hit = cache.get(key);
    if (hit) {
      all.push(...hit);
      cached += batch.length;
      continue;
    }
    const batchEmbeddings = await embedFn(batch);
    cache.set(key, batchEmbeddings);
    all.push(...batchEmbeddings);
    fetched += batch.length;
  }

  console.log(`  Embeddings: ${cached} cached, ${fetched} fetched from API`);
  return all;
}
