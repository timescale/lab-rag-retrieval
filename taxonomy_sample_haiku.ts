// Sample + tag with Claude Haiku via `claude -p`.
// Two-level taxonomy: category (broad) + techniques (specific named theorems).
import postgres from "postgres";

const SAMPLE_SPEC = [
  { tree: "aops", n: 62 },
  { tree: "math_train", n: 100 },
  { tree: "math_test", n: 60 },
  { tree: "theoremqa", n: 100 },
  { tree: "aqua", n: 40 },
  { tree: "camel", n: 40 },
  { tree: "gsm", n: 40 },
];

const CONCURRENCY = 10;
const TIMEOUT_MS = 60_000;

const PROMPT = (content: string) => `Tag this math text. Two-level output:
  category — ONE broad category (see list).
  techniques — 0-5 SPECIFIC named theorems / techniques / results (see seed list; invent new ones ONLY if none fit).
  setup_tags — 0-5 concrete-scenario tags (objects, structures, numbers).
  kind — what the chunk is (problem / solution / theorem / explainer / other).

CATEGORIES (pick ONE):
  algebra | number_theory | geometry | combinatorics | probability | calculus |
  analysis | linear_algebra | discrete_math | trigonometry | logic | other

TECHNIQUES seed list (prefer these names; lowercase_with_underscores):
  vieta_formulas, newtons_identities, frobenius_number, chicken_mcnugget,
  diophantine_equations, linear_diophantine, pell_equation,
  modular_arithmetic, chinese_remainder_theorem, fermats_little_theorem,
  eulers_theorem, eulers_totient, euclidean_algorithm, bezout_identity,
  prime_factorization, unique_factorization,
  pigeonhole, inclusion_exclusion, burnside_lemma, generating_functions,
  binomial_theorem, stars_and_bars, catalan_numbers, fibonacci_recurrence,
  characteristic_polynomial, linear_recurrence,
  am_gm_inequality, cauchy_schwarz, rearrangement_inequality, jensen_inequality,
  power_mean_inequality, triangle_inequality,
  mathematical_induction, strong_induction, well_ordering,
  polynomial_roots, symmetric_functions, rational_root_theorem,
  complex_roots_of_unity, factor_theorem, remainder_theorem,
  pythagorean_theorem, law_of_sines, law_of_cosines, stewarts_theorem,
  ptolemy_theorem, power_of_a_point, similar_triangles, mass_point,
  coordinate_geometry, angle_chasing, cyclic_quadrilateral,
  trigonometric_identities, double_angle, product_to_sum, de_moivre,
  expected_value, conditional_probability, bayes_theorem, linearity_of_expectation,
  combinatorial_probability, indicator_variables,
  limit_computation, lhopital, taylor_series, fundamental_theorem_of_calculus,
  integration_by_parts, substitution_integral, partial_fractions,
  epsilon_delta, cauchy_sequences, uniform_convergence,
  matrix_multiplication, eigenvalues, determinant, gaussian_elimination,
  group_theory, sylow_theorems, cyclic_groups, homomorphism, kernel_image,
  ring_theory, ideal_theory, field_extensions, galois_theory,
  basic_arithmetic, ratios_proportions, percentages, unit_conversion, word_problem_algebra

Output STRICT JSON (no prose) with schema:
{ "kind": "...", "category": "...", "techniques": [...], "setup_tags": [...] }

Chunk:
"""
${content.slice(0, 2000)}
"""

Answer with JSON only:`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    kind: { type: "string" },
    category: { type: "string" },
    techniques: { type: "array", items: { type: "string" } },
    setup_tags: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "category", "techniques", "setup_tags"],
});

async function tagWithHaiku(content: string): Promise<any> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(content),
    "--model", "haiku",
    "--output-format", "json",
    "--json-schema", SCHEMA,
  ], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timeout);
  try {
    const evts = JSON.parse(stdout);
    for (const evt of Array.isArray(evts) ? evts : [evts]) {
      if (evt.type === "result" && evt.structured_output) return evt.structured_output;
    }
    return { error: "no structured_output" };
  } catch (e: any) {
    return { error: e.message?.slice(0, 60) };
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const samples: Array<{ id: string; content: string; tree: string }> = [];
  for (const spec of SAMPLE_SPEC) {
    const rows = await sql.unsafe(
      `SELECT id, content, tree::text as tree FROM bright_aops WHERE tree::text = $1 ORDER BY random() LIMIT $2`,
      [spec.tree, spec.n],
    );
    samples.push(...(rows as any[]));
  }
  await sql.end({ timeout: 3 });
  console.log(`total samples: ${samples.length}`);

  const results: Array<any> = [];
  let done = 0;
  for (let i = 0; i < samples.length; i += CONCURRENCY) {
    const batch = samples.slice(i, i + CONCURRENCY);
    const tagged = await Promise.all(batch.map(async (s) => {
      const t = await tagWithHaiku(s.content);
      return { id: s.id, tree: s.tree, ...t };
    }));
    results.push(...tagged);
    done += batch.length;
    process.stdout.write(`tagged ${done}/${samples.length}\n`);
  }

  const techFreq = new Map<string, number>();
  const setupFreq = new Map<string, number>();
  const catFreq = new Map<string, number>();
  const kindFreq = new Map<string, number>();
  const techByTree = new Map<string, Map<string, number>>();
  let errs = 0;
  for (const r of results) {
    if (r.error) { errs++; continue; }
    kindFreq.set(r.kind, (kindFreq.get(r.kind) || 0) + 1);
    catFreq.set(r.category, (catFreq.get(r.category) || 0) + 1);
    for (const t of (r.techniques || [])) {
      techFreq.set(t, (techFreq.get(t) || 0) + 1);
      if (!techByTree.has(r.tree)) techByTree.set(r.tree, new Map());
      const m = techByTree.get(r.tree)!;
      m.set(t, (m.get(t) || 0) + 1);
    }
    for (const t of (r.setup_tags || [])) setupFreq.set(t, (setupFreq.get(t) || 0) + 1);
  }
  console.log(`\nErrors: ${errs}/${results.length}`);
  console.log(`\n=== KIND ===`); for (const [k,v] of [...kindFreq].sort((a,b)=>b[1]-a[1])) console.log(`  ${v}  ${k}`);
  console.log(`\n=== CATEGORY ===`); for (const [k,v] of [...catFreq].sort((a,b)=>b[1]-a[1])) console.log(`  ${v}  ${k}`);
  console.log(`\n=== TECHNIQUE (top 50) ===`);
  for (const [k,v] of [...techFreq].sort((a,b)=>b[1]-a[1]).slice(0,50)) console.log(`  ${v.toString().padStart(3)}  ${k}`);
  console.log(`\n=== SETUP (top 40) ===`);
  for (const [k,v] of [...setupFreq].sort((a,b)=>b[1]-a[1]).slice(0,40)) console.log(`  ${v.toString().padStart(3)}  ${k}`);
  console.log(`\n=== TECHNIQUE by tree (top 8) ===`);
  for (const [tree, m] of techByTree.entries()) {
    console.log(`  ${tree}:`);
    for (const [k,v] of [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`    ${v}  ${k}`);
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/taxonomy_haiku.json", JSON.stringify(results, null, 2));
  console.log(`\nSaved to /tmp/taxonomy_haiku.json`);
  process.exit(0);
}

main().catch(e => { console.error("failed:", e); process.exit(1); });
