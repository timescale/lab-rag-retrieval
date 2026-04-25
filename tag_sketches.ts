// H7: Generate per-doc scenario-stripped concept sketches.
//
// Goal: bridge concept-equivalent docs that have surface-disjoint vocabulary.
// E.g. a "rectangle painted with border" problem and a "two primes product
// minus sum" problem both use Simon's Favorite Factoring Trick (SFFT) but
// share zero surface words. Pure embedding/BM25 puts them 1000-7000 ranks
// apart. The sketch is a short abstract description in canonical
// math vocabulary that BOTH would generate, so they cluster in
// sketch-embedding space and BM25-on-sketch.
//
// Sketch format: 1-3 sentences, ~50-80 words, scenario-free. Three parts:
// 1) What the problem ASKS (in scenario-free terms)
// 2) Which named technique APPLIES
// 3) The critical INTERMEDIATE FORM that arises
//
// Stored in `meta.sketch: string`. Resumable: skips docs already sketched.

import postgres from "postgres";
import { createFileCache } from "./src/file-cache.ts";

const PROMPT_VERSION = "v1";
const cache = createFileCache<any>("data/sketch_cache");

const CONCURRENCY = 20;
const BATCH_COMMIT_EVERY = 200;
const TIMEOUT_MS = 90_000;

const USEFUL_TREE_PATTERN = "aops|math_test|math_train|theoremqa";

const PROMPT = (content: string) => `You are extracting a CONCEPT FINGERPRINT from a math problem or solution.

Goal: a short, abstract description that two different problems sharing the same solution technique would BOTH generate. Strip scenario-specific words (rectangles, primes, dice, etc.) — use only canonical mathematical vocabulary.

Output strict JSON:
{
  "sketch": "<2-3 sentences, ~50-80 words>"
}

The sketch must include:
1) WHAT IS ASKED, abstractly: e.g. "count integer pairs (a,b) satisfying a multiplicative constraint", "find the units digit of a sum of factorials", "compute a geometric probability via complementary counting".
2) WHICH TECHNIQUE: name the canonical technique by name. Examples: "Simon's Favorite Factoring Trick", "Vieta's formulas", "Frobenius / Chicken McNugget", "Newton's identities", "inclusion-exclusion", "modular arithmetic mod a prime", "pigeonhole", "complementary counting", "Pythagorean theorem".
3) INTERMEDIATE FORM: the equation form or mathematical structure that arises during the solution, e.g. "(x-c)(y-d) = K with K factorable", "p^a divides n!", "sum of binomial coefficients with alternating signs", "Markov chain steady-state".

Rules:
- 50-80 words total.
- Use abstract vocabulary. AVOID concrete nouns from the chunk (rectangle, dice, prime, AIME, etc.). Replace with abstract substitutes (two-variable equation, random selection, problem with given parameter, competition problem).
- Use lowercase. No LaTeX. No markdown.
- If the chunk is not a math problem/solution (e.g. malformed, or grade-school arithmetic), output {"sketch": ""}.

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: { sketch: { type: "string" } },
  required: ["sketch"],
});

async function generate(content: string): Promise<string> {
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
        return typeof out.sketch === "string" ? out.sketch : "";
      }
    }
    throw new Error("no structured_output");
  } catch (e: any) {
    throw new Error(e.message?.slice(0, 80) || "parse error");
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max: 5, idle_timeout: 30 });

  const countRow = await sql.unsafe(
    `SELECT count(*)::int as c FROM bright_aops
     WHERE meta IS NOT NULL AND meta ? 'techniques'
       AND NOT (meta ? 'sketch')
       AND tree ~ $1::lquery`,
    [USEFUL_TREE_PATTERN],
  );
  const remaining = (countRow[0] as any).c;
  console.log(`rows to process: ${remaining}`);
  if (remaining === 0) { await sql.end(); return; }

  const t0 = Date.now();
  let done = 0, errs = 0, lastLog = 0;
  let pendingUpdates: Array<{ id: string; sketch: string }> = [];

  async function commitBatch() {
    if (pendingUpdates.length === 0) return;
    await Promise.all(pendingUpdates.map(({ id, sketch }) =>
      sql.unsafe(
        `UPDATE bright_aops
         SET meta = meta || jsonb_build_object('sketch', $1::text)
         WHERE id = $2`,
        [sketch, id],
      ),
    ));
    pendingUpdates = [];
  }

  const PAGE = 2000;
  async function* rowStream() {
    while (true) {
      const rows = await sql.unsafe(`
        SELECT id, content FROM bright_aops
        WHERE meta IS NOT NULL AND meta ? 'techniques'
          AND NOT (meta ? 'sketch')
          AND tree ~ $1::lquery
        ORDER BY id LIMIT $2
      `, [USEFUL_TREE_PATTERN, PAGE]) as any[];
      if (rows.length === 0) return;
      for (const r of rows) yield r;
    }
  }

  const iter = rowStream()[Symbol.asyncIterator]();
  async function worker() {
    while (true) {
      const { value: r, done: d } = await iter.next();
      if (d) return;
      const key = cache.key(PROMPT_VERSION, r.content);
      let sketch = cache.get(key);
      if (sketch === null) {
        try {
          sketch = await generate(r.content);
          cache.set(key, sketch);
        } catch (e: any) {
          errs++;
          sketch = "";
        }
      }
      pendingUpdates.push({ id: r.id, sketch });
      if (pendingUpdates.length >= BATCH_COMMIT_EVERY) await commitBatch();
      done++;
      if (done - lastLog >= 200) {
        lastLog = done;
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = (remaining - done) / rate;
        process.stdout.write(`  sketched ${done}/${remaining} (${rate.toFixed(2)}/s, ETA ${(eta/60).toFixed(1)}min, errs ${errs})\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await commitBatch();

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`done: ${done} sketched in ${(elapsed/60).toFixed(1)}min, ${errs} errors`);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch(e => { console.error("failed:", e); process.exit(1); });
