// Per-doc concept sketches for the stackoverflow corpus, bridging
// user-symptom programming-question vocabulary ↔ canonical API
// reference vocabulary. Same recipe as the robotics v2 tagger:
// sonnet + structured scaffolding fields + worked examples.
//
// Stored in meta.sketch_v2 as a jsonb object. Resumable via file-cache
// (sha256 over PROMPT_VERSION + doc id + content) + WHERE-clause skip.

import postgres from "postgres";
import { createFileCache } from "./src/file-cache.ts";

const PROMPT_VERSION = "v1";
const cache = createFileCache<any>("data/sketch_cache_stackoverflow");

// Concurrency tuning history:
// - 20 → 12 → 4 → 2 on sonnet, all hit rate limits on the current
//   account (which has tighter RPM caps than the account that ran
//   robotics v2 sketches successfully at concurrency 20).
// - Switched to haiku for this domain: haiku has much higher RPM caps
//   and is the model used by both aops H7 sketches and robotics v1
//   sketches (both produced significant retrieval-recall wins). Back to
//   concurrency 16 on haiku.
const CONCURRENCY = 16;
const WORKER_STARTUP_STAGGER_MS = 500;

// Sustained-throttle abort: if this many consecutive transient 429s
// land, exit so wrapper can sleep ~1h. Kept as a safety net even on
// haiku in case caps tighten in the future.
const SUSTAINED_THROTTLE_THRESHOLD = 30;
const BATCH_COMMIT_EVERY = 200;
const TIMEOUT_MS = 180_000;

