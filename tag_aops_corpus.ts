// Tag all 188k bright_aops chunks with category + technique + setup_tags.
// Writes structured classifications into the jsonb `meta` column.
//
// =============================================================================
// HOW THIS TAXONOMY WAS DEVELOPED
// =============================================================================
// The technique vocabulary below was NOT hand-crafted from prior knowledge. It
// was derived empirically from the corpus in three iterations:
//
// 1. Strawman taxonomy. Wrote an initial list of ~20 techniques drawn from
//    general competition-math knowledge (Vieta, Newton, Frobenius, pigeonhole,
//    etc.). Rejected as probably incomplete and not corpus-calibrated.
//
// 2. First empirical sample (442 chunks, gpt-4o-mini, stratified across the
//    7 tree sources: aops/math_test/math_train/theoremqa/aqua/camel/gsm).
//    Output was TOO COARSE — the model preferred broad categories ("algebra",
//    "combinatorics", "basic_arithmetic") over specific named theorems.
//    Frobenius/Newton's/Diophantine had 0 hits in the top-40.
//
// 3. Second sample (same 442 chunks, Claude Haiku, richer prompt with seed
//    vocabulary + explicit rule "prefer specific techniques over generic
//    categories"). The specific named techniques emerged: modular_arithmetic
//    (30), prime_factorization (23), pythagorean_theorem (15), power_of_a_point
//    (7), diophantine_equations (6), vieta_formulas (6), fermats_little_theorem
//    (5), simons_favorite_factoring_trick (3), picks_theorem (2), etc.
//    Saved to /tmp/taxonomy_haiku.json.
//
// 4. Validation via spot-check: tagged 3 concept-cluster query/gold pairs
//    known from prior failure analysis (Frobenius: Hamlet/bricks/stamps;
//    Newton's: polynomial-roots cluster; Simon's favorite factoring trick
//    cluster). Result: 5/6 gold chunks shared a specific technique tag with
//    their query. Cluster 1 and 3 were perfect; cluster 2 had sibling problems
//    using genuinely different techniques (Newton's vs Vieta vs remainder
//    theorem). The taxonomy won't bridge every cluster but captures most.
//
// Full details: see experimental_log_bright.md.
//
// Production tagging uses Claude Haiku via `claude -p` subprocess (same model
// that produced the validated sample). Slower wall time than an HTTP API
// because of subprocess spawn overhead, but we trade speed for fidelity —
// the concept-cluster validation was done on Haiku, not gpt-4o-mini.
// Expect ~6-10 hours at concurrency 20 for 188k chunks; resumable.
// =============================================================================

import postgres from "postgres";
import { createFileCache } from "./src/file-cache.ts";

// Bump PROMPT_VERSION when the PROMPT() definition changes meaningfully so we
// re-tag rather than return stale cached tags.
const PROMPT_VERSION = "v1";
const cache = createFileCache<any>("data/tag_cache");

const CONCURRENCY = 20;
const BATCH_COMMIT_EVERY = 200;
const TIMEOUT_MS = 90_000;

// We only tag the "useful" sources (aops / math_test / math_train / theoremqa).
// aqua / camel / gsm are already filterable via the tree column; tagging them
// is wasteful (they're rarely gold and dominate corpus volume).
const USEFUL_TREE_PATTERN = "aops|math_test|math_train|theoremqa";

