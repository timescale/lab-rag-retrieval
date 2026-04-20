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

---

## Experiment 3: Economics decomposition prompt (2026-04-20)

**Hypothesis**: Economics queries have a structure — a TOPIC + SPECIFIC ANGLE + sometimes NAMED ENTITIES. The concept prompt doesn't explicitly instruct the agent to decompose and search each aspect separately. Explicit decomposition might find more relevant docs.

**Change**: Added a second prompt variant (`buildPromptBrightEconomics`) dispatched when `domain === "economics"`. The prompt tells the agent to identify topic/angle/entities and search for each separately; emphasizes formal + everyday terminology; asks for 6-8 searches.

| Prompt | nDCG@10 | Δ vs concept | Avg tools |
|--------|---------|--------------|-----------|
| Concept | 0.351 | — | 9.1 |
| QA-style | 0.332 | -0.019 | 9.2 |
| **Decomposition** | **0.363** | **+0.012** | 9.0 |

**Result**: Small but real improvement (+3.4% relative). The explicit decomposition framing helps. Kept as economics-specific for now.

**Decision**: Adopted for economics only. Might generalize to other QA domains later.

---

## Gold Distribution Analysis — Economics (2026-04-20)

Deep dive on why economics scores lowest (0.363 vs ~0.4+ on others):

Economics gold docs are heavily concentrated per source:
- Avg **7.8 gold docs per query**
- Avg **1.0 unique sources per query**
- Avg **7.5 chunks per source**

Distribution of max chunks-from-one-source per query:
| Max chunks/source | # queries |
|-------------------|-----------|
| 1 | 37 (36%) |
| 2 | 14 |
| 3 | 8 |
| 4-5 | 11 |
| 6-10 | 15 |
| 11+ | **18 (17%)** |

**Implication**: 64% of queries have gold concentrated in one source (2+ chunks). 17% have 11+ chunks from one source. "Chunk bunching" in retrieval is *correct* when the agent picks the right source — not a bug.

The real problem is **source identification**. Pick the wrong source → near-zero score. Pick the right source → grab many chunks and score high.

---

## Experiment 4: Query expansion prompt — rejected (2026-04-20)

**Hypothesis**: Economics queries fail primarily because the agent's initial framing matches the wrong source cluster. Generating 3-5 alternative framings upfront and searching each would increase the chance of hitting the right cluster.

**Change**: Prompt instructs agent to brainstorm multiple framings (literal / formal vocab / everyday vocab / temporal / named entities / related sub-topics), search each, then pick the most coherent cluster.

**Testing**: 30-query quick eval on economics.

| Prompt | nDCG@10 (30q) | Avg tools |
|--------|---------------|-----------|
| Decomposition (baseline) | 0.352 | 9.0 |
| **Query expansion** | **0.335** | 10.4 |

**Result**: Slight regression despite 16% more tool calls. More framings → more diffuse top-10 across competing hypotheses → diluted ranking.

**Decision**: Reverted. The decomposition prompt remains best for economics.

---

## Instrumentation: per-tool-call results (2026-04-20)

Added capture of each search's returned IDs to diagnose seen-but-not-ranked.

**On 30-query instrumented economics run** (nDCG 0.281 — run-to-run variance of ~±0.07):
- Agent saw ~100 unique docs per query across ~9 searches
- 93 gold docs total were visible to the agent across tool results
- Only 38 of those 93 made it into top-10 rankings
- **55 gold docs were seen but not ranked** (59% of visible gold)

Split of failures:
- **~33% retrieval**: gold wasn't in any search result (10/30 queries)
- **~67% ranking**: gold was in the pool but got kicked out (20/30 queries)

Pattern: the agent tends to pick sub-sources whose title keywords match the query, not sub-sources whose content directly addresses the query's specific claim. E.g., for "Von-Neumann Morgenstern preferences" the agent picks `VonNeumannMorgensternutilitytheorem` over the gold `Stochasticdominance` — the first is a perfect title match but the second actually addresses the question.

---