const PROMPT = (docId: string, content: string) => `You are extracting a CONCEPT FINGERPRINT from a chunk of a programming-library reference document. The retrieval corpus is the BRIGHT stackoverflow benchmark, where each query is a stuck-developer programming question (often with a story scenario, code snippet, framework keywords, and an error message) and gold is the OFFICIAL API REFERENCE for the underlying library function/class/method/dunder that solves the question.

The retrieval problem we are bridging: users describe problems using SYMPTOMS ("merging list-column dataframes", "pivot doesn't melt the way I want in Snowflake", "Pydantic class with multiple inheritance is recursing"), while doc chunks use CANONICAL API names (\`pd.merge\`, \`UNPIVOT\`, \`pydantic.PrivateAttr\`, \`__init_subclass__\`, \`Expression.list.set_intersection\`). Your sketch must contain BOTH vocabularies so a search from either side matches.

Fill these fields:
- library: the primary library/module/runtime/dialect (use the doc ID directory as the strongest hint — e.g. \`Python_pandas_functions\`, \`snowflake_docs\`, \`React_hook_adding_interactivity\`, \`linux_man_1\`, \`DBMS_LOB_LIBCACHE\`, \`spring_io\`).
- api: the specific function/class/method/dunder/SQL keyword/CLI flag this chunk describes (\`pd.merge\`, \`pandas.DataFrame.pivot_table\`, \`UNPIVOT\`, \`telebot.TeleBot.send_video\`, \`Object.create\`, \`useEffect\`, \`man find\`, \`__set_name__\`). If the chunk doesn't describe a specific API entry point (it's a navigation chunk, table of contents, header/footer, version note), leave this empty.
- purpose: 1-2 sentences describing what stuck-developer problem leads here, in user-symptom phrasing — what would a developer Google when they're trying to use this API or hit this bug. Use the everyday phrasing they'd actually type.
- canonical_terms: comma-separated function/class/method/parameter/keyword names the chunk actually uses (these are what a maintainer would search for).
- alternatives: comma-separated related APIs in the same library or different libraries that solve adjacent problems, or empty if none.
- sketch: 80-120 word lowercase paragraph combining all the above. No markdown. Both canonical names AND user-symptom phrases must appear naturally.

ONLY return empty fields if the chunk is genuinely empty, just navigation/footer/license-header text, a table-of-contents listing of links, a version banner, or a stub with no API content. When in doubt, write a sketch — API reference paragraphs ABOUT a function (parameters, return value, behavior) DO qualify even if they don't include the function signature line.

WORKED EXAMPLES.

Example 1 — pandas DataFrame.melt (Python API reference):
{
  "library": "Python_pandas_functions",
  "api": "pandas.DataFrame.melt",
  "purpose": "reshaping a wide DataFrame into a long one — users hit this when they have a table with many feature columns and want one row per (id, feature) pair, the inverse of pivot.",
  "canonical_terms": "pandas.DataFrame.melt, id_vars, value_vars, var_name, value_name, ignore_index, pd.melt, wide_to_long, stack, unstack",
  "alternatives": "pd.melt (top-level function), DataFrame.stack(), pd.wide_to_long, pivot, pivot_table for the inverse",
  "sketch": "pandas.DataFrame.melt method that unpivots a wide dataframe into a long-format dataframe with one row per (id, variable, value) tuple. user symptoms: turning many columns into rows, converting wide data to long for plotting, melting feature columns into a single tidy column. canonical parameters: id_vars (columns to keep as identifiers), value_vars (columns to unpivot), var_name (name of the resulting variable column), value_name (name of the resulting value column). related apis: pd.melt (top-level alias), DataFrame.stack() for the multi-index variant, pd.wide_to_long for prefix-based melting, pivot/pivot_table for the inverse operation."
}

Example 2 — Snowflake UNPIVOT (SQL keyword):
{
  "library": "snowflake_docs",
  "api": "UNPIVOT",
  "purpose": "rotating columns to rows in Snowflake SQL — users hit this when they have a wide table with many value columns and want to normalize it to (key, value) row pairs for joins or aggregation; this is Snowflake's equivalent of pandas.melt or SQL Server UNPIVOT.",
  "canonical_terms": "UNPIVOT, value_column, name_column, column_list, FROM clause, relational operator, INCLUDE NULLS, EXCLUDE NULLS, semi-structured FLATTEN",
  "alternatives": "PIVOT (inverse), FLATTEN for semi-structured/JSON unpivoting, LATERAL with array_construct, CROSS JOIN UNNEST in other dialects",
  "sketch": "Snowflake UNPIVOT relational operator that rotates columns into rows, the SQL equivalent of pandas melt. user symptoms: converting a wide table to a tall one in Snowflake, melting feature columns into key-value rows, normalizing reporting tables for grouping. canonical syntax: SELECT ... FROM t UNPIVOT(value_column FOR name_column IN (col_a, col_b, col_c)). controls null handling with INCLUDE NULLS / EXCLUDE NULLS. alternative approaches: PIVOT for the inverse, FLATTEN for json/array unpivoting, LATERAL VIEW EXPLODE in other dialects."
}

Example 3 — Python __set_name__ dunder (Python data model):
{
  "library": "python_descriptors_attribute",
  "api": "__set_name__",
  "purpose": "knowing the attribute name a descriptor or dataclass field was assigned to — users hit this when implementing a custom descriptor class and need to know its owner attribute name (e.g. for storing per-instance state keyed by attribute), or when debugging metaclass / dataclass field naming weirdness.",
  "canonical_terms": "__set_name__, __get__, __set__, __delete__, descriptor protocol, owner, name, dataclass field, class body assignment, dunder",
  "alternatives": "__init_subclass__ for class-creation hooks, type.__init_subclass__, abc.ABCMeta, attrs auto-naming",
  "sketch": "Python data model __set_name__ method on descriptor objects, called by the metaclass when the descriptor is assigned to a class attribute, with the owner class and the assigned attribute name as arguments. user symptoms: descriptor needs to know its attribute name, custom dataclass field implementations storing per-instance state, multiple descriptors with identical instances on the same class. canonical companions: __get__, __set__, __delete__ for the descriptor protocol. related apis: __init_subclass__ for class-creation hooks, ABCMeta for abstract base classes, attrs field auto-naming as alternative."
}

Doc ID:
${docId}

Chunk:
"""
${content.slice(0, 4000)}
"""`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    library: { type: "string" },
    api: { type: "string" },
    purpose: { type: "string" },
    canonical_terms: { type: "string" },
    alternatives: { type: "string" },
    sketch: { type: "string" },
  },
  required: ["library", "api", "purpose", "canonical_terms", "alternatives", "sketch"],
});

interface Sketched {
  library: string;
  api: string;
  purpose: string;
  canonical_terms: string;
  alternatives: string;
  sketch: string;
}

// Two distinct error shapes:
//   UsageCapError = anthropic 5-hour usage cap (fatal, sleep ~1h, retry)
//   TransientRateLimitError = server 429 / temporary throttle (per-query
//     retry inside generate(), only escalate if many consecutive)
class UsageCapError extends Error {}
class TransientRateLimitError extends Error {}

// 5-hour usage cap signature: phrasing about "usage limit" / "limit reached"
// / "5-hour" / "overage". Distinct from a server 429 throttle.
function looksLikeUsageCap(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("5-hour") ||
    t.includes("usage limit") ||
    t.includes("usage cap") ||
    t.includes("daily limit") ||
    t.includes("monthly limit") ||
    t.includes("overage") ||
    t.includes("plan limit") ||
    t.includes("quota exceeded") ||
    (t.includes("limit reached") && !t.includes("temporarily"))
  );
}