// Prompt with empirically-calibrated seed vocabulary from the sample pass.
const PROMPT = (content: string) => `Tag this math chunk for retrieval. Output strict JSON only.

Schema:
{
  "is_math": bool,
  "kind": "problem"|"solution"|"theorem"|"explainer"|"other",
  "category": <ONE category>,
  "techniques": [<0-5 tags; prefer canonical labels; add new ONLY for specific named theorems>],
  "setup_tags": [<0-5 free-form concrete-scenario tags; lowercase_with_underscores>]
}

CATEGORIES: algebra|number_theory|geometry|combinatorics|probability|calculus|analysis|linear_algebra|discrete_math|trigonometry|logic|other

TECHNIQUES (prefer these):
  Number theory: modular_arithmetic, prime_factorization, euclidean_algorithm, diophantine_equations, linear_diophantine, frobenius_number, chicken_mcnugget, fermats_little_theorem, eulers_totient, chinese_remainder_theorem, bezout_identity
  Algebra: polynomial_roots, vieta_formulas, factor_theorem, remainder_theorem, newtons_identities, symmetric_functions, rational_root_theorem, partial_fractions, simons_favorite_factoring_trick
  Combinatorics: inclusion_exclusion, pigeonhole, stars_and_bars, binomial_theorem, catalan_numbers, multiplication_principle, burnside_lemma, generating_functions
  Probability: expected_value, linearity_of_expectation, conditional_probability, combinatorial_probability, bayes_theorem, indicator_variables
  Geometry: pythagorean_theorem, law_of_sines, law_of_cosines, power_of_a_point, similar_triangles, angle_chasing, mass_point, coordinate_geometry, shoelace_theorem, picks_theorem
  Inequalities: am_gm_inequality, cauchy_schwarz, triangle_inequality, jensen_inequality
  Sequences: linear_recurrence, fibonacci_recurrence, mathematical_induction, characteristic_polynomial
  Trigonometry: trigonometric_identities, double_angle, product_to_sum, de_moivre
  Calculus: limit_computation, taylor_series, fundamental_theorem_of_calculus, substitution_integral, integration_by_parts, lhopital, critical_points
  Linear algebra: matrix_multiplication, determinant, eigenvalues, gaussian_elimination
  Abstract algebra: group_theory, cyclic_groups, sylow_theorems, ring_theory, field_extensions, galois_theory, isomorphism
  Catch-alls (use ONLY when no specific technique fits): basic_arithmetic, word_problem_algebra, ratios_proportions, percentages, unit_conversion, counting, solving_equations

Rules:
- Prefer the MOST SPECIFIC technique; use catch-alls only for genuinely elementary content.
- Frobenius/Chicken-McNugget reasoning → "frobenius_number" (NOT generic "diophantine_equations").
- Newton's identities on polynomial roots → "newtons_identities" (NOT generic "polynomial_roots").
- setup_tags describe concrete scenario (objects, structures, constants).

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    is_math: { type: "boolean" },
    kind: { type: "string" },
    category: { type: "string" },
    techniques: { type: "array", items: { type: "string" } },
    setup_tags: { type: "array", items: { type: "string" } },
  },
  required: ["is_math", "kind", "category", "techniques", "setup_tags"],
});

async function tag(content: string): Promise<any> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(content),
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
      if (evt.type === "result" && evt.structured_output) return evt.structured_output;
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

  // Resumable + scoped to useful sources only.
  const countRow = await sql.unsafe(
    `SELECT count(*)::int as c FROM bright_aops WHERE meta IS NULL AND tree ~ $1::lquery`,
    [USEFUL_TREE_PATTERN],
  );
  const remaining = (countRow[0] as any).c;
  console.log(`rows to tag: ${remaining}`);
  if (remaining === 0) { await sql.end(); return; }

  const t0 = Date.now();
  let done = 0, errs = 0;
  let pendingUpdates: Array<{ id: string; meta: any }> = [];

  async function commitBatch() {
    if (pendingUpdates.length === 0) return;
    // Do updates in parallel, one query per row.
    await Promise.all(pendingUpdates.map(({ id, meta }) =>
      // Pass stringified JSON and cast; postgres.js would bind an object as
      // multiple params, and a double-stringify stores it as a jsonb string
      // literal rather than object. `::jsonb` on a stringified JSON parses to
      // the intended object.
      sql.unsafe(`UPDATE bright_aops SET meta = $1::text::jsonb WHERE id = $2`, [JSON.stringify(meta), id]),
    ));
    pendingUpdates = [];
  }

  // Stream rows page by page (cursor would be cleaner; fetch in chunks)
  const PAGE = 2000;
  while (true) {
    const rows = await sql.unsafe(`
      SELECT id, content FROM bright_aops
      WHERE meta IS NULL AND tree ~ $1::lquery
      ORDER BY id LIMIT $2
    `, [USEFUL_TREE_PATTERN, PAGE]) as any[];
    if (rows.length === 0) break;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const tagged = await Promise.all(batch.map(async (r) => {
        const key = cache.key(PROMPT_VERSION, r.content);
        const cached = cache.get(key);
        if (cached) return { id: r.id, meta: cached };
        try {
          const m = await tag(r.content);
          cache.set(key, m);
          return { id: r.id, meta: m };
        } catch (e: any) {
          errs++;
          return { id: r.id, meta: { error: e.message?.slice(0, 60) } };
        }
      }));
      pendingUpdates.push(...tagged);
      if (pendingUpdates.length >= BATCH_COMMIT_EVERY) await commitBatch();
      done += batch.length;
      if (done % 500 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = (remaining - done) / rate;
        process.stdout.write(`  tagged ${done}/${remaining} (${rate.toFixed(1)}/s, ETA ${(eta/60).toFixed(1)}min, errs ${errs})\n`);
      }
    }
  }
  await commitBatch();

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`done: ${done} tagged in ${(elapsed/60).toFixed(1)}min, ${errs} errors`);

  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch(e => { console.error("failed:", e); process.exit(1); });
