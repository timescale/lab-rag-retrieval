// Canonical technique + category taxonomy for the aops/theoremqa_questions
// blended math corpus. Derived empirically (see tag_aops_corpus.ts header for
// how). Imported by both the MCP tool description and the math prompt so the
// agent sees the same vocabulary everywhere.

export const CANONICAL_TECHNIQUES = [
  // Number theory
  "frobenius_number", "chicken_mcnugget",
  "modular_arithmetic", "prime_factorization", "euclidean_algorithm",
  "diophantine_equations", "linear_diophantine",
  "fermats_little_theorem", "eulers_totient", "chinese_remainder_theorem",
  "bezout_identity",
  // Algebra / polynomial
  "polynomial_roots", "vieta_formulas", "newtons_identities",
  "factor_theorem", "remainder_theorem", "symmetric_functions",
  "rational_root_theorem", "partial_fractions",
  "simons_favorite_factoring_trick",
  // Combinatorics
  "inclusion_exclusion", "pigeonhole", "stars_and_bars",
  "binomial_theorem", "catalan_numbers", "multiplication_principle",
  "burnside_lemma", "generating_functions",
  // Probability
  "expected_value", "linearity_of_expectation", "conditional_probability",
  "combinatorial_probability", "bayes_theorem", "indicator_variables",
  // Geometry
  "pythagorean_theorem", "law_of_sines", "law_of_cosines",
  "power_of_a_point", "similar_triangles", "angle_chasing",
  "mass_point", "coordinate_geometry", "shoelace_theorem",
  "picks_theorem",
  // Inequalities
  "am_gm_inequality", "cauchy_schwarz", "triangle_inequality",
  "jensen_inequality",
  // Sequences
  "linear_recurrence", "fibonacci_recurrence", "mathematical_induction",
  "characteristic_polynomial",
  // Trigonometry
  "trigonometric_identities", "double_angle", "product_to_sum", "de_moivre",
  // Calculus
  "limit_computation", "fundamental_theorem_of_calculus",
  "substitution_integral", "integration_by_parts", "lhopital",
  "critical_points", "taylor_series",
  // Linear algebra
  "matrix_multiplication", "determinant", "eigenvalues",
  "gaussian_elimination",
  // Abstract algebra
  "group_theory", "cyclic_groups", "sylow_theorems",
  // Catch-alls (use ONLY when no specific technique fits)
  "basic_arithmetic", "word_problem_algebra", "ratios_proportions",
  "percentages", "unit_conversion", "counting", "solving_equations",
] as const;

export const CANONICAL_CATEGORIES = [
  "algebra", "number_theory", "geometry", "combinatorics",
  "probability", "calculus", "analysis", "linear_algebra",
  "discrete_math", "trigonometry", "logic", "other",
] as const;

/** Human-readable one-line for the MCP tool description. */
export const TECHNIQUES_LIST = CANONICAL_TECHNIQUES.join(", ");
export const CATEGORIES_LIST = CANONICAL_CATEGORIES.join(" | ");
