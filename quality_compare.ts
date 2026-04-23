// Compare gpt-4o-mini (calibrated prompt) vs Haiku (already-tagged entries
// from the partial run) on the same 20 aops chunks.
import postgres from "postgres";

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
- Newton's identities → "newtons_identities" (NOT generic "polynomial_roots").
- setup_tags: lowercase_with_underscores concrete-scenario tags.

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

async function tagGpt(content: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "Return strict JSON, nothing else." }, { role: "user", content: PROMPT(content) }],
      response_format: { type: "json_object" },
      max_tokens: 250,
    }),
  });
  const data = await res.json() as any;
  return JSON.parse(data.choices[0].message.content);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  // Sample 20 already-tagged entries (Haiku output is in meta)
  const rows = await sql.unsafe(`SELECT id, content, meta FROM bright_aops WHERE meta IS NOT NULL AND NOT (meta ? 'error') ORDER BY random() LIMIT 20`);
  console.log(`comparing ${rows.length} chunks Haiku vs gpt-4o-mini\n`);
  let techMatches = 0, techPartial = 0, techDiff = 0;
  let catMatches = 0;
  for (const r of rows as any[]) {
    const haiku = r.meta;
    const gpt = await tagGpt(r.content);
    const hT = new Set(haiku.techniques || []);
    const gT = new Set(gpt.techniques || []);
    const shared = [...hT].filter(x => gT.has(x));
    const rating = shared.length === 0 ? "diff" : shared.length === hT.size && shared.length === gT.size ? "match" : "partial";
    if (rating === "match") techMatches++; else if (rating === "partial") techPartial++; else techDiff++;
    if (haiku.category === gpt.category) catMatches++;
    console.log(`[${rating}] ${r.id.slice(0,50)}`);
    console.log(`  haiku: cat=${haiku.category} tech=${JSON.stringify(haiku.techniques)}`);
    console.log(`  gpt:   cat=${gpt.category} tech=${JSON.stringify(gpt.techniques)}`);
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`techniques: match=${techMatches} partial=${techPartial} diff=${techDiff} (of ${rows.length})`);
  console.log(`category match: ${catMatches}/${rows.length}`);
  await sql.end({timeout:3}); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
