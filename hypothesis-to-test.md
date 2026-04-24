# Hypotheses to Test — BRIGHT aops

Derived from the BRIGHT leaderboard survey (2026-04-24). Focus: techniques from
top-ranking systems that are applicable without custom model training. aops
current baseline: **nDCG@10 = 0.3643** (Sonnet, `--effort xhigh`, `--setting-sources project`, 2026-04-24). Full stack: tree prompt + silent exclusion + HyDE + tag-based retrieval + fixed lquery. Prior "high"-effort reference was 0.3335.

Ordered by expected impact / effort ratio.

---

## H1: Pre-computed query reasoning (BRIGHT canonical)

**Status: TESTED on aops (Sonnet), declared non-viable after 2 attempts, +0.007 nDCG at p=0.69 — likely subsumed by our existing tag + HyDE + tree infrastructure. Still worth testing on economics (weaker infrastructure there). See experimental_log_bright.md for detailed analysis.**

**Hypothesis.** The BRIGHT paper's signature technique. Before the search
agent runs, a separate LLM call performs step-by-step reasoning about the
query. The reasoning text is then injected into the search agent's prompt
(either as added context or as a replacement query). BRIGHT paper reports
**+12.2 nDCG** as the top single-technique gain.

**Distinct from what we've tried.**
- *Answer-forcing* (reverted): made the agent produce reasoning *alongside*
  its tool calls, stealing from the output budget → -0.040. H1 uses a
  *separate* LLM call, preserving the agent's token budget.
- *HyDE sibling* (kept): generates one hypothetical sibling problem. H1
  generates a full multi-step analysis of what the problem requires.
- *Two-stage rerank* (reverted): stripped context from ranking. H1 adds
  context before search.

**Exact prompt (from `xlang-ai/BRIGHT/reason.py`):**
```
{query}

Instructions:
1. Identify the essential problem.
2. Think step by step to reason and describe what information could be
   relevant and helpful to address the questions in detail.
3. Draft an answer with as many thoughts as you have.
```

**Implementation (~30 lines).**
- `evaluate-bright.ts`: add pre-pass that runs Claude with the above prompt,
  captures the output, prepends it to the agent's prompt as a "Reasoning
  about this problem:" section.
- Use **Haiku** for the reasoning pre-pass (cheap, fast); Haiku for the
  agent. ~5-10 s per pre-pass call, +15-20 min total wall for 111 queries.
- Try also **Sonnet reasoning + Haiku agent** as a cost-efficient variant.

**Variants to run (keep each short).**
1. Haiku reasoning + Haiku agent (baseline).
2. Sonnet reasoning + Haiku agent (best cost/quality).
3. Query-replacement (agent sees only the reasoning, not the raw query).
4. Query-append (agent sees both). Default to this.

**Expected result.** +0.03 to +0.10 nDCG. BRIGHT claims +12.2 globally; our
corpus is already heavily instrumented so the remaining headroom is smaller.
Retrieval recall should improve most (reasoning expands the search-relevant
vocabulary).

**Risks.**
- Haiku reasoning could produce sloppy analysis (wrong technique
  identification) that steers search away from gold.
- If the injected reasoning is too long it might dilute attention in the
  agent prompt.
- Has some conceptual overlap with our existing HyDE step — redundant
  reasoning could waste tool calls.

---

## H2: ThinkQE-style iterative expansion (2-3 rounds)

**Hypothesis.** After the agent's first round of searches, summarize what
was retrieved, call an LLM to *refine* the query based on observed
vocabulary, and issue a second round of searches. ThinkQE paper reports
34.9 on StackExchange subsets with this iterative approach using a
reasoning LLM as the expander. Training-free.

**Implementation.**
- New eval path: agent runs with a reduced budget (say ~6 searches) →
  collect results → call Claude with "Given these top-20 retrieved docs
  and the original query, what search terms would find more relevant
  docs?" → agent runs another 4 searches with the suggested terms → rank.
- Alternatively: single-agent with an explicit "after 5 searches, reflect
  on what came back and write 3 new queries" instruction.

**Variants.**
1. Two rounds (cheapest).
2. Three rounds.
3. Each round uses fresh Claude context (no carryover history).

**Expected result.** +0.02 to +0.05 nDCG. Helps on queries where the first
round surfaces partial-match results the agent can learn from.

