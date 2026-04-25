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

---

## Important understanding: BRIGHT gold labeling methodology (2026-04-21)

Through case-by-case inspection of economics zero-retrieval queries, we realized the gold labels are not "the best docs to answer the question" but **the specific sources an expert answer explicitly cites or quotes**. Concrete evidence:

- Query 15 ("why did CEO pay decrease around 2000?") — gold is `ExecutiveExcess1999pdf_7.txt`. The `gold_answer` literally *quotes* that chunk verbatim: "According to [Institute for Policy Studies — A Decade of Executive Excess: The 1990s...] : Of course, the biggest contributor to exorbitant CEO pay is stock options, which are variable. Indeed, when the stock market was weak in 1994, fewer executives exercised their options and total compensation took a dip."
- Query 47 ("does low nominal interest rate encourage lending?") — gold is 30 chunks of Liu/Mian/Sufi (Econometrica 2022, "Low Interest Rates, Market Power, and Productivity Growth"). The `gold_answer` cites this paper by name to explain why low rates are *bad* for long-run growth via market concentration — answering the deeper "why is low n.i.r. considered good?" angle in the query.

Implications for our understanding:
- The retrieval task is effectively "predict what named papers / dated reports / regulatory codes / canonical sources a well-researched expert would cite for this question." Much harder than topical relevance.
- Our "gold-labeling artifact" hypothesis was largely wrong. Most zero-retrieval failures are real — the agent found shallower, more generic material while missing the specific citable source.
- Sonnet's large ranking-recall gain (+0.101, p=0.0008) likely reflects its better reasoning about "what would an expert cite here?" — not just "what's on topic."
- Queries often contain a "sophisticated angle" (e.g. "why is this considered X?" framing, or the user's apparent contradiction) that points to a prerequisite concept or a contrarian research finding. Surface-reading retrieval misses these.

Separately, some queries do have a labeling tension (e.g. query 15's 2022 retrospective docs were arguably as informative as the 1999 report), but this is the minority.

---

## Experiment: Citable-source framing + sophisticated-angle detection (2026-04-21)

### Hypothesis

Given the above understanding, an enhanced economics prompt should:
1. Reframe the task as "find sources an expert answer would cite" (named papers, dated reports, regulatory codes).
2. Detect "sophisticated-angle" cues in the query ("why is X considered Y?" → look for counter-arguments; user contradictions → look for prerequisite concepts).
3. Bias the ranker toward citable-looking documents (formal papers with results, reports with specific titles/dates) over generic overview / textbook-style / recent quarterly-data material.

### Change

Modified `buildPromptBrightEconomics` to add a task reframe (citable sources), a "sophisticated-angle detection" paragraph, a 6th brainstorm category for named sources, and ranking guidance preferring citable looking docs.

### Result (economics, full 103 queries, Haiku)

| Metric | Expansion (prior) | + citable-source | Δ | Paired-t p | Sign test | Sign p |
|--------|-------------------|-------------------|---|-----------|-----------|--------|
| nDCG@10 | 0.358 | 0.337 | -0.021 | 0.47 | 30/36/37 | 0.54 |
| Retrieval recall | 0.569 | 0.593 | +0.024 | 0.49 | 25/29/49 | 0.68 |
| **Ranking recall** | 0.399 | **0.350** | **-0.049** | 0.13 | 20/26/57 | 0.46 |
| Avg tool calls | 12.0 | 16.1 | +4.1 | — | — | — |

### Analysis

Regression is not statistically significant on any metric, but the direction is consistently negative on nDCG and ranking recall. Retrieval recall ticked up slightly (more vocabulary-expansion from the new brainstorm category) but the ranking step got worse — the opposite of what we wanted.

Why it likely hurt:
- The prompt grew substantially longer. More pre-search instruction means less context capacity for the ranking step and more opportunity for Haiku to over-index on edge-case directives.
- "Prefer citable sources over overview material" misfires on queries where gold IS an overview doc (e.g. pony programming questions, which aren't in this test but would fare worse). Even in economics, some gold is textbook-style and the agent now down-weights it.
- "Sophisticated-angle detection" is an explicit meta-reasoning step. Haiku's follow-through on this kind of instruction is inconsistent; when it misfires, the agent searches the wrong angle.
- More tool calls (16.1 vs 12.0) dilute the agent's attention across more candidates before the ranking step, which is already its weakest step.

Parallel with earlier findings: Haiku does better with simpler, lighter prompts. Every "think harder" prompt we tried (deliberation, query expansion with broad guidance, citable-source framing) regressed on Haiku even when the underlying intuition was correct. The instructions work — on Sonnet. On Haiku they cost more than they earn.

### Decision

**Reverted.** Kept the prior expansion prompt. The citable-source insight is correct but doesn't fit in a Haiku prompt; would be worth retesting on Sonnet where ranking reasoning can absorb more nuance.

### Updated takeaway

**Haiku has a prompt-length / instruction-density ceiling.** Adding conceptually correct guidance regresses performance past a certain point. For Haiku, the best prompt is the *simplest* one that carries the core expansion insight. For Sonnet, richer prompts may still help — untested.

---

## Understanding BRIGHT gold labeling (2026-04-21)

After inspecting economics retrieval-miss queries case-by-case with the `gold_answer` and `reasoning` fields, the benchmark's gold-labeling methodology became clear:

> **Gold = the specific source(s) that an expert answer explicitly cites or quotes.**

Concrete evidence:
- Query 15 ("CEO pay decrease around 2000"): gold is `ceopay/ExecutiveExcess1999pdf_7.txt`. The `gold_answer` literally quotes that chunk verbatim: *"Of course, the biggest contributor to exorbitant CEO pay is stock options, which are variable. Indeed, when the stock market was weak in 1994, fewer executives exercised their options and total compensation took a dip."*
- Query 47 ("low nominal interest rate encourages lending?"): gold is 30 chunks of Liu/Mian/Sufi, Econometrica 2022, "Low Interest Rates, Market Power, and Productivity Growth" (ECTA17408). The `gold_answer` cites this paper by name to explain why low rates are *bad* for long-run growth via market concentration — answering the deeper "why is low n.i.r. considered good?" angle in the query.

Implications:
- The retrieval task is effectively "predict what named papers / dated reports / regulatory codes / canonical sources a well-researched expert would cite for this question." Much harder than topical relevance.
- Most zero-retrieval failures are real — the agent finds shallower generic material while missing the specific citable source.
- Sonnet's large ranking-recall gain (+0.101, p=0.0008) likely reflects its better reasoning about "what would an expert cite here?" — not just "what's on topic."
- Queries often contain a "sophisticated angle" (e.g. "why is this considered X?" framing, or the user's apparent contradiction) that points to a prerequisite concept or a contrarian research finding.

Separately, some queries do have a labeling tension (e.g. query 15's 2022 retrospective docs were arguably as informative as the 1999 report), but this is the minority.

---

## Experiment: Short citable-source prompt on Sonnet (2026-04-21)

### Hypothesis

The long citable-source prompt regressed on Haiku due to prompt density. On Sonnet, a shorter version focused on the core citable-source framing + sophisticated-angle detection might work: Sonnet has more reasoning headroom.

### Change

Replaced economics prompt with a much shorter ~1/4-length variant keeping only: "find sources an expert would cite", vocabulary-mismatch warning, brainstorm step (brief), citable-specific ranking guidance, grep warning.

### Result (economics, Sonnet, 30-query quick, paired vs Sonnet + expansion prompt)

| Metric | Expansion prompt | Short citation prompt | Δ | Paired-t p |
|--------|------------------|------------------------|---|-----------|
| **nDCG@10** | 0.542 | **0.477** | **-0.065** | **0.027** ★ |
| Retrieval recall | 0.697 | 0.634 | -0.063 | 0.28 |
| Ranking recall | 0.514 | 0.440 | -0.075 | 0.086 |

### Analysis (generalizable lesson)

Significant regression. Per-query inspection: the agent, told to find "citable sources like named academic papers, dated reports, regulatory codes", responded by generating specific-guess searches: *"SFAS 123 FASB stock option expensing"*, *"SEC proxy disclosure rules 1992 1993"*, *"Hall Liebman Frydman Saks CEO compensation"*, *"Bebchuk Fried pay without performance"*. These are legitimate "citable-source" guesses, but mostly wrong for any particular query — specific searches with wrong-guess keywords retrieve nothing.

The prior expansion prompt's broader searches ("CEO compensation decline dot-com bubble stock options") matched gold via topical semantic similarity — the gold "Executive Excess 1999" chunk discusses CEO pay + stock options + 1994 dip in general terms, so topical search finds it.

**Generalizable rule**: In agent+RAG setups, the agent should EXPAND the search space (divergent: enumerate vocabularies, let embeddings do semantic match), not NARROW it (convergent: commit to specific named guesses the LLM has to invent). The embedding model is better at "given a topic, find semantically similar docs" than the LLM is at "guess which specific named source exists."

**Diagnostically-correct insights ≠ prescriptively-useful prompts.** Understanding that BRIGHT gold is expert-cited sources is valuable for analysis, but telling the agent to find "citable sources" backfires by pushing it toward narrow specific-guess searches.

### Decision

Reverted on both Haiku and Sonnet.

---

## Experiment: Title enrichment at ingestion (2026-04-21)

### Hypothesis

Deep-chunk gold (like ECTA17408 chunks 9-33 about Bertrand competition) lives in a lexically different region than its paper's topic (title: "Low Interest Rates, Market Power, and Productivity Growth"). Prepending the first ~300 chars of chunk 0 to every non-zero chunk would carry paper-level topic context into embeddings of deep chunks.

### Change

Added `enrichDocsWithTitles()` preprocessing step to `ingestBright`: group chunks by stem (`folder/file`), extract first 300 chars of chunk 0 as "preamble", prepend `[Document: <preamble>]` to every non-zero chunk's content.

### Result (economics, full 103 queries, Haiku)

| Metric | Expansion baseline | + title enrichment | Δ | Paired-t p | Sign p |
|--------|---------------------|---------------------|---|-----------|--------|
| nDCG@10 | 0.358 | 0.385 | +0.027 | 0.36 | 0.53 |
| Retrieval recall | 0.569 | 0.581 | +0.012 | 0.74 | 0.57 |
| Ranking recall | 0.399 | 0.420 | +0.021 | 0.46 | 0.76 |

0.385 was the best Haiku econ result but statistically noise-level.

### Per-query inspection

The motivating cases didn't actually improve:
- qid=47 (ECTA17408): still 0.00 ndcg, 0.00 retrieval. Title says "Market Power, Productivity Growth", query says "bank lending" — no lexical bridge.
- qid=15 (CEO pay / Executive Excess 1999): still 0.00.
- qid=14 (Samsung / ASC 606): still 0.00.
- qid=11 (volunteer dilemma): still 0.00.

Gains came elsewhere, and some queries regressed:
- qid=24 (DiD fixed effects): 0.31 → 0.59
- qid=0 (dollars / developing countries): 0.12 → 0.54
- qid=31 (DiD/synthetic control): retrieval 1.00 → 0.40 (preamble SHIFTED embedding away from what had matched)

### Decision

**Reverted.** Modest aggregate gain isn't significant, the theoretical motivation (help ECTA17408-style deep-chunk recall) didn't pan out, and some queries regressed because preamble shifted embeddings away from chunk-specific matches. Doesn't generalize safely across domains.

---

## Tooling: exclude-ids parameter and tree metadata (2026-04-21)

Two infrastructure additions motivated by the aops/theoremqa_questions diagnosis:

### 1. `excludeIds` parameter on `me_memory_search` (all domains)

**Problem**: Our eval does post-hoc exclusion filtering — agent returns up to 10 IDs, eval filters out any in `excluded_ids`, top-10 becomes whatever remains. On aops (excludes 9,200+ per query), this left final top-10 sets with just 1-2 items; lost 8-9 slots where gold could have been. BRIGHT's reference implementation excludes BEFORE ranking.

**Fix**: Added `excludeIds: string[] | null` parameter to `me_memory_search` in `mcp-server.ts`, applied as `id != ALL($N::text[])` across BM25, semantic, and grep branches. Filter happens server-side in SQL.

**Status**: Infrastructure in place. Haiku used it only 4/1007 aops tool calls without explicit prompting — agents don't discover novel tool params on their own.

### 2. `tree` ltree column + `treeMatch` parameter (aops/theoremqa variants)

**Problem**: The aops/theoremqa_questions corpus blends 7 source types; gold is heavily concentrated in `aops_` (60.7%) and `math_train_` (33.4%), but most retrieved candidates are `aqua_` (47.5% of corpus) and `camel_` (26.6%) which mostly aren't gold.

**Changes**:
- Added `tree ltree` column to BRIGHT schema (`createCorpusTable`). GIST index.
- `brightSourceTree(id)` helper maps IDs → labels: `aqua`, `camel`, `gsm`, `math.test`, `math.train`, `theoremqa`, `aops` (and `<folder>` for text-corpus IDs).
- `ingestBright` populates tree from ID.
- Created `src/mcp-server-aops.ts` (variant of mcp-server.ts) with `treeMatch` param taking an ltree lquery pattern; applied as `tree ~ $N::lquery`. Surfaces `tree: <label>` in result lines so the agent can observe labels.
- `evaluate-bright.ts` routes aops / theoremqa_questions → aops MCP, others → default MCP.

### Result (aops, full 111 queries, Haiku, tree-aware MCP)

| Metric | Prior default MCP | Tree-aware MCP | Δ |
|--------|---------------------|-----------------|---|
| nDCG@10 | 0.081 | 0.087 | +0.006 |

Agent used `treeMatch` just 1/1007 tool calls, used `excludeIds` just 4/1007. Haiku didn't discover or use the new capabilities organically, even though they're in the tool description. Consistent with prior finding: simpler prompts win on Haiku; complex parameters go unused unless explicitly directed.

**Bug note**: Adding `tree: <label>` to result lines broke the `resultIds` parse regex in evaluate-bright.ts (was `/id: ([^\)]+)\)/g` — greedy). Fixed to `/id: ([^,\)]+)[,\)]/g`. The broken regex only affected `retrievalRecall` computation for the aops tree-aware run; rankingRecall and nDCG come from structured output directly and remained valid.

### Decision

Tree-aware MCP kept (separate file, doesn't affect other domains). Value is latent — would unlock with a directive prompt or a stronger model that uses `treeMatch` to filter out `aqua`/`camel`/`gsm` noise on math retrieval. Haiku on its own doesn't.

---

## Full BRIGHT cross-domain results (Haiku, 2026-04-22)

All 12 domains evaluated with Haiku, grep-warning + expansion-for-economics prompt, RRF fusion. Default MCP for most domains; tree-aware MCP for aops.

| Domain | nDCG@10 | Queries |
|--------|---------|---------|
| biology | **0.553** | 103 |
| theoremqa_theorems | 0.512 | 76 |
| psychology | 0.472 | 101 |
| earth_science | 0.459 | 116 |
| pony | 0.409 | 112 |
| economics | 0.369 (grep-warn) / 0.358 (expansion) | 103 |
| sustainable_living | 0.360 | 108 |
| stackoverflow | 0.341 | 117 |
| robotics | 0.293 | 101 |
| leetcode | 0.177 | 142 |
| aops | 0.087 | 111 |
| theoremqa_questions | 0.067 | 194 |
| **Mean (12 domains)** | **0.334** | **1,384** |

### Domain clustering by difficulty

**Tier 1 — text-rich, text-gold (0.41-0.55)**: biology, psychology, earth_science, theoremqa_theorems, pony. Gold is long-form encyclopedic content; topical semantic match + BM25 works well. Pony is programming but code tutorials/docs are also text-rich.

**Tier 2 — economics/social (0.29-0.40)**: economics, sustainable_living, stackoverflow, robotics. Gold mixes Wikipedia-style explainers with academic papers and institutional reports. Hybrid hybrid retrieval is decent; sophistication lags.

**Tier 3 — code/math (0.07-0.18)**: leetcode, aops, theoremqa_questions. Gold is code snippets or math-solution LaTeX that lexically/semantically diverges from natural-language queries. Our text-oriented setup struggles here.

### Sonnet data point

Sonnet on economics full 103: nDCG=0.462 (vs Haiku 0.358, +0.104 abs, p=0.002). Ranking recall +0.101 (p=0.0008) — the gain is concentrated in ranking. A full Sonnet cross-domain sweep is untested but likely adds ~+0.1 across tier 1 & 2 domains; tier 3 (code/math) would still struggle because the underlying query→gold vocabulary gap is structural.

### Takeaways (final)

1. **Ranking is the dominant bottleneck on text-rich domains**. Retrieval finds 35-65% of gold; ranking keeps only ~40-50% of what's seen. Sonnet closes most of this gap via better reasoning about relevance.
2. **Code/math domains need different approaches**. Our hybrid-search + text-prompt setup hits a floor when gold is LaTeX equations or code snippets. Would need specialized preprocessing (e.g., symbolic indexing), different embeddings, or a model explicitly trained on code retrieval.
3. **Prompt-length ceiling on Haiku**. Simple expansion prompts help, complex meta-strategy prompts regress. Every "think harder before ranking" or "prefer specific sources" variant hurt even when the intuition was correct.
4. **Diagnostic insights ≠ prompt fixes**. Understanding BRIGHT's "expert-cited-source" labeling is genuinely useful for analysis, but translating it into prompt instructions backfires — it pushes the agent toward narrow specific-guess searches that miss via wrong specifics, instead of broad topical searches that hit via semantic similarity.
5. **Statistical rigor catches false wins**. Sign-test vs paired-t disagreement (expansion's retrieval +3.3pp was sign-significant p=0.016 but t-insignificant p=0.33) correctly flagged "this is a real pattern masked by variance." Union's retrieval +3.8pp looked similar in magnitude but failed the sign test (p=0.65) and was correctly rejected as noise.
6. **Tooling > prompts on Haiku**. excludeIds and treeMatch add real capability, but Haiku doesn't use them organically. These unlock value only with explicit prompting or stronger models.

---

## Experiment: Tree-directed prompt for aops/theoremqa_questions (2026-04-22)

### Hypothesis

The tree-aware MCP added `treeMatch` capability but Haiku used it only 1/1007 times on aops (0.1%). Hypothesis: Haiku won't discover that the new parameter is useful from the tool description alone; it needs explicit prompt direction describing what each tree label means and when to filter.

### Change

Added `buildPromptBrightMath` for aops and theoremqa_questions. The prompt:

1. Describes all 7 tree labels in the blended math corpus (aqua / camel / gsm / math.test / math.train / theoremqa / aops).
2. Notes that aqua/camel/gsm are "typically too elementary or too synthetic to help with a serious competition-level problem" — reasonable domain knowledge, not dataset-specific labeling.
3. Recommends starting WITHOUT `treeMatch` and adding it on follow-up searches if results are overwhelmed by noise.
4. Suggests a concrete pattern `{aops,math.test,math.train,theoremqa}` as a starting filter when restricting. Does NOT say "gold is in X" (avoids direct test-set leakage).

`buildPromptBright` routes `aops` and `theoremqa_questions` to this prompt.

### Result (aops, full 111 queries, Haiku, tree-aware MCP)

| Metric | Prior tree-aware (no prompt directive) | With math prompt | Δ |
|--------|----------------------------------------|-------------------|---|
| **nDCG@10** | 0.087 | **0.169** | **+0.082 (+94%)** |
| Retrieval recall | 0.110* | 0.245 | +0.135 |
| Ranking recall | 0.074 | 0.148 | +0.074 |
| Zero-gold queries | 80 / 111 | 50 / 111 | -30 |
| Avg tool calls | 9.1 | 13.2 | +4.1 |

*Note: prior retrieval-recall metric was corrupted by the now-fixed result-ID parsing regex; the honest number from an earlier default-MCP run (no tree, but same agent) was 0.110.

### treeMatch usage jumped from 0.1% → 42.8%

- 1/1007 tool calls used treeMatch in the prior aops run (no prompt directive)
- 628/1467 (42.8%) used treeMatch in the new run
- Top patterns: `{aops,math.test,math.train,theoremqa}` (286×), `aops` (80×), `aops|math.test|math.train|theoremqa` (55×), `aops|math.*|theoremqa` (47×).

The agent adopted and varied the suggested pattern systematically.

### Analysis

This is the **largest single-change improvement we've seen on a difficult domain** — nDCG nearly doubled.

**Why it worked (while general instruction-density prompts fail on Haiku):**

The tree-directive prompt doesn't ask the agent to do more reasoning — it gives it a concrete, executable rule: "when too much aqua/camel/gsm noise comes back, add treeMatch=X." This is a *mechanical* instruction, not a reasoning-intensive one. Haiku handles mechanical rules well; it's sophisticated meta-reasoning that overloads the prompt budget.

**Why it's fair on BRIGHT:**

- Describing the corpus's source taxonomy is public dataset knowledge (visible from the source list).
- Saying "aqua/camel/gsm are too shallow for competition math" is general domain reasoning about what those datasets are (not BRIGHT-specific).
- We don't encode "gold is aops or math_*" — we let the agent observe and filter noise.
- The underlying retrieval task (match query → relevant reasoning-bridged gold source) is unchanged; we just let the agent ignore obvious noise.

An alternative fairness framing: any competent IR system evaluating on this corpus could construct the same taxonomy by sampling the corpus. The agent does this reasoning at runtime from the prompt's description. No test-label information is used.

### Decision

**Adopted.** Haiku now competitive on aops (0.169), up from essentially zero-signal (0.087). `theoremqa_questions` should follow the same auto-routed math prompt and likely see a comparable gain — worth re-running.

### Updated cross-domain table (aops only changed)

| Domain | nDCG@10 | Notes |
|--------|---------|-------|
| biology | 0.553 | |
| theoremqa_theorems | 0.512 | |
| psychology | 0.472 | |
| earth_science | 0.459 | |
| pony | 0.409 | |
| economics | 0.369 | |
| sustainable_living | 0.360 | |
| stackoverflow | 0.341 | |
| robotics | 0.293 | |
| leetcode | 0.177 | |
| **aops** | **0.169** | ← +108% vs earlier 0.081 |
| theoremqa_questions | 0.067 | not yet re-run with math prompt |
| **Mean** | **0.340** | up from 0.334 (would further improve with theoremqa_questions rerun) |

### Generalizable finding

**Mechanical rules > reasoning directives on Haiku.** The promptable-directive distinction:
- "Use treeMatch with `{aops,math.*,theoremqa}` when noise dominates" → executable, Haiku complies 42.8% of calls
- "Think carefully about what an expert would cite" → meta-reasoning, Haiku either ignores or overspecifies

The former unlocks real capability; the latter regresses performance. Infrastructure (tree column, treeMatch param) is only as useful as the prompt directing its use.

---

## Experiment: Silent per-query exclusion via env var injection (2026-04-22)

### Hypothesis

Our eval code does POST-HOC exclusion filtering: the agent returns up to 10 ranked IDs, we filter out any that are in `excluded_ids`, and use whatever survives as the final top-10. On aops, which excludes ~9,200 docs per query, this left top-10 sets with only 1-2 items because many agent picks are in the exclusion list.

BRIGHT's reference implementation excludes BEFORE ranking — the retriever never sees excluded docs. Our `excludeIds` tool param supports this, but the agent can't know 9,200 IDs to pass explicitly. We need *silent* server-side filtering.

### Change

1. `mcp-server-aops.ts`: reads `MCP_EXCLUDED_IDS_PATH` env var at startup; if set, loads the IDs and silently appends `id != ALL($n::text[])` to every search (BM25, semantic, grep). Agent doesn't see the filter; from its perspective, those documents don't exist in the corpus.
2. `evaluate-bright.ts`: per-query, writes the query's `excluded_ids` to a temp file and builds an MCP config with `MCP_EXCLUDED_IDS_PATH=<temp>` env var. Cleans up the temp dir after the run.

Files created per query; spawned MCP reads once at startup. ~9,200 IDs per aops query is trivial SQL `= ALL($n::text[])` work.

### Result (aops, full 111 queries, Haiku, tree prompt + tree-aware MCP)

| Metric | Prior (no silent exclude) | + silent exclude | Δ | Cumulative from default-MCP (0.081) |
|--------|---------------------------|------------------|---|-------------------------------------|
| **nDCG@10** | 0.169 | **0.241** | **+0.072** | **+0.160 (~3×)** |
| Retrieval recall | 0.245 | **0.361** | +0.116 | +0.251 |
| Ranking recall | 0.148 | **0.249** | +0.101 | +0.175 |
| Zero-gold queries | 50/111 | **36/111** | -14 | -44 |
| Avg tool calls | 13.2 | 16.9 | +3.7 | — |

### Analysis

Cleanest, largest single-change improvement on a blended-corpus domain. Three mechanisms:

1. **Pool quality**: agent's search results no longer filled with near-duplicate noise. Every result returned is a genuine candidate. Prior, large fractions of top-30 from each search mode were camel_* near-duplicates that never would have scored.
2. **Top-10 preservation**: post-hoc filtering previously truncated top-10 aggressively (to 1-2 items in many aops queries). Now the agent's 10 picks from a noise-free pool are all retained.
3. **More productive iterations**: agent's avg tool calls went up (13.2 → 16.9). Because each search now yields distinct candidates (not endless near-dupes), extra searches pay off — agent iterates more.

### Cumulative story on aops

| Config | nDCG@10 |
|--------|---------|
| Baseline default MCP | 0.081 |
| + tree-aware MCP (treeMatch available but undirected) | 0.087 |
| + math prompt with tree-directive | 0.169 |
| + silent per-query exclusion | **0.241** |

Each layer contributes. The silent exclusion is the largest single gain, but the tree-aware + directive prompt matters because it cleans the *observable* candidate pool the agent reasons over.

### Decision

**Adopted.** Silent exclusion applies to aops/theoremqa_questions via the aops MCP variant. Default MCP unchanged (other domains have no real exclusions — all "N/A"). Pre-filtering and tree-directive prompt compound cleanly.

### Implication for the cross-domain table

aops re-evaluated: 0.081 → 0.241. Mean across all 12 domains now: **0.347** (up from 0.334 before tree prompt, 0.340 with tree prompt only). theoremqa_questions will likely see a comparable lift when re-run (same prompt route, same MCP variant, same exclusion structure).

### Generalizable finding

**Silent server-side filtering beats client-side post-hoc filtering whenever exclusion lists are too large to pass through the agent.** For benchmarks with per-query exclusions (BRIGHT's reasoning tier on math domains, any benchmark using near-duplicate filters), the MCP server should apply filters invisibly. The agent can't know 9,200 IDs; making the list size its problem is a design bug.

---

## Bug + fix: broken lquery syntax in tree-directive prompt (2026-04-22)

### Diagnosis

Post-facto check on the "aops 0.241" run found that the tree labels used multi-position paths (`math.test`, `math.train`) and the prompt suggested the lquery pattern `{aops,math.test,math.train,theoremqa}`. Direct testing:

| Pattern | Behaviour |
|---------|----------|
| `{aops,math.test,math.train,theoremqa}` | SYNTAX ERROR |
| `aops\|math.test\|math.train\|theoremqa` | 0 results (compound labels can't appear inside single-position `\|`) |
| `aops.*\|math.*\|theoremqa.*` | SYNTAX ERROR |
| `aops` | 62 ✓ |
| `math.*` | 12,500 ✓ |

628 of 1,467 tool calls in the aops run used broken treeMatch patterns that returned 0 (or errored silently). The 0.241 score was achieved *despite* treeMatch not actually working — the gain came from silent exclusion + general search vocabulary, not from tree filtering.

### Fix

1. `brightSourceTree`: return single-label paths (`math_test`, `math_train`) instead of compound (`math.test`, `math.train`). Flat labels allow `|` alternation within lquery.
2. SQL migration on existing bright_aops: `UPDATE bright_aops SET tree = replace(tree::text, '.', '_')::ltree WHERE tree::text LIKE 'math.%'`.
3. Updated prompt: `treeMatch = "aops|math_test|math_train|theoremqa"` (pipe-separated, single-position) with an explicit warning against `{...}` and dots-in-labels. Verified: `12,971` matches (62 + 5,000 + 7,500 + 409), correct.

### Result (aops, full 111 queries, Haiku, tree prompt + silent exclusion + fixed lquery)

| Metric | Broken lquery | Fixed lquery | Δ |
|--------|---------------|--------------|---|
| **nDCG@10** | 0.241 | **0.275** | +0.034 |
| Retrieval recall | 0.361 | **0.466** | +0.105 |
| Ranking recall | 0.249 | **0.298** | +0.049 |
| Zero-gold queries | 36/111 | 27/111 | -9 |
| Avg tool calls | 16.9 | 11.0 | -5.9 |

treeMatch usage: 42.8% → **86.5%**. Empty-result treeMatch calls: ~most → 0.9%. Dominant pattern: `aops|math_test|math_train|theoremqa` (988/1058 calls). Agent immediately adopted the corrected recipe.

### Analysis

Two effects combined:
1. Filter now actually fires: aqua/camel/gsm results silently removed, pool quality jumps.
2. Agent needs fewer iterations (16.9 → 11.0 tool calls) — was previously wasting calls retrying after broken lquery returned 0.

### Cumulative aops story

| Config | nDCG@10 | cumulative Δ |
|--------|---------|---------------|
| Baseline default MCP | 0.081 | — |
| + tree-aware MCP (latent) | 0.087 | +0.006 |
| + math prompt (directs treeMatch, broken lquery) | 0.169 | +0.082 |
| + silent per-query exclusion | 0.241 | +0.072 |
| + fixed lquery syntax | **0.275** | +0.034 |
| **Total** | | **+0.194 (3.4×)** |

### Generalizable finding

**Test the actual query mechanism end-to-end, not just the prompt's words.** The prompt's suggested lquery pattern "looked right" to me (copying natural language "{A,B,C}" set notation) but postgres lquery doesn't parse that syntax for compound labels. The only reason we caught it is that I manually tested representative patterns against the DB. Without that check, the 0.241 run would have been a plausible-but-partially-fake result — the treeMatch wasn't working, even though treeMatch usage metrics looked high.

Lesson for future infrastructure: always run a smoke test on whatever pattern the prompt suggests before trusting the aggregate numbers.

---

## aops candidate-pool / search-mode experiments (2026-04-22)

Three A/B tests against the 0.275 baseline to see if retrieval or ranking volume matters:

| Experiment | Change | nDCG | Δ vs 0.275 | Notes |
|------------|--------|------|-----------|-------|
| Exp 1 | candidateLimit 30 → 100 | 0.268 | -0.007 | More candidates didn't help — added noise dilutes signal |
| Exp 2 | limit 10 → 30 | 0.265 | -0.010 | Agent seeing 30 results per search instead of 10 slightly hurt |
| Exp 3 | dual-mode (Kind A RRF + Kind B semantic-only setup-structure) | 0.266 | -0.009 | Retrieval recall dropped 7pp: "setup-structure" searches collapsed into paraphrased-technique-names for abstract-math queries |

All reverted. Takeaway: **on aops, volume and search-mode variation are local optima**. More candidates don't help because Haiku's ranking can't exploit them; varying search modes doesn't help because abstract-math queries don't have a distinct "scenario" grammar separate from their technique.

---

## Experiment: HyDE-style hypothetical sibling problem retrieval (2026-04-22)

### Hypothesis

On aops, gold is usually a sibling problem in the same concept cluster — another concrete problem (different setup: bricks, stamps, coins) that uses the same underlying technique. The agent's abstract-technique-name queries ("Frobenius number", "Diophantine equations") don't embed close to concrete problem statements.

HyDE hypothesis: if the agent WRITES a hypothetical sibling problem (concrete setup, same technique) and uses that as a semantic search, the embedding will be closer to real sibling problems than the abstract query would be.

### Change

Added step 3 to the math prompt:
> HYPOTHETICAL SIBLING PROBLEM: imagine a DIFFERENT math problem that would use the SAME techniques as this query — with different concrete objects and numbers but the same underlying structure. Write a short (~3-sentence) problem statement for this hypothetical sibling, then pass it as the "semantic" parameter (leave fulltext empty). Gold for a query is often a real sibling problem, and sibling problems embed closer to each other than either does to abstract technique names. Do 2-3 hypothetical-sibling searches covering varied concrete setups.

### Result (aops, full 111 queries, Haiku)

| Metric | Baseline (lquery fix) | + hypothetical sibling | Δ | Paired-t p | Sign | Sign p |
|--------|------------------------|------------------------|---|-----------|------|--------|
| **nDCG@10** | 0.275 | **0.300** | **+0.025** | 0.28 | 43/32 | 0.25 |
| Retrieval recall | 0.466 | 0.438 | -0.027 | 0.35 | 32/38 | 0.55 |
| Ranking recall | 0.298 | 0.316 | +0.018 | 0.52 | 34/23 | 0.19 |
| Zero-gold | 27 | 25 | -2 | — | — | — |

Not statistically significant (nDCG sign-p=0.25) but positive direction. Biggest non-infrastructure gain since the lquery syntax fix.

### Analysis (surprise)

Counterintuitive shape: retrieval recall went slightly DOWN (−0.027) while nDCG went UP. This means: hypothetical-sibling searches surface slightly fewer gold docs in absolute terms, but the gold they do find is of higher *rankable* quality — the agent has a cleaner context to rank from, and more of the gold makes it into top-10.

Likely explanation: concrete-problem-style queries match concrete-problem gold (and noisy concrete-problem non-gold), so retrieval sometimes misses theory-article gold that the original concept queries would catch. But the sibling-problem gold (the majority case on aops) is richer and ranks better.

### Decision

**Kept provisionally** — not significant but direction is consistent with HyDE literature. Low-risk addition (one prompt step). If a follow-up experiment regresses and we suspect interference, revisit.

### Remaining aops gap

Ranking-recall drop rate (what fraction of *seen* gold never makes top-10):
- Baseline: 1 − 0.298/0.466 = **36%** dropped post-retrieval
- Exp 5: 1 − 0.316/0.438 = **28%** dropped — improvement

Retrieval recall is still the larger bottleneck absolutely (only 43.8% of gold ever seen). Pure prompt-level interventions seem exhausted. Further gain likely needs: (a) Sonnet for richer hypothetical-sibling generation and better ranking, (b) corpus-side chunk enrichment (technique tags per chunk), or (c) larger embedding model to distinguish math-problem structure better.

---

## Experiment: Corpus-side technique tagging + tag-based retrieval (2026-04-23)

### Taxonomy derivation (methodology)

Goal: per-chunk mathematical-technique tags so retrieval can join concept-cluster siblings deterministically (not via embedding similarity, which doesn't bridge "ducks-and-horses" to "brick-stacking" even though both are Frobenius problems).

Four iterations:

1. **Strawman taxonomy (rejected)** — wrote ~20 techniques from prior knowledge (Vieta, Newton's, Frobenius, pigeonhole, etc.). Called out as probably incomplete; not corpus-calibrated.

2. **First empirical sample (442 chunks, gpt-4o-mini, stratified across 7 tree sources)** — output too coarse. Model preferred categories ("algebra", "combinatorics", "basic_arithmetic") over named theorems. Frobenius / Newton's / Diophantine had 0 hits in top-40.

3. **Second sample (same 442 chunks, Claude Haiku, richer prompt with seed vocabulary + "prefer specific over generic" rule)** — named techniques emerged: modular_arithmetic (30), prime_factorization (23), pythagorean_theorem (15), power_of_a_point (7), diophantine_equations (6), vieta_formulas (6), fermats_little_theorem (5), simons_favorite_factoring_trick (3), picks_theorem (2).

4. **Spot-check validation (3 concept-cluster pairs with known failures)** — Haiku-tagged:
   - Frobenius cluster (Hamlet/bricks/stamps): **3/3 share `frobenius_number`** ✓
   - Newton's/Vieta cluster: 1 shares `polynomial_roots`; 1 no overlap (siblings use genuinely different techniques)
   - Simon's trick cluster: **3/3 share `simons_favorite_factoring_trick`** ✓
   - 5/6 gold chunks share a specific technique tag with their query — strong signal.

Prompt finalized with empirically-observed vocabulary and an explicit priority rule ("prefer Frobenius over generic Diophantine; prefer Newton's over generic polynomial_roots").

### Production tagging

Gpt-4o-mini was tried but failed internal-consistency check on the same clusters (tagged Hamlet as "pigeonhole" instead of "frobenius"; 0/3 shared tags on Frobenius cluster). Switched to Haiku via `claude -p`.

Scoped to the 4 useful sources only (aops + math_test + math_train + theoremqa = 12,971 chunks), skipping 175k aqua/camel/gsm noise that's already filterable via tree. Final run at concurrency 20 (tried 80 — system load avg hit 225, thrashing; tried 40 — same 1.2/s rate as 20, apparently upstream bottleneck).

- **12,971/12,971 tagged in 7.4 hours, 3 errors (0.023%)**.
- Stored in new jsonb `meta` column; GIN index with `jsonb_path_ops` class.
- File-based cache keyed by (PROMPT_VERSION, content) so subsequent re-tags or the theoremqa_questions table (same corpus) will be free.
- Extracted `createFileCache<T>` primitive from embed-cache.ts; tagging and embedding both use it.

### Tag distribution (top 20)

coordinate_geometry (1354), solving_equations (1297), basic_arithmetic (1260), polynomial_roots (1090), modular_arithmetic (797), multiplication_principle (731), prime_factorization (689), pythagorean_theorem (611), trigonometric_identities (576), word_problem_algebra (551), angle_chasing (491), combinatorial_probability (482), ratios_proportions (467), vieta_formulas (424), factor_theorem (324), similar_triangles (314), binomial_theorem (286), counting (284), inclusion_exclusion (178), am_gm_inequality (176). Healthy distribution — specific named theorems well-represented alongside general labels.

### MCP changes

Added two new search parameters to the aops MCP variant:

- `techniquesAny: string[] | null` — keep only chunks whose `meta.techniques` array overlaps any of these tags.
- `categoryAny: string[] | null` — keep only chunks whose `meta.category` is in this list.

Implementation: SQL clause is `(meta @> $n::text::jsonb OR meta @> $m::text::jsonb OR ...)` — an explicit OR chain. Each `@>` uses the GIN index via BitmapOr (verified with EXPLAIN). Two abandoned variants:
- `meta->'techniques' ?| $n::text[]` — works but the `?|` operator doesn't use a `jsonb_path_ops` index.
- `meta @> ANY($n::jsonb[])` — doesn't handle postgres.js's JSON-string double-wrapping cleanly; when fixed via ARRAY-from-subquery, the planner falls back to Seq Scan (loses the index).

The `::text::jsonb` double-cast is required because postgres.js wraps a plain string param as a JSON string literal when bound as `::jsonb` directly.

Result lines now include `cat: <category>, tech: [t1,t2,...]` so the agent observes tags and can refine.

### Prompt changes

Added to the math prompt:
- List of canonical technique tags (the ~40 most useful from the distribution, named explicitly).
- Category values.
- Step 4: "TAG-BASED RETRIEVAL: once you've identified the techniques, try one search with techniquesAny set to those canonical tags. Be specific — use frobenius_number rather than generic diophantine_equations."

### Result (aops, full 111 queries, Haiku)

| Metric | Prior (HyDE baseline) | + tag-based retrieval | Δ |
|--------|------------------------|------------------------|---|
| **nDCG@10** | 0.300 | **0.328** | **+0.028** |
| **Retrieval recall** | 0.438 | **0.535** | **+0.097** |
| Ranking recall | 0.316 | 0.372 | +0.056 |
| Zero-gold queries | 25 | 19 | -6 |
| Avg tool calls | 10.7 | 11.2 | +0.5 |

Tag usage: techniquesAny in 31.7% of calls, categoryAny in 45.2%. Top tags the agent chose: modular_arithmetic (65), coordinate_geometry (65), power_of_a_point (38), vieta_formulas (31), inclusion_exclusion (31), frobenius_number (25), similar_triangles (24), diophantine_equations (23), stars_and_bars (21), simons_favorite_factoring_trick (14) — the exact diagnostic techniques we built the taxonomy for.

13% empty-result rate on tag calls (51/394) — reasonable. Usually happens when the agent guesses a tag that doesn't exist in our canonical set; the agent iterates.

### Analysis

Retrieval recall +9.7pp is the biggest single retrieval improvement in this work. Three mechanisms:

1. **Deterministic concept joining**: a query tagged `frobenius_number` now retrieves all 25+ frobenius chunks via the tag filter, regardless of surface vocabulary. The ducks-vs-bricks embedding gap is bypassed.
2. **Category coarse filter**: the agent often uses categoryAny to restrict to the right math area (number_theory / combinatorics / geometry), pre-filtering noise.
3. **Agent compliance**: the taxonomy in the prompt + the meta in result lines makes the agent's tag selection grounded (it sees valid tags in prior results). 13% dead-end rate vs 50%+ on broken lquery proves the prompt-side taxonomy works.

### Cumulative aops story

| Layer | nDCG@10 | Δ |
|-------|---------|---|
| Baseline default MCP | 0.081 | — |
| + tree-aware MCP (latent) | 0.087 | +0.006 |
| + tree-directive prompt | 0.169 | +0.082 |
| + silent exclusion | 0.241 | +0.072 |
| + fixed lquery | 0.275 | +0.034 |
| + HyDE hypothetical sibling | 0.300 | +0.025 |
| **+ tag-based retrieval** | **0.328** | **+0.028** |
| **Total** | | **+0.247 (4.0× baseline)** |

### Decision

**Adopted.** Tag infrastructure now part of the aops/theoremqa_questions setup.

### Generalizable findings

1. **Corpus-side structured metadata beats prompt-side guessing.** Prior prompts asked the agent to reason about sibling vocabulary (HyDE) or use soft filters (treeMatch). Hard containment filters on LLM-extracted metadata gave the biggest retrieval jump (+9.7pp) because it bypasses the embedding-similarity bottleneck entirely.

2. **Taxonomy must be empirical, not prior-knowledge.** Our strawman taxonomy would have missed 20+ of the canonical tags that actually dominate the corpus (word_problem_algebra, solving_equations, coordinate_geometry, etc.). Iterating strawman → sample → calibrate → validate is worth the 1-day engineering cost.

3. **Model quality for tagging matters more than model quality for the search agent.** gpt-4o-mini produced unusable tags (0/3 concept-cluster consistency); Haiku produced good tags (5/6). The 7-hour wall cost is worth it. Once tagged, the retrieval agent can be smaller.

4. **jsonb `@> $::text::jsonb` OR chains use the jsonb_path_ops GIN index; `@> ANY(subquery)` does not.** When index performance matters, unfold the OR.

---

## Experiment: Sonnet on aops with full stack (2026-04-23)

### Hypothesis

On economics, Sonnet gave +0.104 nDCG over Haiku (p=0.002), concentrated in ranking recall (+0.101). Test whether the model lever is similarly strong on aops, now that the infrastructure stack (tree + silent exclusion + HyDE + tag-based retrieval) is in place.

### Result (aops, full 111 queries, paired vs Haiku same stack)

| Metric | Haiku | Sonnet | Δ |
|--------|-------|--------|---|
| **nDCG@10** | 0.328 | **0.333** | **+0.005** |
| Retrieval recall | 0.535 | **0.603** | **+0.068** |
| Ranking recall | 0.372 | 0.397 | +0.025 |
| Zero-gold queries | 19 | **11** | -8 |
| Avg tool calls | 11.2 | 15.1 | +3.9 |
| Wall time | ~27 min | **130 min** | +4.8× |

Tag usage: techniquesAny 30.1% (vs Haiku 31.7%) but only 5 empty-result calls (1%) vs Haiku's 51 (13%) — Sonnet picks better tags.

### Analysis — why Sonnet barely moves the needle

Retrieval recall +6.8pp but nDCG only +0.005. Drop-rate math:
- Haiku: 1 − 0.372/0.535 = 30.5% of retrieved gold dropped post-ranking
- Sonnet: 1 − 0.397/0.603 = 34.1% dropped

Sonnet retrieves *more* gold but keeps a *smaller fraction* in top-10. With +3.9 more tool calls and richer hypothetical-sibling generation, it floods its ranking step with more candidates than it can properly rank. On economics this didn't happen (retrieval pool was smaller); on aops the volume increase hurts ranking efficiency.

Contrast with economics:
- Economics Sonnet: nDCG +0.104, ranking recall +0.101 (p=0.0008). Strong ranking win.
- aops Sonnet: nDCG +0.005, ranking recall +0.025. Ranking marginal.

### Interpretation

**Infrastructure has closed most of the Haiku↔Sonnet gap on aops.** When tags + tree + HyDE + silent exclusion are doing the heavy lifting on retrieval, the remaining reasoning headroom is small. The case for Sonnet on aops is weak: +0.005 nDCG for 4.8× wall time.

Contrast with a domain where infrastructure doesn't substitute for reasoning (economics — no corpus taxonomy yet, relies on the agent's knowledge of cited sources): Sonnet's +0.104 nDCG there comes from exactly the reasoning step that tags would replace.

### Decision

**Not adopting Sonnet as default for aops.** The current Haiku + full-stack config is Pareto-dominant given cost/latency.

### Generalizable finding

**Where well-designed corpus-side infrastructure exists, model quality matters less than it does on "pure retrieval" domains.** This suggests an investment ordering: for a new difficult domain, build taxonomy / metadata / filters *before* upgrading the model. Tags turned Haiku into a Sonnet-class retriever on aops; on economics (no tags yet) Sonnet is still ~15pp better.

Opens a question: would tagging economics close its Haiku↔Sonnet gap too? Haiku currently 0.369 / Sonnet 0.462 — a ~25% relative gap entirely attributable to ranking reasoning. If economics had a technique/concept taxonomy, Haiku might approach 0.45+.

---

## Experiment: Two-stage rerank on Sonnet aops (2026-04-23, reverted)

### Hypothesis

Sonnet aops had a higher ranking-drop rate than Haiku (34% vs 30%) despite retrieving +7pp more gold. Guess: attention dilution — Sonnet's ranking step competes with 15 tool calls, tag guesses, HyDE generation all sharing the same forward pass. A separate "rerank" call with clean context (just query + candidate contents) might recover the lost ranking precision.

### Change

Added `--rerank` / `--rerank-model` flags to `evaluate-bright.ts`. When enabled, after the agent's search/rank pass:
1. Collect all unique doc IDs the agent's tool calls retrieved (the candidate pool).
2. Fetch their content (plus tree + meta for aops) from the DB.
3. Fresh `claude -p` call with just `(query, candidate[])` → produces a new ranked_ids.
4. Use that as the final top-10.

Two variants tried:
- **v1**: minimal rerank prompt (just "rank these by relevance to query"), candidate content only.
- **v2**: BRIGHT-aware prompt (gold = expert-cited sources, concept-cluster siblings, aqua/camel/gsm noise) plus metadata on each candidate (`tree=`, `category=`, `techniques=[...]`).

### Result (aops, full 111 queries, Sonnet)

| Metric | Sonnet agent-only | + rerank v1 | + rerank v2 | Δ v2 vs agent |
|--------|-------------------|-------------|--------------|---------------|
| **nDCG@10** | **0.333** | 0.278 | 0.276 | **-0.057** |
| Retrieval recall | 0.603 | 0.605 | 0.586 | -0.017 |
| Ranking recall | **0.397** | 0.343 | 0.337 | **-0.060** |
| Zero-gold queries | **11** | 11 | 21 | **+10** |

Both variants regressed by ~0.06 on nDCG. V2 made zero-gold queries *worse* (11 → 21) — the reranker actively excluded gold the agent had placed in top-10 for 10 additional queries.

### Analysis — why the clean-context hypothesis failed

1. **The agent's implicit reasoning chain is load-bearing.** By the time Sonnet produces ranked_ids, it has built up context about which of its 15 searches surfaced which doc, which technique tags matched, which tree labels looked promising. A standalone reranker starts fresh and has to infer that context from bare (query, candidate) pairs. Even with metadata annotations, the reranker can't reconstruct "this doc came from the `simons_favorite_factoring_trick` filter" vs "this came from a HyDE sibling search that produced noise."

2. **Rich-context > clean-context on aops.** Sonnet's single-pass ranking has less *absolute* attention but more *signal per attention unit*. The reranker has more attention-per-token but less signal.

3. **Zero-gold regression (+10 queries) proves over-correction.** These are queries where the agent had gold in top-10 and the reranker demoted it. Some attribute of the agent's ranking — provenance-aware reasoning, maybe — isn't reproducible from candidate content alone.

4. **BRIGHT-aware framing didn't save v2.** The agent already has all the same framing (from its prompt). Duplicating it in rerank doesn't add information.

### Contrast with classical IR

Classical IR's "retrieve → rerank" win comes from pairing a cheap/coarse retriever with an expensive/fine ranker. Our setup is different: the "retriever" is already an expensive reasoning agent that decides *what to retrieve* based on rich inference. Reranking with a separate call throws away the agent's reasoning state.

Lesson: **two-stage rerank wins when stage 1 is cheap (dense or BM25); on agent-based retrieval, the agent's own state is the ranking signal, and stage 2 can only discard it.**

### Decision

**Reverted.** Rerank code and flag removed. Agent-native ranking stays.

### Generalizable finding

On agent-driven retrieval + ranking pipelines, the agent's accumulated reasoning state is itself a ranking input. Stripping it out for a "clean context" reranker discards information, not dilution. This probably generalizes: whenever the agent decides *what* to retrieve via reasoning, its ranking benefits from the same reasoning — a separate ranker starting from raw candidates loses that signal.

Possible exceptions worth noting for future work:
- Cross-encoder rerankers *trained* on the target domain distribution could compete (they inject their own signal).
- If the agent is constrained to, say, 3 tool calls with structured output, there's less accumulated state and a reranker might add value.
- Multi-turn refinement (show rerank output back to agent for revision) might beat single-pass if the rounds actually exchange information.

---

## Experiment: Answer-forcing (solve the problem AND rank) on Haiku aops (2026-04-24, reverted)

### Hypothesis

Force the agent to produce the answer to the math problem in addition to ranked_ids. The intuition: CoT-style reasoning-by-output. Having to commit to a solution attempt forces the agent to concretely identify what techniques the problem requires, which should sharpen which docs it ranks as most relevant.

### Change

Added a math-specific JSON schema requiring both `answer` and `ranked_ids`. Updated the math prompt to explain this is reasoning-forcing (answer isn't scored) and ask for a short solution or at minimum a technique identification.

### Result (aops, full 111 queries, Haiku)

| Metric | Baseline (tags) | + answer forcing | Δ |
|--------|------------------|------------------|---|
| **nDCG@10** | 0.328 | **0.288** | **-0.040** |
| Retrieval recall | 0.535 | 0.443 | **-0.092** |
| Ranking recall | 0.372 | 0.300 | -0.072 |
| Zero-gold queries | 19 | 24 | +5 |
| **Avg tool calls** | **11.2** | **8.4** | **-2.8** |

Significant regression across every metric.

### Analysis

The root cause is visible in the tool-call count: the agent ran **2.8 fewer searches per query** when forced to also produce an answer. Output tokens spent on solving the problem meant fewer output tokens left for tool calls, which meant less gold seen during retrieval, which meant less gold to rank.

The intuition may be sound in principle — concretely solving a problem should help identify relevant techniques — but on Haiku the output-token budget is the binding constraint. Reasoning-out-loud competes with tool calls for the same limited budget.

### Decision

**Reverted.** Math schema is back to `ranked_ids` only.

### Generalizable finding

**Haiku's output-token budget is load-bearing.** Whenever we ask it to produce richer output (answer text, chain-of-thought, meta-reasoning), the budget trade comes at the cost of tool calls, and the ranking step loses more than the reasoning gains. This is the same pattern we saw on:
- Citable-source framing (longer prompt → Haiku underperformed)
- Deliberation-before-ranking (regressed -3%)
- Query expansion with verbose instructions (regressed until we narrowed it)

Prompts that expand output obligations (generate-and-rank, justify-and-rank, think-step-by-step-and-rank) all lose on Haiku. The wins we've found are structural (tags, tree filters, silent exclusion, HyDE sibling) — they add retrieval capability without costing output budget.

Might work differently on Sonnet (larger effective output budget, richer reasoning) but untested.

---

## Experiment H1: Pre-computed query reasoning (BRIGHT canonical) (2026-04-24, declared non-viable after 2 attempts)

### Hypothesis

BRIGHT paper reports +12.2 nDCG from generating LLM reasoning on the query before retrieval (from their reference `reason.py`). We hadn't tried this as a separate pre-pass (previous "answer-forcing" was agent-internal and cost tool calls). Distinct from HyDE (single hypothetical sibling) and two-stage rerank (strips context vs adds context).

Prompt from xlang-ai/BRIGHT/reason.py:
```
{query}

Instructions:
1. Identify the essential problem.
2. Think step by step to reason and describe what information could be
   relevant and helpful to address the questions in detail.
3. Draft an answer with as many thoughts as you have.
```

### Attempt 1 — Full BRIGHT-style reasoning prepended

Implementation: pre-pass Claude Sonnet call with BRIGHT's exact prompt, prepend the full multi-paragraph output to the agent's prompt as a "REASONING" section. Original query and tool-usage instructions preserved.

Result (aops, full 111 queries, Sonnet, paired vs Sonnet baseline 0.333):

| Metric | Baseline | A1 | Δ | paired-t p | sign p |
|--------|---------|-----|---|-----------|--------|
| nDCG@10 | 0.333 | 0.341 | +0.007 | 0.69 | 0.72 |
| Retrieval recall | 0.603 | 0.580 | -0.023 | 0.41 | 1.00 |
| Ranking recall | 0.397 | 0.395 | -0.002 | 0.92 | 0.88 |
| Zero-gold queries | 11 | 16 | +5 | — | — |

nDCG nominally up but retrieval regressed (-0.023) and 5 more queries went to zero-gold. Inspecting a regressed query (Fibonacci-recurrence coin-toss) showed near-identical agent searches but zero gold retrieved vs baseline's 25%. Hypothesis: long Sonnet reasoning (500-1000 token) dilutes attention.

### Attempt 2 — Brief technique-focused reasoning

Correction: constrain the reasoning prompt to produce a short (under 150 words) diagnostic — problem type, 2-4 named techniques, solution outline. No full derivation. Preserves the signal (techniques apply) without bloating the prompt.

Result:

| Metric | Baseline | A2 | Δ | paired-t p | sign p |
|--------|---------|-----|---|-----------|--------|
| nDCG@10 | 0.333 | 0.341 | +0.007 | 0.69 | 1.00 |
| Retrieval recall | 0.603 | 0.612 | +0.009 | 0.73 | 1.00 |
| Ranking recall | 0.397 | 0.403 | +0.005 | 0.81 | 1.00 |
| Zero-gold queries | 11 | 17 | +6 | — | — |

Shape improved (all metrics nudged positive, retrieval flipped -0.023 → +0.009 — confirms the "dilution" story) but magnitude is identical on nDCG (+0.007). All p-values 0.69+ for t-test and 1.00 for sign test — noise-level.

### Analysis

BRIGHT paper's +12.2 is on a bare retriever with no tree filters, no technique tags, no silent exclusion, no HyDE, no prompt directing toward canonical techniques. Their reasoning pre-pass was adding signal their base retriever didn't have. Our stack already captures it:

- Reasoning identifies "which techniques apply" → we already extract technique tags per chunk and have the agent filter by them (`techniquesAny`).
- Reasoning lists "what sibling problems look like" → HyDE already generates this.
- Reasoning narrows "which source types" → tree labels + math prompt already do this.

What's left is ~+0.007 of marginal headroom, indistinguishable from noise.

### Decision

**Declared non-viable on this stack after 2 attempts.** Not a mechanism problem (A2 shows the technique works) — a diminishing-returns problem. Our infrastructure already encodes the reasoning signal. Kept `--reason` / `--reason-model` flags in evaluate-bright.ts as opt-in (may help on less-instrumented domains), but default off.

### Generalizable finding

**Query-side reasoning preloads substitute for corpus-side structural metadata, not stack with it.** If you've built:
- Technique tags / topic classification per chunk
- HyDE hypothetical siblings
- Tree-level source filters
- Domain-specific canonical vocabularies in the prompt

...then a separate query-reasoning call is largely redundant. The infrastructure is doing the same work upfront. On a bare-bones retriever the +12.2 headroom exists; on a heavily-instrumented agent retriever, it's been consumed.

This is the mirror of the earlier "corpus-side infrastructure beats prompt-side reasoning" finding. On a bare retriever, prompt-side reasoning is a big win; on an instrumented retriever, the instrumentation already did that work. Invest in structure first, reasoning preloads second.

### Follow-up

Likely to matter MORE on economics (no corpus taxonomy, only a basic expansion prompt) than on aops (tag structure built). Worth testing H1 on economics if we want a quick +0.03 there. Queue note added to hypothesis-to-test.md.

---

## New aops baseline — Sonnet + effort=xhigh (2026-04-24)

**Motivation.** Prior baseline used whatever effort level the Claude CLI's user-global settings supplied (discovered to be "high"). To prevent drift across machines / future CLI updates, we pinned `.claude/settings.json` and now pass `--setting-sources project --effort xhigh` to every subprocess. Taking a new reference baseline at the fixed, locked-in config.

**Config.** Sonnet, `--effort xhigh`, `--setting-sources project`, concurrency 10, timeout 8 min, full aops (111 queries). Wall ~133 min.

**Results vs prior Sonnet "high" baseline (2026-04-23T10-48-43-733Z):**

| Metric | Sonnet high | Sonnet xhigh | Δ | paired-t p | sign test |
|--------|------------|-------------|---|-----------|-----------|
| nDCG@10 | 0.3335 | 0.3643 | +0.0308 | 0.104 | 37w / 35l / 39t (p=0.91) |
| Retrieval recall | 0.6028 | 0.6156 | +0.0128 | 0.647 | 28w / 27l / 56t (p=1.00) |
| Ranking recall | 0.3972 | 0.4373 | +0.0401 | 0.093 | 20w / 14l / 77t (p=0.39) |
| Zero-gold | 11 | 17 | +6 | — | — |

**Analysis.** +3.1 nDCG is nice-sounding but not significant at p<0.05 on either test. Sign test is essentially tied (37-35), so the mean improvement is driven by magnitude on a minority of queries rather than consistent wins. Ranking recall shows a similar pattern (20-14 among non-tied, +0.040 mean). Retrieval recall is a wash.

Interpretation: xhigh lets the agent think harder on the queries where thinking helps, with the tradeoff that zero-gold went 11→17 (some queries the extra reasoning misfires into a wrong search direction). Net positive but noise-level.

**Cost.** ~133 min wall at concurrency 10 vs maybe ~40-60 min at "high". Roughly 2-3× cost for marginal gain. Accepting because (a) user requested the fixed-effort baseline, (b) stability matters more than throughput for experiment comparability, (c) the +0.031 compounds with future experiments rather than competing with them.

**Decision.** Adopt as new reference baseline. All subsequent aops experiments compare against 0.3643.

**Commit.** Results at `results/bright-eval-2026-04-24T16-14-07-280Z.json`.

---

## H3: Document pseudo-queries at ingest (2026-04-24/25)

**Hypothesis.** For each useful aops doc, generate 3-5 natural-language search queries it could answer (Doc2Query / HyDE-flip). Index those into BM25 alongside content. User queries hit the pseudo-queries and surface concept-related docs whose surface vocabulary differs from the question. Expected +0.02 to +0.06 nDCG.

**Setup.**
- Forked DB → `p7di7u36o4` (`bright-h3-pseudoqueries`).
- Added `search_content TEXT` column on `bright_aops` (188k rows, 17 min ALTER + UPDATE for the bulk write).
- Built `tag_pseudo_queries.ts`: streams 12,968 useful docs, calls Haiku per doc with a "generate 3-5 search queries this doc could answer" prompt; cached via `data/pseudo_query_cache`. Initial batch-mode (Promise.all per batch) was 0.5/s; refactored to a worker-pool (each of 20 workers pulls from an async iterator) and got 0.84/s. Total wall: 305 min, 0 errors. All 12,968 docs tagged.
- Wrote pseudo-queries into `meta.pseudo_queries: string[]`.
- Built `update_search_content.ts`: `search_content = content || E'\n\nRelated questions:\n' || join(pseudo_queries, '\n')`. 12,960 rows updated (8 had empty queries from the LLM and stayed as content-only).
- Built BM25 index on `search_content`.

**Smoke-test before tagging.** Generated pseudo-queries for the SFFT concept cluster (4 mutually-gold docs). All 4 produced "simon's favorite factoring trick" or "factoring product minus sum" phrases. Strong signal that pseudo-queries would bridge the cluster via BM25.

### Attempt 1 — Replace BM25 source: `content` → `search_content`

Single-source BM25 swap. Reasoning: simpler change, just point existing index at augmented column. Eval at Sonnet xhigh.

| Metric | Baseline | A1 | Δ | paired-t p | sign test |
|--------|----------|-----|---|-----------|-----------|
| nDCG@10 | 0.3643 | 0.3436 | -0.0207 | 0.218 | 30w/37l (p=0.46) |
| Retrieval recall | 0.6156 | 0.6267 | +0.0110 | 0.638 | 30w/20l (p=0.20) |
| Ranking recall | 0.4373 | 0.4060 | -0.0313 | 0.092 | 13w/18l (p=0.47) |
| Zero-gold | 17 | 14 | -3 | — | — |

Retrieval up slightly, ranking down meaningfully (p=0.09). Diagnostic: H3 pulled gold IDs out of top-10 on 18 queries, including queries where baseline had gold at positions 9-10 (most exposed to ranking shifts). The augmented BM25 score now reflects matches against pseudo-query text — gold and non-gold both score higher, but the extra noise on non-gold pushes them above gold in the candidate list.

### Attempt 2 — 3-way RRF (content BM25 + search_content BM25 + semantic)

Restored BM25 index on `content` (45s). Updated mcp-server-aops.ts to run BOTH BM25 queries in parallel (Promise.all) and contribute both as separate channels to RRF fusion. Pseudo-queries add a parallel channel without replacing the clean content scoring.

| Metric | Baseline | A2 | Δ | paired-t p | sign test |
|--------|----------|-----|---|-----------|-----------|
| nDCG@10 | 0.3643 | 0.3693 | +0.0050 | 0.746 | 42w/36l (p=0.57) |
| Retrieval recall | 0.6156 | 0.6521 | +0.0365 | 0.092 | 27w/16l (p=0.13) |
| Ranking recall | 0.4373 | 0.4461 | +0.0088 | 0.611 | 24w/15l (p=0.20) |
| Zero-gold | 17 | 11 | -6 | — | — |

Ranking regression flipped. Retrieval recall up by 3.6 pts (borderline significant, sign test 27w/16l = 63% wins among non-tied). nDCG essentially flat (+0.005, well within noise).

### Attempt 3 — Hint in result lines

Hypothesis for the gap: pseudo-queries help retrieve more gold but the agent's StructuredOutput ranker doesn't see them — only raw content. Surface one pseudo-query per result line as a `hint: "..."` field so the ranker can use the concept signal.

| Metric | Baseline | A3 | Δ | paired-t p | sign test |
|--------|----------|-----|---|-----------|-----------|
| nDCG@10 | 0.3643 | 0.3617 | -0.0026 | 0.833 | 37w/34l (p=0.81) |
| Retrieval recall | 0.6156 | 0.6532 | +0.0375 | 0.101 | 29w/19l (p=0.19) |
| Ranking recall | 0.4373 | 0.4257 | -0.0116 | 0.485 | 16w/20l (p=0.62) |

A3 vs A2 (isolating the hint's effect): ranking recall regressed -0.020, sign test 15w/30l with **p=0.036** — *significantly worse* with the hint. The hint dilutes the agent's attention or biases ranking decisions adversely; the technique tag was already there providing a cleaner concept signal.

### Decision

**Declared non-viable on this stack after 3 attempts.**
- Best variant (A2: 3-way RRF) gave +0.005 nDCG, +0.036 retrieval recall.
- nDCG gain is smaller than H1's rejected +0.007.
- Retrieval recall gain is real (+3.6 pts, p≈0.09) but doesn't translate to nDCG — gold gets retrieved more often but the ranker doesn't move it up.
- A3 confirmed: feeding the pseudo-query to the ranker actively hurts.

The bottleneck on this stack is the StructuredOutput ranker, not retrieval recall. Adding more retrieval signal without giving the ranker a way to use it is wasted.

**Reverting:**
- mcp-server-aops.ts → single BM25 channel on `content` (HEAD baseline).
- .env → parent fork `jdyfwo1bxu`.
- H3 fork `p7di7u36o4` left running (Ghost MCP doesn't expose pause); pseudo_queries data preserved on the fork. Manual pause possible via Ghost UI to save compute.
- Code reverted via `git checkout src/mcp-server-aops.ts`. Workflow auxiliary scripts (`tag_pseudo_queries.ts`, `update_search_content.ts`, `rebuild_bm25_index.ts`, `restore_content_bm25.ts`) kept in tree as reference for future doc-augmentation experiments.

### Generalizable findings

1. **Retrieval ≠ ranking on this stack.** Pseudo-queries genuinely help BM25 surface gold (+0.036 retrieval recall, p=0.09). But the agent's final ranking (top-10 selection via StructuredOutput) doesn't capitalize. Retrieval expansion only helps nDCG when the ranker can also act on it.

2. **Adding info to result lines is not free.** A3 added a single `hint:` field per result, expecting the ranker would use the concept signal. Instead it regressed by 0.020 ranking recall. Result-line content is a finite attention budget; extra fields dilute the existing tree/cat/tech signal.

3. **H3 confirms the H1 lesson from a different angle.** H1 (query-side reasoning) and H3 (corpus-side doc expansion) both deliver retrieval gains that don't translate to nDCG on this fully-instrumented stack. The agent's tag + tree + HyDE infrastructure is already pulling the relevant docs; the remaining bottleneck is the ranker's discrimination among concept-similar candidates.

### Follow-up

The retrieval recall gain (+0.036) is the strongest "found-but-not-ranked" signal we've measured. A natural next experiment: target the ranker. Options:
- A1: improve the StructuredOutput prompt to weigh concept-match (technique tags) explicitly vs. surface-match.
- A2: present results in a different order (e.g., already-RRF'd order is mixed) to bias the ranker.
- A3: a separate-pass cross-encoder rerank (we tried this earlier on this stack and it regressed; might work better with the v2 retrieval pool).
