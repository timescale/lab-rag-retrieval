// Spot-check: tag a few concept-cluster query/gold pairs with the calibrated
// taxonomy prompt. Does each pair share technique tags?
import postgres from "postgres";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 60_000;

const PROMPT = (content: string) => `You tag a mathematical text chunk for a retrieval system. Return strict JSON only.

Output schema:
{
  "is_math": boolean,
  "kind": "problem" | "solution" | "theorem" | "explainer" | "other",
  "category": <one category from the list below>,
  "techniques": [<0-5 specific techniques; prefer canonical labels from the list; add new labels ONLY for specific named theorems not in the list>],
  "setup_tags": [<0-5 free-form concrete-scenario tags; lowercase_with_underscores>]
}

CATEGORIES (pick ONE):
algebra | number_theory | geometry | combinatorics | probability | calculus |
analysis | linear_algebra | discrete_math | trigonometry | logic | other

TECHNIQUES (prefer these canonical labels):

Number theory:
  modular_arithmetic, prime_factorization, euclidean_algorithm,
  diophantine_equations, linear_diophantine, frobenius_number,
  chicken_mcnugget, fermats_little_theorem, eulers_totient,
  chinese_remainder_theorem, bezout_identity

Algebra / polynomial:
  polynomial_roots, vieta_formulas, factor_theorem, remainder_theorem,
  newtons_identities, symmetric_functions, rational_root_theorem,
  partial_fractions, simons_favorite_factoring_trick

Combinatorics:
  inclusion_exclusion, pigeonhole, stars_and_bars, binomial_theorem,
  catalan_numbers, multiplication_principle, burnside_lemma, generating_functions

Probability:
  expected_value, linearity_of_expectation, conditional_probability,
  combinatorial_probability, bayes_theorem, indicator_variables

Geometry:
  pythagorean_theorem, law_of_sines, law_of_cosines, power_of_a_point,
  similar_triangles, angle_chasing, mass_point, coordinate_geometry,
  shoelace_theorem, picks_theorem

Inequalities:
  am_gm_inequality, cauchy_schwarz, triangle_inequality, jensen_inequality

Sequences:
  linear_recurrence, fibonacci_recurrence, mathematical_induction,
  characteristic_polynomial

Trigonometry:
  trigonometric_identities, double_angle, product_to_sum, de_moivre

Calculus:
  limit_computation, taylor_series, fundamental_theorem_of_calculus,
  substitution_integral, integration_by_parts, lhopital, critical_points

Linear algebra:
  matrix_multiplication, determinant, eigenvalues, gaussian_elimination

Abstract algebra:
  group_theory, cyclic_groups, sylow_theorems, ring_theory, field_extensions,
  galois_theory, isomorphism

Elementary catch-alls (use only when NO specific technique fits):
  basic_arithmetic, word_problem_algebra, ratios_proportions, percentages,
  unit_conversion, counting, solving_equations

Rules:
- Prefer the most SPECIFIC technique that fits. Use elementary catch-alls only when the chunk is genuinely elementary.
- If the chunk uses Frobenius/Chicken-McNugget reasoning (which integers are NOT representable as a non-negative integer combination of fixed denominations), prefer "frobenius_number" over generic "diophantine_equations".
- If the chunk uses Newton's identities on polynomial roots, prefer "newtons_identities" over generic "polynomial_roots".
- setup_tags describe the CONCRETE scenario (objects, structures, constants).
- is_math: set to false for parsing artifacts / non-math content.

Output JSON only, no prose.

Chunk:
"""
${content.slice(0, 2500)}
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
    return { error: e.message?.slice(0, 80) };
  }
}

// Concept clusters to probe:
const CLUSTERS: Array<{ name: string; queryId: string; goldIds: string[] }> = [
  {
    name: "Frobenius/integer-combinations",
    queryId: "aops_2015_AMC_10B_Problems/Problem_15", // Hamlet ducks/horses
    goldIds: ["math_train_counting_and_probability_5024", "math_train_number_theory_7095"],
  },
  {
    name: "Newton's identities / polynomial root power sums",
    queryId: "aops_2019_AMC_12A_Problems/Problem_17", // sum of kth powers of x^3-5x^2+8x-13 roots
    goldIds: ["math_test_intermediate_algebra_1179", "math_train_intermediate_algebra_513"],
  },
  {
    name: "Quadratic Diophantine with prime pairs",
    queryId: "math_train_number_theory_839", // two primes between 4 and 18, product - sum
    goldIds: ["math_train_number_theory_7012", "aops_2008_AMC_12B_Problems/Problem_16"],
  },
];

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const lines = readFileSync("data/bright/aops/examples.jsonl", "utf-8").trim().split("\n");
  const exMap = new Map(lines.map(l => JSON.parse(l)).map((e: any) => [e.id, e]));

  for (const cluster of CLUSTERS) {
    console.log(`\n====== ${cluster.name} ======`);
    const ex = exMap.get(cluster.queryId) as any;
    const queryText = ex.query;

    // Tag the query itself
    console.log(`\n[QUERY: ${cluster.queryId}]`);
    console.log(`${queryText.slice(0, 180).replace(/\s+/g, ' ')}`);
    const queryTags = await tag(queryText);
    console.log(`→ category=${queryTags.category} | techniques=${JSON.stringify(queryTags.techniques)} | setup=${JSON.stringify(queryTags.setup_tags)}`);

    // Also tag each gold (take chunk 0 or 1 for brevity)
    for (const gid of cluster.goldIds) {
      const rows = await sql.unsafe(`SELECT content FROM bright_aops WHERE id = $1`, [gid]);
      if (rows.length === 0) { console.log(`[MISSING] ${gid}`); continue; }
      const c = (rows[0] as any).content;
      console.log(`\n[GOLD: ${gid}]`);
      console.log(`${c.slice(0, 180).replace(/\s+/g, ' ')}`);
      const t = await tag(c);
      console.log(`→ category=${t.category} | techniques=${JSON.stringify(t.techniques)} | setup=${JSON.stringify(t.setup_tags)}`);

      // Overlap with query
      const queryTechs = new Set(queryTags.techniques || []);
      const goldTechs = new Set(t.techniques || []);
      const sharedTech = [...queryTechs].filter(x => goldTechs.has(x));
      const queryCat = queryTags.category;
      const sharedCat = queryCat === t.category;
      console.log(`   OVERLAP: category-match=${sharedCat} | shared-techniques=${JSON.stringify(sharedTech)}`);
    }
  }
  await sql.end({ timeout: 3 });
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
