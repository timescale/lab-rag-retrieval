# Experiment Log

## Baseline (2026-04-13)

**Config**: haiku model, 100 questions (all 2-hop), tool mode with MCP search

| Run | F1 | EM | Avg tool calls |
|-----|----|----|----------------|
| baseline 100q | 0.672 | 0.570 | 8.6 |
| baseline 100q run2 | 0.676 | 0.590 | 8.0 |
| **Average** | **0.674** | **0.580** | **8.3** |

Variance: ±0.002 F1 — very stable at 100 questions.

### Failure analysis (from earlier 20-question runs)

Key failure patterns identified:
1. **Retrieval miss** — answer not found after extensive search (17-20 tool calls)
2. **Under-searching** — model gives confident wrong answer after only 3 tool calls
3. **Formatting** — truncated names ("Crockett" vs "Crockett County"), added filler ("promoting European integration")
4. **Inconsistent multi-hop** — right 1/3 times, suggesting retrieval path instability

---

## Experiment 1: H1 — Explicit sub-question decomposition (2026-04-13)

**Hypothesis**: Adding explicit instructions to decompose multi-hop questions into ordered sub-questions before searching should reduce wrong-path errors and under-searching.

**Change**: Rewrote tool-mode prompt in `buildPrompt()` to include decomposition examples and step-by-step instructions.

| Metric | Baseline | H1 | Delta |
|--------|----------|----|-------|
| F1 | 0.674 | 0.655 | -0.019 |
| EM | 0.580 | 0.560 | -0.020 |
| Avg tool calls | 8.3 | 8.1 | -0.2 |

**Result**: Regression. The decomposition instructions likely added overhead for haiku — the model may over-think the meta-reasoning instead of just searching.

**Decision**: Reverted.

---

## Experiment 2: H2 — Exact name formatting instruction (2026-04-14)

**Hypothesis**: Many EM failures come from truncated names ("Crockett" vs "Crockett County", "Cabo Delgado" vs "Cabo Delgado Province"). Adding an explicit instruction to use full canonical names from the source should recover EM points.

**Change**: Added to tool-mode prompt in `buildPrompt()`: "Use the exact name as it appears in the source, including full suffixes (e.g. 'Crockett County' not 'Crockett', 'Cabo Delgado Province' not 'Cabo Delgado')."

| Metric | Baseline | H2 | Delta |
|--------|----------|----|-------|
| F1 | 0.674 | 0.610 | -0.064 |
| EM | 0.580 | 0.540 | -0.040 |
| Avg tool calls | 8.3 | 8.6 | +0.3 |

**Result**: Clear regression. The formatting instruction likely distracted haiku from the core retrieval/reasoning task. The few EM points it might have recovered were overwhelmed by degradation elsewhere.

**Decision**: Reverted.

---

## Experiment 3: H3 — Retrieval retry instruction (2026-04-14)

**Hypothesis**: The under-searching failure (confident wrong answer after 3 tool calls) could be addressed by encouraging the model to retry with different keywords when initial search doesn't return what's needed.

**Change**: Added to tool-mode prompt in `buildPrompt()`: "If your first search doesn't return what you need, try rephrasing with different keywords or searching for a related entity. Don't give up after one search — try at least 2-3 different queries per sub-question before concluding the information isn't available."

| Metric | Baseline | H3 | Delta |
|--------|----------|----|-------|
| F1 | 0.674 | 0.653 | -0.021 |
| EM | 0.580 | 0.540 | -0.040 |
| Avg tool calls | 8.3 | 9.6 | +1.3 |

**Result**: Regression despite more tool calls. The model searched more (+1.3 avg calls) but quality dropped — possibly spending extra searches on already-found information instead of pursuing the right multi-hop path.

**Decision**: Reverted.

---

## Summary after H1/H2/H3 (2-hop only baseline)

All three prompt-level interventions regressed. Haiku appears sensitive to prompt bloat — the base prompt is already near-optimal for this model. Future experiments should focus on:
- **Retrieval quality** (better search, reranking, hybrid weights) rather than prompt engineering
- **Ingestion changes** (entity extraction, fact decomposition, better chunking)
- **MCP tool design** (tool descriptions, result formatting)

---

## New Baseline — Random Sample with All Hop Types (2026-04-14)

Switched eval from first-100 (all 2-hop) to seeded random sample (seed=42) covering all hop types. Added retrieval recall metric.

**Config**: haiku model, 100 random questions, tool mode with MCP search

| Hops | F1 | EM | Recall | n |
|------|----|----|--------|---|
| 2-hop | 0.655 | 0.605 | 0.934 | 38 |
| 3-hop | 0.519 | 0.366 | 0.902 | 41 |
| 4-hop | 0.516 | 0.381 | 0.762 | 21 |
| **Overall** | **0.570** | **0.460** | **0.885** | **100** |

Avg 11.5 tool calls per question. 2594s total answering time.

### Key observations

- **2-hop**: Recall 93.4%, F1 0.655 — retrieval is good, reasoning is the bottleneck
- **3-hop**: Recall 90.2%, F1 drops to 0.519 — retrieval still solid, reasoning degrades with more hops
- **4-hop**: Recall drops to 76.2%, F1 0.516 — both retrieval and reasoning are bottlenecks
- **Overall retrieval recall is 88.5%** — the model finds most supporting paragraphs but struggles to combine them correctly for 3+ hop questions

---

## Experiment 4: H6 — Auto-hybrid search in MCP tool (2026-04-14)

**Hypothesis**: The model mostly uses semantic search only. Automatically running BM25 alongside semantic (using the same query text) and fusing with RRF should improve retrieval recall, especially for obscure entity names that keyword matching handles better.

**Testing on 4-hop only** (21 questions) to isolate retrieval improvements.

### H6 — Full auto-hybrid (both directions)

**Change**: Modified `me_memory_search` in `mcp-server.ts` to always run both BM25 and semantic, regardless of which parameter the model provides.

| Metric | Baseline | H6 | Delta |
|--------|----------|----|-------|
| F1 | 0.516 | 0.389 | -0.127 |
| EM | 0.381 | 0.286 | -0.095 |
| Recall | 0.762 | 0.702 | -0.060 |
| Avg tools | — | 21.0 | — |

**Result**: Clear regression. Recall dropped, F1/EM dropped. Running semantic from short keyword queries produces bad embeddings, and extra results pollute RRF ranking.

### H6-tweak1 — Auto-BM25 only (one direction)

**Change**: Only auto-add BM25 when semantic is provided (BM25 handles natural language fine). Don't auto-add semantic when only fulltext is provided.

| Metric | Baseline | H6-tweak1 | Delta |
|--------|----------|-----------|-------|
| F1 | 0.516 | 0.453 | -0.063 |
| EM | 0.381 | 0.333 | -0.048 |
| Recall | 0.762 | 0.762 | +0.000 |
| Avg tools | — | 18.8 | — |

**Result**: Recall recovered to baseline but F1/EM still regressed. BM25 results dilute the semantic ranking without improving retrieval. More tool calls without benefit.

**Decision**: Reverted. Auto-hybrid doesn't help — the model's natural search strategy is already effective.
