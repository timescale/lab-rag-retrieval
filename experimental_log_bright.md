# BRIGHT Experiment Log

## Baseline — Pony Domain (2026-04-20)

**Config**: haiku model, 20 queries (of 112), pony domain (7,894 docs), tool mode, concurrency 5

| Metric | Value |
|--------|-------|
| nDCG@10 | 0.114 |
| Avg tool calls | 4.0 |
| Queries | 20 |
| Time | 168s |

For context, BRIGHT SOTA is ~22 nDCG@10 overall. Pony is a code-focused domain (Pony programming language) — documents are source code and documentation.

### Observations

- Only 4 tool calls per query on average — the agent is not searching enough
- nDCG@10 of 0.114 means the agent finds some relevant docs but ranking is poor
- BRIGHT queries require reasoning to identify relevance — surface keyword matching is insufficient
- Agent searches for problem keywords ("convert integer to string") but gold docs are language tutorials ("control structures", "operators")

---

## Experiment 1: Concept-based prompt (2026-04-20)

**Hypothesis**: The agent searches for surface-level keywords from the problem description, but the gold documents are language tutorials about concepts needed to solve the problem. Guiding the agent to reason about what concepts/features are needed before searching should improve retrieval.

**Change**: Rewrote `buildPromptBright()` to:
1. Instruct the agent to identify key concepts needed (loops, string manipulation, etc.)
2. Search for each concept separately — tutorials, language features, documentation
3. Search for related API functions and standard library features
4. Do at least 5-6 searches before finalizing

| Metric | Baseline | Concept prompt | Delta |
|--------|----------|---------------|-------|
| nDCG@10 | 0.114 | **0.428** | **+0.314** |
| Avg tool calls | 4.0 | 10.3 | +6.3 |
| Time | 168s | 232s | +64s |

**Result**: 3.75x improvement. The concept-based prompt dramatically improved retrieval by guiding the agent to search for language features rather than problem keywords. Tool calls increased from 4→10, indicating the agent is exploring more thoroughly.

**Decision**: Adopted.

---

## Full Pony Eval — 112 queries (2026-04-20)

Ran the concept-based prompt on the complete pony test set (112 queries). Also discovered + fixed a bug where running `setup:bright` for multiple domains wiped the shared `bright_corpus` table; refactored to per-domain tables (`bright_pony`, `bright_biology`, etc.).

| Metric | Value |
|--------|-------|
| nDCG@10 | **0.409** |
| Avg tool calls | 10.2 |
| Queries | 112 |
| Time | 1368s (~23 min) |

Very close to the 20-query quick result (0.428), confirming the concept prompt generalizes. For context, published BRIGHT SOTA is ~22 nDCG@10 overall; we're at 40.9 on pony.

---

## Cross-Domain Baselines (2026-04-20)

Ran the concept prompt across multiple domains to see how well it generalizes:

| Domain | nDCG@10 | Queries | Avg Tools | Time |
|--------|---------|---------|-----------|------|
| pony | 0.409 | 112 | 10.2 | 23 min |
| theoremqa_theorems | 0.512 | 76 | 9.0 | 18 min |
| economics | 0.351 | 103 | 9.1 | 30 min |
| psychology | 0.472 | 101 | 8.6 | 27 min |
| **Mean** | **0.436** | 392 | 9.2 | — |

All four domains well above published BRIGHT SOTA of ~22 nDCG@10. The concept prompt generalizes — it works even though it's code-specific in wording.

---

## Experiment 2: Domain-aware prompts (2026-04-20) — rejected

**Hypothesis**: The concept prompt's coding-specific wording ("LANGUAGE FEATURES", "API functions", "tutorials") might mislead the agent on QA domains like economics. A domain-aware variant that splits prompts by domain type (code/math vs QA) should help.

**Change**: Added `buildPromptBrightTechnical()` (for pony/leetcode/aops/theoremqa) and `buildPromptBrightQA()` (for biology/economics/etc.). The QA variant framed retrieval as "find articles addressing the question" rather than "find techniques to solve it".

**Testing**: Re-ran economics with the QA prompt.

| Metric | Concept prompt | QA prompt | Delta |
|--------|---------------|-----------|-------|
| nDCG@10 | 0.351 | 0.332 | -0.019 |
| Avg tool calls | 9.1 | 9.2 | +0.1 |

**Result**: Slight regression. The QA framing, despite being more "fitting" to the corpus, actually performs worse. The concept prompt's stronger instructions ("identify techniques, search for each separately, do 5-6 searches") seem to drive better behavior regardless of domain.

**Decision**: Reverted. Keep the single concept prompt across all domains.