// Server-side temporary throttle (HTTP 429, "temporarily limiting", etc).
// Clears in seconds-to-minutes; should be retried per-query, not aborted.
function looksLikeTransient429(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("temporarily limiting") ||
    t.includes("api_error_status\":429") ||
    t.includes("\"status\":429") ||
    t.includes("429 too many requests") ||
    t.includes("rate limit") ||
    t.includes("rate_limit") ||
    t.includes("retry") && t.includes("429")
  );
}

async function generateOnce(docId: string, content: string): Promise<Sketched> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(docId, content),
    "--setting-sources", "project",
    "--model", "haiku",
    "--output-format", "json",
    "--json-schema", SCHEMA,
  ], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  // Only pattern-match for rate-limit signatures on ERROR paths.
  // Previously checked stdout+stderr unconditionally — false-positived
  // when the model's successful sketch text mentioned words like "plan
  // limit" or "overage" (e.g. when summarizing a doc ABOUT rate limiting).
  // Stderr is rate-limit-relevant; stdout is only checked when is_error=true.
  if (stderr && looksLikeUsageCap(stderr)) {
    throw new UsageCapError(`usage-cap (stderr): ${stderr.slice(0, 200)}`);
  }
  if (exitCode !== 0) {
    const msg = (stderr || stdout).slice(0, 500);
    if (looksLikeTransient429(msg)) throw new TransientRateLimitError(`429: ${msg.slice(0, 150)}`);
    throw new Error(`claude exit ${exitCode}: ${msg.slice(0, 200)}`);
  }

  try {
    const evts = JSON.parse(stdout);
    for (const evt of Array.isArray(evts) ? evts : [evts]) {
      // result event with is_error=true and api_error_status=429 is the
      // typical transient throttle path even when exit code was 0.
      if (evt.type === "result" && evt.is_error === true) {
        const text = JSON.stringify(evt).slice(0, 1000);
        if (looksLikeUsageCap(text)) throw new UsageCapError(`usage-cap in result: ${text.slice(0, 200)}`);
        if (looksLikeTransient429(text)) throw new TransientRateLimitError(`429 in result: ${text.slice(0, 150)}`);
      }
      if (evt.type === "result" && evt.structured_output) {
        const out = evt.structured_output as any;
        return {
          library: typeof out.library === "string" ? out.library : "",
          api: typeof out.api === "string" ? out.api : "",
          purpose: typeof out.purpose === "string" ? out.purpose : "",
          canonical_terms: typeof out.canonical_terms === "string" ? out.canonical_terms : "",
          alternatives: typeof out.alternatives === "string" ? out.alternatives : "",
          sketch: typeof out.sketch === "string" ? out.sketch : "",
        };
      }
    }
    throw new Error("no structured_output");
  } catch (e: any) {
    if (e instanceof UsageCapError) throw e;
    if (e instanceof TransientRateLimitError) throw e;
    throw new Error(e.message?.slice(0, 200) || "parse error");
  }
}

