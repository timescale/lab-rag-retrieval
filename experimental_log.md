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

---

## Experiment 5: H4 — Increase top-K results per search (2026-04-14)

**Hypothesis**: With top-10 from 30 candidates, the right paragraph may be ranked below the cutoff. Increasing to top-20 from 50 candidates gives the model more context per search, making it more likely to see the right paragraph.

**Testing on 4-hop only** (21 questions).

**Change**: In `mcp-server.ts`, changed default `candidateLimit` from 30→50 and `limit` from 10→20.

| Metric | Baseline | H4 | Delta |
|--------|----------|----|-------|
| F1 | 0.516 | 0.424 | -0.092 |
| EM | 0.381 | 0.286 | -0.095 |
| Recall | 0.762 | 0.702 | -0.060 |
| Avg tools | — | 22.0 | — |

**Result**: Clear regression. More results per search overwhelms haiku — the model processes 2x more content per tool call but makes worse decisions. Recall dropped, suggesting the model reads more noise and loses track of the relevant paragraphs.

**Decision**: Reverted. Haiku performs best with concise, focused results.

---

## Experiment 7: I1 — Entity-enriched content (2026-04-14)

**Hypothesis**: Appending extracted entity names to paragraph content would enrich both BM25 keywords and semantic embeddings, making obscure entities more findable. Extracts capitalized multi-word phrases and appends as `| Entities: X, Y, Z`.

**Change**: Added `extractEntities()` and `formatContent()` to `memory.ts` `ingest()`. Full reingest of 139k paragraphs with new embeddings. Also reduced `EMBEDDING_BATCH_SIZE` from 2048→1024 to avoid token limit errors from longer content.

**Testing on 4-hop only** (21 questions).

| Metric | Baseline | I1 | Delta |
|--------|----------|----|-------|
| F1 | 0.516 | 0.471 | -0.045 |
| EM | 0.381 | 0.381 | +0.000 |
| Recall | 0.762 | 0.702 | -0.060 |
| Avg tools | — | 19.7 | — |

**Result**: EM unchanged but F1 and recall both dropped. The appended entity text likely diluted the paragraph's core semantic signal in the embedding, making some paragraphs harder to find via semantic search. The regex-based entity extraction also included some noise (false positives).

**Decision**: Reverted. Full reingest to restore original content format.

---

## Experiment 6: H7 — Title search hints in tool description (2026-04-14)

**Hypothesis**: The model mostly uses semantic search and misses obscure entities. Adding hints about meta title filtering and grep for exact entity lookup in the tool description should help it find specific entities faster.

**Testing on 4-hop only** (21 questions).

**Change**: Expanded `me_memory_search` description with tips for entity-specific searches (meta title match, grep for partial match, combining grep with semantic).

| Metric | Baseline | H7 | Delta |
|--------|----------|----|-------|
| F1 | 0.516 | 0.374 | -0.142 |
| EM | 0.381 | 0.238 | -0.143 |
| Recall | 0.762 | 0.750 | -0.012 |
| Avg tools | — | 25.1 | — |

**Result**: Worst regression yet. The expanded tool description caused haiku to over-use grep/meta filters (25.1 avg tool calls) at the expense of its natural semantic search strategy. More searching ≠ better results.

**Decision**: Reverted.

---

## Summary after H4/H6/H7 retrieval experiments

All three retrieval-focused experiments regressed on 4-hop questions:

| Experiment | 4-hop F1 | Delta | Notes |
|-----------|----------|-------|-------|
| Baseline | 0.516 | — | — |
| H6 auto-hybrid | 0.389 | -0.127 | Diluted rankings |
| H6-tweak1 auto-BM25 | 0.453 | -0.063 | Recall same, reasoning worse |
| H4 top-20 results | 0.424 | -0.092 | Context overload |
| H7 title search hints | 0.374 | -0.142 | Over-searching with filters |

**Key insight**: Haiku is very sensitive to any change that increases context or complexity. The baseline configuration (semantic search, top-10/30, minimal prompt) is already near-optimal for this model. The remaining gap is primarily a **reasoning** bottleneck, not a retrieval one.

**Next directions to explore**:
- Try a stronger model (sonnet) instead of haiku for multi-hop reasoning
- Reduce noise: trim irrelevant content from retrieved paragraphs
- Context mode: pre-retrieve and present all context in one prompt instead of iterative tool calls

---

## Experiment 7: I1 — Entity-enriched content (2026-04-14)

**Hypothesis**: Appending extracted entity names (capitalized noun phrases) to paragraph content would enrich both BM25 and semantic embeddings, making obscure entities more findable.