**Risks.**
- More tool calls → higher cost and latency (~2× wall time).
- The agent already does multiple searches; this might just formalize what
  it's already doing.
- Could overwhelm attention if round-2 context is too full.

---

## H3: Document pseudo-queries at ingest (doc expansion)

**Hypothesis.** For each chunk, LLM generates 3-5 natural-language queries
the chunk could answer. These are stored as a searchable field (`meta.queries`
or a concatenated text field for BM25). At retrieval time, user queries
match pseudo-queries directly, which tends to mirror how real questions are
phrased. Standard doc-expansion technique (Doc2Query / HyDE-flip).

**Implementation.**
- Extend `tag_aops_corpus.ts` (or a new script) to call Haiku per chunk
  asking for 3-5 "questions this chunk answers".
- Store as `meta.pseudo_queries: string[]`.
- In MCP server, concat pseudo_queries into BM25 corpus (at ingest time,
  prepend or append to content) or add as a separate searchable column.
- Only tag the useful sources (13k docs, ~4 hours at 0.5/s with Haiku).

**Variants.**
1. Pseudo-queries added to content (BM25 over augmented content).
2. Separate column with its own BM25 index.
3. Use pseudo-queries for re-embedding (doc embedding = embed(title +
   pseudo-queries + content)).

**Expected result.** +0.02 to +0.06 nDCG. Directly targets the "query
vocabulary ≠ doc vocabulary" issue. Most effective on concept-cluster
queries where the doc is a problem statement and the gold "query" is
another problem statement that shares scenario type.

**Risks.**
- Ingest-side cost (one-time) + re-embedding cost if we choose variant 3.
- Noise: bad pseudo-queries pollute retrieval.
- Overlap with our technique tags — pseudo-queries might be redundant.

---

## H4: BM25 scores exposed to agent/ranker (InsertRank-style)

**Hypothesis.** InsertRank shows that giving the LLM explicit BM25 scores
alongside candidates improves ranking. The LLM can reason "this ranked high
on keywords but not semantic → probably surface match only."

**Implementation.**
- MCP search tool returns each result with its BM25 score and semantic
  distance, shown in the result line: `(id: ..., bm25: 12.3, sem: 0.87)`.
- Prompt mentions that these scores can help: "high BM25 + low semantic =
  keyword overlap only; high both = strong match."

**Variants.**
1. Both scores shown always.
2. Only BM25 (we already show nothing explicit).
3. Just RRF fused score.

**Expected result.** Small — our agent already sees both modes implicitly.
Maybe +0.01 nDCG. Higher value on domains where gold is lexically tied to
query (not aops's strong suit).

**Risks.**
- Extra noise in result lines dilutes the useful info (tree labels,
  technique tags).
- Scores across modes aren't on the same scale; agent might misread them.

---

## H5: Multi-stage query decomposition (BRIGHT paper variant)

**Hypothesis.** Break down a compound aops query into sub-questions, search
each independently, fuse results. For queries like "Let polynomial P
satisfy X; find Y + Z at roots of P," decompose into "properties of
polynomial roots" and "evaluating polynomial at specific values."

**Implementation.**
- Pre-pass: Claude decomposes the query into N sub-queries (e.g. 2-4).
- Agent searches each sub-query independently, then fuses.
- Very similar to H1 but more structured.

**Expected result.** +0.01 to +0.03 nDCG. Aops queries are often compound
(multiple techniques required), so decomposition should help. But it's
close to what the agent already does implicitly via multiple searches.

**Risks.**
- Shares the token-budget risk with H1.
- Aops queries may be too interconnected to decompose cleanly.

---

## Execution order

1. **H1 first** — highest expected impact, simplest implementation, directly
   from the winning technique in the BRIGHT paper. Do Sonnet-reasoning +
   Haiku-agent variant as the main test; fall back to Haiku-reasoning if
   cost matters.
2. **H3 next** if H1 adopts — orthogonal axis (document-side vs query-side),
   stackable. One-time ingest cost, evaluation is free thereafter.
3. **H2** after #1/#3 — incremental refinement; might be subsumed by H1.
4. **H4 / H5** last — smaller expected gains, optional polish.

Keep each experiment paired with a baseline, report nDCG + retrieval recall
+ ranking recall + zero-gold count, use paired-t and sign-test for
significance. Log in experimental_log_bright.md. Revert if not a clear win.