// Per-query retry on transient 429: short exponential backoff. Fatal usage
// cap or 4 consecutive 429s on the same doc throws back to the worker.
async function generate(docId: string, content: string): Promise<Sketched> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await generateOnce(docId, content);
    } catch (e: any) {
      if (e instanceof UsageCapError) throw e; // fatal, escalate immediately
      if (e instanceof TransientRateLimitError) {
        lastErr = e;
        if (attempt < 4) {
          const sleepMs = 5000 * attempt + Math.floor(Math.random() * 2000);
          await new Promise(r => setTimeout(r, sleepMs));
          continue;
        }
        throw e; // 4 consecutive 429s → give up on this doc, treated as transient by worker
      }
      throw e; // other error → no retry
    }
  }
  throw lastErr ?? new Error("unreachable");
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30, max: 5 });

  const countRow = await sql.unsafe(
    `SELECT count(*)::int as c FROM bright_stackoverflow
     WHERE NOT (coalesce(meta, '{}'::jsonb) ? 'sketch_v2')`,
  );
  const remaining = (countRow[0] as any).c;
  console.log(`rows to process (missing meta.sketch_v2): ${remaining}`);
  if (remaining === 0) { await sql.end(); return; }

  const t0 = Date.now();
  let done = 0, errs = 0, lastLog = 0;
  let pendingUpdates: Array<{ id: string; data: Sketched }> = [];
  // Set when ANY worker encounters a rate-limit error. All workers check
  // this on each iteration and exit so the wrapper script can sleep+restart.
  let rateLimitedAbort = false;
  let rateLimitMessage = "";
  // Tracks consecutive transient 429s across all workers; reset on any
  // successful tag (or cache hit). When it crosses
  // SUSTAINED_THROTTLE_THRESHOLD we abort the whole tagger so the wrapper
  // can sleep ~1h for the rolling-window quota to clear.
  let consecutive429 = 0;

  async function commitBatch() {
    if (pendingUpdates.length === 0) return;
    await Promise.all(pendingUpdates.map(({ id, data }) =>
      sql.unsafe(
        `UPDATE bright_stackoverflow
         SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('sketch_v2', $1::text::jsonb)
         WHERE id = $2`,
        [JSON.stringify(data), id],
      ),
    ));
    pendingUpdates = [];
  }

  const PAGE = 2000;
  async function* rowStream() {
    while (true) {
      if (rateLimitedAbort) return;
      const rows = await sql.unsafe(`
        SELECT id, content FROM bright_stackoverflow
        WHERE NOT (coalesce(meta, '{}'::jsonb) ? 'sketch_v2')
        ORDER BY id LIMIT $1
      `, [PAGE]) as any[];
      if (rows.length === 0) return;
      for (const r of rows) {
        if (rateLimitedAbort) return;
        yield r;
      }
    }
  }

  const iter = rowStream()[Symbol.asyncIterator]();
  async function worker() {
    while (true) {
      if (rateLimitedAbort) return;
      const { value: r, done: d } = await iter.next();
      if (d) return;
      const key = cache.key(PROMPT_VERSION, r.id, r.content);
      let data = cache.get(key) as Sketched | null;
      let isFailure = false;
      if (data === null) {
        try {
          data = await generate(r.id, r.content);
          cache.set(key, data);
          consecutive429 = 0; // success — reset throttle streak
        } catch (e: any) {
          isFailure = true;
          errs++;
          if (e instanceof UsageCapError) {
            // Fatal: signal all workers to stop. Don't write this row to DB.
            if (!rateLimitedAbort) {
              rateLimitedAbort = true;
              rateLimitMessage = e.message;
              console.error(`\n!!! USAGE CAP HIT: ${e.message.slice(0, 200)}`);
              console.error(`!!! Aborting tagger. Wrapper should sleep ~1h and restart.`);
            }
            return;
          }
          if (e instanceof TransientRateLimitError) {
            consecutive429++;
            if (consecutive429 >= SUSTAINED_THROTTLE_THRESHOLD && !rateLimitedAbort) {
              rateLimitedAbort = true;
              rateLimitMessage = `sustained throttle: ${consecutive429} consecutive 429s`;
              console.error(`\n!!! SUSTAINED THROTTLE: ${consecutive429} consecutive 429s. Aborting tagger; wrapper should sleep ~1h.`);
              return;
            }
          } else {
            // Other transient: reset counter (a single non-429 failure isn't a throttle signal)
            consecutive429 = 0;
          }
          if (errs % 50 === 1) {
            console.error(`  transient err on ${r.id}: ${e.message?.slice(0, 120)}`);
          }
        }
      } else {
        // Cache hit — counts as productive, reset streak
        consecutive429 = 0;
      }
      // Only persist the row when we have a real sketch (success or
      // cache-hit). Transient failures leave the row in the pool for retry.
      if (!isFailure && data) {
        pendingUpdates.push({ id: r.id, data });
        if (pendingUpdates.length >= BATCH_COMMIT_EVERY) await commitBatch();
      }
      done++;
      if (done - lastLog >= 200) {
        lastLog = done;
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = (remaining - done) / rate;
        process.stdout.write(`  sketched ${done}/${remaining} (${rate.toFixed(2)}/s, ETA ${(eta/60).toFixed(1)}min, errs ${errs})\n`);
      }
    }
  }

  // Stagger worker startup
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push((async () => {
      if (i > 0) await new Promise(r => setTimeout(r, i * WORKER_STARTUP_STAGGER_MS));
      return worker();
    })());
  }
  await Promise.all(workers);
  await commitBatch();

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`done: ${done} sketched in ${(elapsed/60).toFixed(1)}min, ${errs} errors`);
  await sql.end({ timeout: 5 });

  // Exit code: 2 if we aborted due to rate limit (wrapper should sleep + retry),
  // 0 if we processed all rows or hit only transient errors, 1 otherwise.
  if (rateLimitedAbort) {
    console.error(`exiting with code 2 (rate-limit) — wrapper should sleep ~1h and restart`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => { console.error("failed:", e); process.exit(1); });