**Change**: Added `extractEntities()` and `formatContent()` to `memory.ts`. Full reingest of 139k paragraphs with new embeddings (batch size reduced 2048→1024 to avoid token limits). Testing on 4-hop only (21 questions).

| Metric | Baseline | I1 | Delta |
|--------|----------|----|-------|
| F1 | 0.516 | 0.471 | -0.045 |
| EM | 0.381 | 0.381 | +0.000 |
| Recall | 0.762 | 0.702 | -0.060 |

**Result**: Appended entities diluted the embedding signal. Reverted + full reingest to baseline.

---

## Experiment 8: Tree path in results + article lookup hint (2026-04-15)

**Hypothesis**: If the model can see which article a result belongs to, it can fetch all paragraphs from that article via tree filter — useful for multi-hop where related facts are in the same article.

**Change**: Added `article: wiki.{slug}` to search result lines. Tested two variants on 4-hop (21 questions):

| Variant | F1 | EM | Recall | Tools |
|---------|----|----|--------|-------|
| Baseline | 0.516 | 0.381 | 0.762 | — |
| Tree path + hint | 0.495 | 0.333 | **0.786** | 19.6 |
| Tree path, no hint | 0.511 | 0.381 | 0.762 | 21.5 |

**Notable**: The hint version was the **first experiment to improve recall** (+0.024). The model used tree filter 10 times across 21 questions. But F1/EM regressed from over-exploration.

**However**, investigation revealed the tree approach is fundamentally limited for this corpus:

### Corpus structure insight

The IRCoT corpus is NOT a Wikipedia dump — it's built from individual paragraphs selected for MuSiQue questions:
- 139,416 paragraphs from 114,719 unique article titles
- **94% of articles have just 1 paragraph** in the corpus
- Each MuSiQue question includes ~20 paragraphs (2-4 supporting + ~16 distractors)
- The corpus deduplicates these across all train/dev/test splits

So "get all paragraphs from this article" almost always returns just the one we already found. The tree/article approach is a dead end for this dataset.

**Decision**: Reverted both variants.

---

## Overall status after 8 experiments

**All experiments regressed. Baseline is still optimal.**

The model (haiku) is extremely sensitive to added complexity — every change to prompts, retrieval config, tool descriptions, or content format has hurt performance. The baseline semantic search with minimal prompt is near-optimal.

---

## Dataset quality audit (2026-04-15)

Deep analysis of 4-hop failures revealed 3 questions with entity name collision bugs — the question composition process mechanically chains entity names across hops without checking for disambiguation. These are documented in `results/dataset-errors.json` and now excluded from evaluation.

### Evaluation improvements

- **LLM-as-judge accuracy metric**: For non-EM answers, an LLM judge evaluates semantic equivalence. This captures cases like "Paraguay" vs "Alfredo Stroessner's Paraguay" that are correct but fail EM.
- **Dataset error filtering**: Questions in `results/dataset-errors.json` are excluded, with over-sampling to maintain target question count.
- **Concurrency increased** from 4 to 10 — cuts eval time from ~43 min to ~26 min.

---

## Updated Baseline (2026-04-15)

**Config**: haiku model, 100 questions (error-filtered, seeded random), tool mode, concurrency 10

| Hops | F1 | EM | Acc | Recall | n |
|------|----|----|-----|--------|---|
| 2-hop | 0.689 | 0.605 | 0.737 | 0.934 | 38 |
| 3-hop | 0.481 | 0.326 | 0.512 | 0.868 | 43 |
| 4-hop | 0.456 | 0.368 | 0.421 | 0.789 | 19 |
| **Overall** | **0.555** | **0.440** | **0.580** | **0.878** | **100** |

Avg 11.7 tool calls. 1449s answering + 123s judging.

### Key observations

- **Accuracy >> EM**: LLM judge credits ~14 additional answers (0.580 vs 0.440) — many answers are semantically correct but fail exact match
- **2-hop**: Recall 93.4%, Acc 73.7% — retrieval is strong, reasoning gap is moderate
- **3-hop**: Recall 86.8%, Acc 51.2% — retrieval still decent, reasoning degrades significantly
- **4-hop**: Recall 78.9%, Acc 42.1% — both retrieval and reasoning are bottlenecks
- **Retrieval is not the primary bottleneck** for 2-hop and 3-hop; reasoning is

### Remaining directions

- **Stronger model** (sonnet) for better multi-hop reasoning
- **Context mode** — skip iterative tool calls, pre-retrieve and present all context at once
- **Fewer, better results** — reduce from top-10 to top-5 to decrease noise
