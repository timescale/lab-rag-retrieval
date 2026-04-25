// H3: Generate 3-5 pseudo-queries per useful aops chunk.
//
// For each doc in the "useful" sources (aops/math_test/math_train/theoremqa),
// ask Haiku to produce 3-5 natural-language questions that the doc could be
// the answer/reference for. Store as `meta.pseudo_queries: string[]`.
//
// Purpose: the pseudo_queries are concatenated into a search_content column
// (separate from content), indexed with BM25. User queries that look like
// "find integer solutions to ... via SFFT" will match the pseudo_queries
// for docs that demonstrate SFFT without repeating the problem-statement
// boilerplate. Corpus-side expansion, as described in H3 in
// hypothesis-to-test.md.
//
// Resumable: skips docs whose meta already contains pseudo_queries.

import postgres from "postgres";
import { createFileCache } from "./src/file-cache.ts";

const PROMPT_VERSION = "v1";
const cache = createFileCache<any>("data/pseudo_query_cache");

const CONCURRENCY = 20;
const BATCH_COMMIT_EVERY = 200;
const TIMEOUT_MS = 90_000;

const USEFUL_TREE_PATTERN = "aops|math_test|math_train|theoremqa";

const PROMPT = (content: string) => `You are generating SEARCH QUERIES for a mathematical competition-problem retrieval system.

Given the chunk below (a problem, solution, or theorem), produce 3-5 diverse natural-language queries that a student or problem solver could type to find THIS chunk via a search engine. Each query should describe a problem scenario, concept, or technique the chunk illustrates — in the user's own words, NOT a verbatim extraction from the chunk.

Aim for DIVERSITY: different phrasings, different angles (technique-focused, scenario-focused, specific-values-focused), different vocabulary. If the chunk uses a named theorem (Vieta, Newton, Frobenius, SFFT, pigeonhole, etc.), include at least one query mentioning it by name.

Output strict JSON only, matching this schema:
{
  "queries": ["<query 1>", "<query 2>", "<query 3>", ...]
}

Rules:
- 3 to 5 queries.
- Each 8-30 words.
- No LaTeX or special characters — plain English and numbers.
- Lowercase; questions don't need trailing "?".
- If the chunk has no math content or is malformed, return {"queries": []}.

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" } },
  },
  required: ["queries"],
});

async function generate(content: string): Promise<string[]> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(content),
    "--setting-sources", "project",
    "--model", "haiku",
    "--output-format", "json",
    "--json-schema", SCHEMA,
  ], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  try {
    const evts = JSON.parse(stdout);
    for (const evt of Array.isArray(evts) ? evts : [evts]) {
      if (evt.type === "result" && evt.structured_output) {
        const out = evt.structured_output as any;
        if (Array.isArray(out.queries)) return out.queries.slice(0, 5);
      }
    }
    throw new Error("no structured_output");
  } catch (e: any) {
    throw new Error(e.message?.slice(0, 80) || "parse error");
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {},
    max: 5,
    idle_timeout: 30,
  });

  // Only process docs that already have technique meta but NOT pseudo_queries.
  const countRow = await sql.unsafe(
    `SELECT count(*)::int as c FROM bright_aops
     WHERE meta IS NOT NULL
       AND meta ? 'techniques'
       AND NOT (meta ? 'pseudo_queries')
       AND tree ~ $1::lquery`,
    [USEFUL_TREE_PATTERN],
  );
  const remaining = (countRow[0] as any).c;
  console.log(`rows to process: ${remaining}`);
  if (remaining === 0) { await sql.end(); return; }

  const t0 = Date.now();
  let done = 0, errs = 0;
  let pendingUpdates: Array<{ id: string; queries: string[] }> = [];

  async function commitBatch() {
    if (pendingUpdates.length === 0) return;
    await Promise.all(pendingUpdates.map(({ id, queries }) =>
      sql.unsafe(
        `UPDATE bright_aops
         SET meta = meta || jsonb_build_object('pseudo_queries', $1::text::jsonb)
         WHERE id = $2`,
        [JSON.stringify(queries), id],
      ),
    ));
    pendingUpdates = [];
  }

  // Worker pool: keep CONCURRENCY workers continuously busy rather than
  // batch-then-await (which stalls on the slowest of each batch).
  const PAGE = 2000;
  async function* rowStream() {
    while (true) {
      const rows = await sql.unsafe(`
        SELECT id, content FROM bright_aops
        WHERE meta IS NOT NULL
          AND meta ? 'techniques'
          AND NOT (meta ? 'pseudo_queries')
          AND tree ~ $1::lquery
        ORDER BY id LIMIT $2
      `, [USEFUL_TREE_PATTERN, PAGE]) as any[];
      if (rows.length === 0) return;
      for (const r of rows) yield r;
    }
  }

  const iter = rowStream()[Symbol.asyncIterator]();
  let lastLog = 0;

  async function worker() {
    while (true) {
      const { value: r, done: d } = await iter.next();
      if (d) return;
      const key = cache.key(PROMPT_VERSION, r.content);
      let queries = cache.get(key);
      if (!queries) {
        try {
          queries = await generate(r.content);
          cache.set(key, queries);
        } catch (e: any) {
          errs++;
          queries = [];
        }
      }
      pendingUpdates.push({ id: r.id, queries });
      if (pendingUpdates.length >= BATCH_COMMIT_EVERY) await commitBatch();
      done++;
      if (done - lastLog >= 200) {
        lastLog = done;
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = (remaining - done) / rate;
        process.stdout.write(`  tagged ${done}/${remaining} (${rate.toFixed(2)}/s, ETA ${(eta/60).toFixed(1)}min, errs ${errs})\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await commitBatch();

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`done: ${done} tagged in ${(elapsed/60).toFixed(1)}min, ${errs} errors`);

  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch(e => { console.error("failed:", e); process.exit(1); });