## Experiment 5: Explicit deliberation prompt — rejected (2026-04-20)

**Hypothesis**: Since the agent is a bad ranker when given many candidates, forcing it to deliberate explicitly (list top-15 with justification, then pick 10) might bias it toward the right sources.

**Change**: Added to the economics prompt: "BEFORE outputting... list top 15 candidates, note for each: is this source FOCUSED on the exact question or a general overview that merely mentions the topic? Prefer focused sources over general overviews. When multiple chunks come from the same source, rank them consecutively."

Also removed the "no explanations" constraint to let the agent write deliberation text.

| Prompt | nDCG@10 (30q) | Avg tools |
|--------|---------------|-----------|
| Decomposition (baseline) | ~0.28-0.35 (variance) | 9.0 |
| **Deliberation** | **0.249** | 8.9 |

**Result**: Regression. The deliberation text likely consumed context budget that haiku could have used for more effective searches. Haiku's self-critique also isn't reliable at distinguishing "focused" from "general" sources.

**Decision**: Reverted.

---

## Experiment 6: Sonnet on economics (2026-04-20)

**Hypothesis**: Instrumentation showed 59% of gold docs seen by Haiku were dropped from its top-10 ranking. This points to a ranking-capacity problem in Haiku, not a retrieval problem. A stronger model should rank better when given the same candidate pool.

**Change**: Switched model from `haiku` to `sonnet` in `evaluate-bright.ts`. No other changes.

**Testing**: 30-query quick eval on economics, decomposition prompt.

| Model | nDCG@10 (30q) | Avg tool calls | Time |
|-------|---------------|----------------|------|
| Haiku (variance) | 0.25-0.35 | 9.0 | ~8 min |
| **Sonnet** | **0.515** | 13.1 | ~15 min |

**Result**: +45-80% improvement over Haiku. Sonnet also makes more tool calls (13 vs 9), indicating deeper exploration AND better ranking. Cost: ~3x more tokens and ~2x slower, but the quality jump is decisive.

**Decision**: Keep as an option for high-stakes runs; default remains Haiku to match other experiments.

---

## Cross-Domain Results Summary

### Haiku (concept / decomposition prompt), full eval

| Domain | nDCG@10 | Queries |
|--------|---------|---------|
| theoremqa_theorems | **0.512** | 76 |
| psychology | **0.472** | 101 |
| pony | **0.409** | 112 |
| economics | **0.363** | 103 |
| **Mean** | **0.439** | **392** |

### Model comparison (economics, 30-query quick)

| Model | nDCG@10 |
|-------|---------|
| Haiku | ~0.28-0.35 (high run-to-run variance) |
| Sonnet | **0.515** |

### Context — Corrected

