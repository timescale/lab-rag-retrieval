// Concept-cluster spot-check with gpt-4o-mini — same pairs as the Haiku check.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const PROMPT = (content: string) => `Tag this math chunk for retrieval. Output strict JSON only.

Schema:
{ "is_math": bool, "kind": "problem"|"solution"|"theorem"|"explainer"|"other", "category": <ONE>, "techniques": [<0-5 tags>], "setup_tags": [<0-5 free-form tags>] }

CATEGORIES: algebra|number_theory|geometry|combinatorics|probability|calculus|analysis|linear_algebra|discrete_math|trigonometry|logic|other

TECHNIQUES (prefer these canonical labels):
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
- setup_tags: lowercase_with_underscores.

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

async function tag(content: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "Return strict JSON only." }, { role: "user", content: PROMPT(content) }],
      response_format: { type: "json_object" },
      max_tokens: 250,
    }),
  });
  const data = await res.json() as any;
  return JSON.parse(data.choices[0].message.content);
}

const CLUSTERS = [
  { name: "Frobenius cluster", queryId: "aops_2015_AMC_10B_Problems/Problem_15", goldIds: ["math_train_counting_and_probability_5024", "math_train_number_theory_7095"] },
  { name: "Newton/Vieta cluster", queryId: "aops_2019_AMC_12A_Problems/Problem_17", goldIds: ["math_test_intermediate_algebra_1179", "math_train_intermediate_algebra_513"] },
  { name: "Simon's trick cluster", queryId: "math_train_number_theory_839", goldIds: ["math_train_number_theory_7012", "aops_2008_AMC_12B_Problems/Problem_16"] },
];

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const lines = readFileSync("data/bright/aops/examples.jsonl", "utf-8").trim().split("\n");
  const exMap = new Map(lines.map(l => JSON.parse(l)).map((e: any) => [e.id, e]));
  for (const c of CLUSTERS) {
    console.log(`\n=== ${c.name} ===`);
    const ex = exMap.get(c.queryId) as any;
    const qTags = await tag(ex.query);
    console.log(`QUERY ${c.queryId}`);
    console.log(`  cat=${qTags.category} tech=${JSON.stringify(qTags.techniques)}`);
    for (const gid of c.goldIds) {
      const rows = await sql.unsafe(`SELECT content FROM bright_aops WHERE id = $1`, [gid]);
      const gTags = await tag((rows[0] as any).content);
      const shared = (qTags.techniques || []).filter((x: string) => (gTags.techniques || []).includes(x));
      console.log(`GOLD ${gid}`);
      console.log(`  cat=${gTags.category} tech=${JSON.stringify(gTags.techniques)}`);
      console.log(`  OVERLAP: shared-tech=${JSON.stringify(shared)} cat-match=${qTags.category === gTags.category}`);
    }
  }
  await sql.end({timeout:3}); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