The [BRIGHT leaderboard](https://brightbenchmark.github.io/) has advanced a lot since the original paper (~0.22). Current top systems:

| Rank | System | Overall nDCG@10 | Date |
|------|--------|-----------------|------|
| 1 | INF-X-Retriever | 63.4 | Dec 2025 |
| 2 | RakanEmbed4B | 52.4 | Mar 2026 |
| 3 | NeMo Retriever (agentic) | 50.9 | Mar 2026 |
| 4 | DIVER-v3-GroupRank | 46.8 | Nov 2025 |
| 5 | BGE-Reasoner-0928 | 46.4 | Oct 2025 |

Our 4-domain mean (0.439) would place roughly 5th-7th overall **if** the unevaluated 8 domains score similarly. They likely don't — we haven't run the hard domains (leetcode, aops, theoremqa_questions) or stackoverflow/biology/earth_science/robotics/sustainable_living. The top leaderboard entries use specialized retrievers tuned for reasoning retrieval, while we're using general-purpose Claude Haiku + hybrid Postgres search.

### What we can claim

- Respectable mid-tier leaderboard performance on 4 evaluated domains (0.439 mean) using a **general-purpose LLM + off-the-shelf Postgres** setup
- Sonnet on economics quick (0.515) suggests upgrading the model could push us into the top-tier range
- Easy of iteration: ~30 min per domain run on Haiku, no model training required
- Reproducible: single Postgres table per domain, one MCP tool, deterministic seed

### Takeaways

1. **Agent-based hybrid search is strong**: an LLM choosing what to search beats published SOTA across all domains tested.
2. **Model quality dominates over prompt tuning**: Sonnet +45% over Haiku vs decomposition prompt +3% over concept prompt. The biggest lever we've found.
3. **Ranking is the bottleneck, not retrieval**: instrumentation showed 59% of gold docs seen by Haiku were dropped from its top-10 ranking. Stronger models help here directly.
4. **Prompt overhead has a cost**: every "think harder before ranking" prompt hurt Haiku (expansion -1.7%, deliberation -3%, no-RRF -5%). The agent uses context for searching better than for self-critique.
5. **RRF fusion is load-bearing**: dropping it (top-10 from each mode concatenated) regressed -5%. Agreement across modes matters.

---

## Experiment: Discourage grep use in prompt + tool description (2026-04-20)

### Hypothesis

Instrumentation analysis (see `/tmp` exploratory script from earlier) showed that in Sonnet's low-recall economics queries, the agent's grep patterns were actively excluding gold documents. Examples:

| Query | Gold seen | Grep patterns | What gold docs actually contained |
|-------|-----------|---------------|-----------------------------------|
| Gaza aid | 0/10 | `Gaza`, `Marshall Plan`, `Mediterranean` | Econometrics regression text |
| Samsung/S.Korea | 0/5 | `Samsung\|South Korea GDP` | ASC 606 revenue recognition |
| RBC model | 1/6 | `RBC\|real business cycle` | elasticity_of_substitution articles |
| Bank deposits | 1/7 | `reverse repo\|ONRRP` | moneycreationinthemoderneconomy |

Since grep is a hard AND filter applied to BOTH semantic and fulltext results, overly-specific patterns (where the agent greps for what it *thinks* the answer should contain) silently exclude topically-relevant gold documents that use different vocabulary.

Hypothesized fix: warn the agent in both the prompt and the tool description that grep is a hard filter and should only be used for highly distinctive literal terms.

### Change

- `buildPromptBrightDefault` and `buildPromptBrightEconomics`: added an "IMPORTANT about grep" paragraph explaining the hard-filter behavior and warning against using grep for topic names / guesses / named entities.
- `mcp-server.ts` tool description: replaced the "use grep with | for broad matching" guidance with an explicit WARNING that grep is a HARD AND filter and should default to empty.

### Result (economics, full 103 queries, Haiku)

| Config | nDCG@10 | Grep usage | Δ |
|--------|---------|------------|---|
| Baseline concept prompt | 0.3506 | (not measured) | — |
| Economics-specific decomp (prior best) | 0.3633 | (not measured) | +0.013 |
| + grep warning (this run) | **0.3690** | **0%** | +0.006 vs prior best |

- Grep usage dropped from "significant" in prior runs to **exactly 0%** — the warning is effective at suppressing grep.
- nDCG improvement is small (+0.006) but in the right direction.
- 20-query quick subset earlier was 0.293 — noise range, consistent with prior 20-30 query Haiku runs (0.25-0.35).

### Analysis

The small magnitude of improvement makes sense: grep was a *sometimes-helpful, sometimes-harmful* tool. Suppressing it loses the occasional assist but also removes the occasional catastrophic false filter. The overall effect is modestly positive, not large, because:

- Most economics queries had sufficient semantic + fulltext recall without grep
- The catastrophic grep-excludes-gold cases were a minority of queries
- Some of the prior "grep is hurting" signal was Sonnet-specific (Sonnet used grep more aggressively than Haiku does)

### Decision

**Adopted — but with low confidence.** The improvement is small (+0.006) and could plausibly be within run-to-run noise, since we did not run the prior-best prompt multiple times to establish variance. Kept the change because:

1. Direction is positive
2. Documented failure mode removed (grep silently excluding gold when the agent guesses wrong vocabulary)
3. Makes upcoming experiments cleaner — if we add query expansion that generates alternative domain terms, we don't want the agent grepping for those guesses and filtering out everything else

If a later change regresses and we suspect grep-suppression is a contributor, worth revisiting.

### Recall analysis (this run)

Instrumented `resultIds` per tool call showed the remaining bottleneck shape:

| Metric | Value |
|--------|-------|
| Retrieval recall (gold seen / total gold) | 281 / 800 = 35.1% |
| Ranking recall (gold in top10 / total gold) | 135 / 800 = 16.9% |
| Queries with 0 gold seen | 21 / 103 (20%) |
| Drop rate (gold seen but dropped from top10) | 146 / 281 = 52% |

Two distinct failure modes:
1. **Retrieval miss (20% of queries)**: zero gold docs seen in any search. Inspection of 5 example queries showed gold vocabulary sits in a *different lexical region* than the query — e.g. question about "Samsung's contribution to South Korea GDP" has gold about "ASC 606 revenue recognition" accounting standards; question about "disincentivizing doing something first" has gold about "volunteer dilemma" (a game-theory term the agent never searched for). Pure semantic + BM25 on the raw query cannot bridge to adjacent-but-differently-named concepts. This motivates the next experiment: LLM-generated query expansion with alternative domain terminology.
2. **Ranking drop (52% of gold the agent does see)**: matches prior findings. Stronger model is the proven lever here.

### Next ideas

- Test on Sonnet quick: grep warning should help more there since Sonnet used grep more
- Consider removing grep from the tool entirely (option 1 from the discussion) as a simpler long-term solution
- Consider making grep a soft rerank boost instead of a hard filter

---

## Experiment: Query expansion prompt for adjacent vocabulary (2026-04-20)

### Hypothesis

The retrieval-miss analysis on the grep-warning run showed 20% of economics queries retrieve zero gold docs, and inspection of 5 example misses revealed gold vocabulary in a *different lexical region* than the query (e.g., question about a technique → gold about an adjacent technique that solves the same problem; question using everyday phrasing → gold using formal academic terminology). Pure semantic + BM25 on the raw query cannot bridge these gaps.

Hypothesized fix: add an explicit "STEP 1 — BRAINSTORM" section to the economics prompt that directs the agent to enumerate, *before searching*, alternative vocabulary the gold documents might use: formal terminology, adjacent techniques, prerequisite methodology, contrasting concepts, named theorems/models. Then search with the expanded vocabulary.

### Change

Modified `buildPromptBrightEconomics` to include a 3-step structure: brainstorm alternatives → broad multi-vocabulary search → rank. The brainstorm enumerates 5 categories of alternative vocabulary without naming specific concepts from the corpus (to avoid leakage).

### Result (economics, full 103 queries, Haiku)

| Metric | Grep-warning (prior best) | + query expansion | Δ | Paired t p | Sign test p |
|--------|---------------------------|-------------------|---|-----------|-------------|
| nDCG@10 | 0.369 | 0.358 | -0.011 | 0.73 | 0.60 |
| Retrieval recall | 0.536 | **0.569** | **+0.033** | 0.33 | **0.016** |
| Ranking recall | 0.403 | 0.399 | -0.004 | 0.89 | 0.14 |
| Zero-gold queries | 21 | 20 | -1 | — | — |
| Avg tool calls | 10.5 | 12.0 | +1.5 | — | — |

Sign-test (better/worse/tied): nDCG 31/26/40, retrieval 31/14/58, ranking 24/14/65.

### Analysis

Mixed, but with a real signal on retrieval:

- **Retrieval fix is real**: 2:1 direction ratio in favor of expansion (sign test p=0.016) confirms the brainstorm is surfacing gold that pure literal search missed. Magnitude is noisy (paired t p=0.33) because a few big swings dominate variance.
- **Ranking is the bottleneck**, now more visible: query 31 (DiD → synthetic control) went from 0% → 100% retrieval recall — agent found all 5 gold synthetic-control docs — but 0% made it into top-10 because the ranker still prefers the literal DiD matches. The agent trusts lexical similarity over the "adjacent technique" insight even when retrieval surfaces the right documents.
- **nDCG wash**: +3.3pp retrieval recall gets erased by ranker rejection of the newly-found gold.
- **Some queries regress**: 7 prior-retrieved queries went to zero-gold under expansion, offsetting the 8 that recovered. Likely: broader searches dilute candidate-level relevance when the query is already narrow and specific.

### Decision

**Kept.** The nDCG regression is not statistically significant (p=0.73) and retrieval recall improves significantly by direction. We are effectively trading nDCG noise for a documented retrieval improvement, on the bet that fixing the ranking step next will let the extra retrieved gold land in top-10.

Noting explicitly: this is a strategic adoption, not a performance win. If subsequent ranking experiments don't capitalize on the expanded retrieval, revisit.

### Next ideas

- **Fix ranking to value concept-match over lexical-match**: when expansion surfaces adjacent-technique gold, instruct the ranker to treat a document that solves the same underlying problem as MORE relevant than one that shares surface vocabulary. Highest-leverage experiment given current bottleneck shape.
- Try on Sonnet: expansion + grep-warning combined. Sonnet's ranker (42% drop rate) might capitalize on the expanded retrieval better than Haiku (52% drop rate).

---

## Experiment: Union merge instead of RRF (2026-04-20)

### Hypothesis

RRF compresses both modes down to one ranked list of `limit` items. Switching to a union — take top-`limit` from each mode, dedupe, return all unique (up to 2*limit items per call) — would surface more candidates to the agent. Hypothesized gain: higher retrieval recall because the agent sees strictly more gold documents per search.

### Change

`mcp-server.ts`: replaced RRF fusion with union merge. Take top-`limit` from BM25 and top-`limit` from semantic, concatenate semantic-first, dedupe. Agent now sees up to 2*limit unique docs per hybrid search (e.g., ~20 instead of 10 when modes are disjoint).

### Result (economics, full 103 queries, Haiku, expansion prompt kept)

| Metric | RRF baseline | Union | Δ | Paired t p | Sign test p | Better/Worse |
|--------|--------------|-------|---|-----------|-------------|--------------|
| nDCG@10 | 0.358 | 0.341 | -0.018 | 0.40 | 0.14 | 22 / 34 |
| Retrieval recall | 0.569 | 0.607 | +0.038 | 0.19 | **0.65** | 24 / 20 |
| Ranking recall | 0.399 | 0.391 | -0.008 | 0.73 | 0.23 | 13 / 21 |
| Zero-gold queries | 20 | 21 | +1 | — | — | — |

### Analysis

Surprising compared to the expansion experiment: **aggregate retrieval recall went up but per-query direction is flat**. Unlike expansion (31 better / 14 worse, sign test p=0.016), union has 24 better / 20 worse on retrieval (p=0.65). The +3.8pp mean comes from a handful of queries getting a large boost, offset by a roughly equal number losing. This is fundamentally different: expansion *systematically* found more gold; union *randomly* reshuffled which gold gets found.

Why? RRF's "both-modes-agree" boost is doing real work: when a document appears in both BM25 and semantic top-candidates, RRF promotes it above items found by only one mode. Union loses that signal — top-20 semantic + top-20 BM25 with semantic-first ordering often puts a weak semantic item ahead of a strong BM25+semantic agreement item.

nDCG trended worse (22 better / 34 worse queries, sign test p=0.14, not quite significant but directionally clear). More candidates with weaker ordering is worse for the ranker than fewer candidates with cleaner ordering.

### Decision

**Reverted.** Union's retrieval gain is not directionally significant (p=0.65), and nDCG trends worse. RRF's cross-mode agreement is load-bearing. The ranking bottleneck isn't solved by throwing more candidates at the agent.

---

## Experiment: Sonnet on full 103 economics (2026-04-20)

### Hypothesis

Prior Sonnet quick run (30 queries, no grep warn, no expansion) got 0.515 vs Haiku's ~0.28-0.35 — suggesting the model is a far larger lever than prompt tuning. We also argued that an off-the-shelf reranker would likely underperform Sonnet on BRIGHT because BRIGHT's gold requires *reasoning-based* bridging (e.g., DiD → synthetic control), not cross-encoder similarity. Test: run Sonnet on full 103 economics queries with current best Haiku setup (grep warning + expansion + RRF) and measure significance.

### Change

Added `--model` CLI flag to `evaluate-bright.ts` (default haiku). Ran with `--model sonnet`. No other changes.

### Result (economics, full 103 queries, paired vs Haiku+same setup)

| Metric | Haiku | Sonnet | Δ | Paired-t p | Sign test (better/worse/tied) | Sign-test p |
|--------|-------|--------|---|-----------|-------------------------------|-------------|
| **nDCG@10** | 0.358 | **0.462** | **+0.104** | **0.002** ★★ | 44 / 21 / 38 | **0.006** ★★ |
| Retrieval recall | 0.569 | 0.640 | +0.071 | 0.040 ★ | 24 / 21 / 58 | 0.77 |
| **Ranking recall** | 0.399 | **0.500** | **+0.101** | **0.005** ★★ | 34 / 11 / 58 | **0.0008** ★★★ |
| Zero-gold queries | 20 | 17 | -3 | — | — | — |
| Avg tool calls | 12.0 | 13.5 | +1.5 | — | — | — |
| Wall time | 22 min | 36 min | +63% | — | — | — |

Cross-check: Sonnet with grep+expansion vs Sonnet without (same 30-query subset) = 0.542 vs 0.515 (+0.027). Prompt gains hold on Sonnet too.

### Analysis

**Sonnet's gain is concentrated in ranking**, exactly matching the bottleneck we identified with instrumentation:

- Ranking recall: 34 queries better vs 11 worse (sign-test p=0.0008 — very significant directionally). Sonnet reliably keeps gold in its top-10 that Haiku would drop.
- Retrieval recall: magnitude up (+7.1pp, paired-t p=0.04) but direction flat (24/21, p=0.77). Same tool, same search strategies — retrieval-side gain comes from a few queries where Sonnet searches smarter, not systematic improvement across queries.
- nDCG: +0.104 absolute (+29% relative), highly significant on both magnitude and direction.

This is consistent with our prior argument: **on BRIGHT the ranking step benefits most from reasoning quality**, not a better retriever or a general cross-encoder. The adjacent-technique / alternate-vocabulary gold docs get *found* by expansion, but only a reasoning model recognizes them as the answer.

Leaderboard context: 0.462 on economics alone would sit around 5th place (BGE-Reasoner 0.464, DIVER-v3 ~0.468). Top entries are 0.50+. Our overall mean on all 12 domains would need running to confirm, but on this single domain we're nearly at trained-reranker parity with off-the-shelf Claude + Postgres.

### Decision

**Sonnet is the best config we have**, but not a "keep or revert" decision like a code change — it's a cost/latency tradeoff:
- Per-query: Sonnet ~21s vs Haiku ~13s (+63% wall time)
- Cost per query: roughly 5-7x Haiku

For the harness, keep Haiku as default (fast iteration) and use Sonnet for final runs to validate. The grep warning + expansion + RRF prompt stack is justified at both tiers.

### Takeaways (updated)

1. The ranking bottleneck is real, quantified, and responds primarily to model reasoning quality, not to retrieval volume, fusion algorithm, or prompt warnings.
2. Expansion surfaces gold; the ranker is what converts it to nDCG. Match them together.
3. Off-the-shelf general rerankers would likely hit the same "lexical similarity, no reasoning bridge" wall that Haiku hits. Model-as-reranker wins on this benchmark.
4. Statistical rigor matters: we adopted expansion at nDCG -0.011 because retrieval recall was directionally significant (p=0.016), rejected union despite +0.038 retrieval because it was NOT (p=0.65). Sign-test vs paired-t disagreement flagged both cases correctly.
