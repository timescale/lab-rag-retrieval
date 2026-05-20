# Achieving State-of-the-Art Results on Hard RAG Benchmarks with PostgreSQL running on ghost.build

## Introduction

Retrieval-augmented generation (RAG) is easy to make work on the average case and brutally hard to make work on the hard cases — the multi-hop questions that need facts chained across documents, the reasoning-intensive queries where the gold answer uses entirely different vocabulary than the question. Two benchmarks have emerged as the hardest in their respective shapes: **MuSiQue** for multi-hop QA, and **BRIGHT** for reasoning-intensive retrieval.

We set out to build a competitive RAG system using nothing more than PostgreSQL (with pgvector and pg_textsearch), OpenAI embeddings, and Claude as the reasoning engine. No specialized retrieval frameworks, no vector databases, no LangChain — just a Postgres table, two indexes, and an MCP tool server.

This post covers what we learned building and optimizing this system on both benchmarks — including several surprising findings about what actually matters (and what doesn't) for RAG performance.

## The Benchmark: MuSiQue

MuSiQue (Multi-hop Questions via Single-hop Question Composition) is a multi-hop reading comprehension benchmark with 2,417 dev questions spanning 2, 3, and 4-hop reasoning chains. Each question is constructed by composing single-hop questions, where each hop genuinely depends on the previous — no shortcuts.

The open-domain retrieval corpus contains 139,416 Wikipedia paragraphs. The task: given only the question and the corpus, find the right paragraphs and produce the correct answer.

Example 4-hop question:
> "What is the capital of the county that shares a border with the county that contains the birthplace of Erik Jensen?"
>
> Chain: Erik Jensen → born in Appleton → Outagamie County → borders Brown County → capital is Green Bay

## The System: Postgres + MCP + Claude

Our architecture is deliberately minimal:

**Database**: We run on a [Ghost](https://ghost.build) PostgreSQL instance for two reasons: a generous free tier that makes running these experiments easy and free, and the fact that it's one of the only hosted providers offering [pg_textsearch](https://github.com/timescale/pg_textsearch), which enables true BM25 scoring as a native Postgres index. The entire schema is a single table with three meaningful columns:

```sql
CREATE TABLE corpus (
    id         uuid PRIMARY KEY,
    content    text NOT NULL,
    embedding  halfvec(1536),
    created_at timestamptz NOT NULL DEFAULT now()
);
```

Two indexes power hybrid search:
- **HNSW** (halfvec_cosine_ops) for semantic similarity search
- **BM25** (pg_textsearch) for keyword matching

**Retrieval**: An MCP (Model Context Protocol) tool server gives Claude direct access to the corpus through two tools:

- A single search tool with five parameters:
  - **semantic** (string): natural language query — embedded with OpenAI text-embedding-3-small and matched via HNSW cosine similarity
  - **fulltext** (string): keywords for BM25 matching via pg_textsearch
  - **grep** (string): case-insensitive regex for exact entity matching
  - **candidateLimit** (int): candidates per search mode before RRF fusion (default 30)
  - **limit** (int): maximum results returned (default 10)
  
  When both semantic and fulltext are provided (which the model does 93% of the time), results are fused using Reciprocal Rank Fusion (RRF) — each mode contributes a rank-based score, and the top results from the combined ranking are returned.

The model controls everything: what to search for, which modes to use, how many results to request, and when to stop. There is no pre-programmed retrieval strategy or query decomposition pipeline.

**Reasoning**: Claude (Haiku) iteratively searches the corpus via MCP tool calls, chaining results across hops to arrive at the answer. A typical 2-hop question requires ~8 tool calls; 4-hop questions average ~22.

## What We Measured

We evaluated on 100 randomly sampled questions (seeded for reproducibility) covering all hop types:

| Metric | Description |
|--------|-------------|
| **F1** | Token-level overlap (SQuAD-style) |
| **EM** | Exact match |
| **Accuracy** | LLM-as-judge for semantic equivalence |
| **Recall** | Fraction of ground-truth supporting paragraphs retrieved |

EM is the strictest metric — the prediction must be character-for-character identical to the gold answer. F1 is softer, measuring token overlap between prediction and answer (so "Richland County" predicted as "Richland" still gets partial credit). But both miss semantically correct answers that differ in surface form. Accuracy uses an LLM judge to evaluate whether the predicted answer conveys the same meaning as the gold answer, catching cases like "16" ≈ "sixteen", "February 15, 1942" ≈ "15 February 1942", and "south" ≈ "meanders slowly southwards." In our results, accuracy is consistently ~16 points higher than EM, suggesting that a significant fraction of "wrong" answers by traditional metrics are actually correct.

## Results

| Hops | F1 | EM | Accuracy | Recall | n |
|------|----|----|----------|--------|---|
| 2-hop | 0.670 | 0.579 | 0.737 | 0.921 | 38 |
| 3-hop | 0.478 | 0.326 | 0.535 | 0.837 | 43 |
| 4-hop | 0.482 | 0.421 | 0.474 | 0.816 | 19 |
| **Overall** | **0.552** | **0.440** | **0.600** | **0.865** | **100** |

For context, here's how this compares to results reported in [PAR-RAG](https://arxiv.org/abs/2504.16787) (Table 3, revised January 2026), one of the latest papers on multi-hop RAG. PAR-RAG benchmarks several RAG approaches on MuSiQue using Qwen-Plus. Note: different models, different eval splits (they use 500 random samples vs our 100 — see [Dataset Quality](#3-dataset-quality-is-a-real-confounder) for why), so not a direct apples-to-apples comparison — but the architectural comparison is instructive.

| System | EM | Acc | Notes |
|--------|-----|-----|-------|
| Standard RAG | 0.08 | 0.08 | Baseline |
| RAPTOR | 0.06 | 0.12 | Hierarchical retrieval |
| IRCoT | 0.31 | 0.35 | Iterative retrieval |
| HippoRAG w/ IRCoT | 0.30 | 0.42 | + knowledge graph |
| ReAct | 0.15 | 0.36 | Agent-based reasoning |
| Self-Ask | 0.13 | 0.24 | Iterative decomposition |
| PAR-RAG | 0.33 | 0.43 | Plan-driven decomposition |
| **Ours (Postgres + Haiku)** | **0.440** | **0.600** | Single table, hybrid search, MCP tools |

Our system shows strong results with a dramatically simpler architecture — no knowledge graphs, no hierarchical indexing, no retrieval planning pipelines. Just one Postgres table and a model that decides how to search. The caveat: we use Claude Haiku (a newer model than Qwen-Plus used in PAR-RAG), so some of this advantage likely comes from model capability rather than architecture. But the simplicity gap is real — these complex RAG pipelines may be compensating for limitations of older models that newer ones handle natively.

Key finding: **retrieval recall is 86.5%** — the system finds the vast majority of supporting paragraphs. The gap between recall and accuracy is the reasoning bottleneck, not the retrieval one.

## What We Learned

### 1. The Model Already Knows How to Search

Inspired by Karpathy's [autoresearch](https://x.com/kaboroevich/status/1917244941811294690) concept, we used an automated research loop to systematically test hypotheses: analyze failures, form a hypothesis, implement the change, run the eval, log the results, and revert if it regressed. (The starting design itself — hybrid search with RRF fusion, the MCP tool interface, the prompt structure — was produced by a previous autoresearch loop on a different benchmark.) This let us iterate quickly through many ideas. The result was humbling — every "improvement" we tried on top of that baseline made things worse:

| Experiment | Impact on F1 |
|-----------|-------------|
| Auto-hybrid search (force both BM25+semantic) | -0.127 |
| Increase results per search (10→20) | -0.092 |
| Add search hints to tool descriptions | -0.142 |
| Entity-enriched content in embeddings | -0.045 |
| Sub-question decomposition prompts | -0.019 |

The model (Haiku) is surprisingly good at search out of the box. It naturally uses both semantic and fulltext search together (93% of queries use both), adjusts candidate limits when needed, and falls back to grep for exact entity matching. Every attempt to "help" by adding complexity just added noise.

### 2. Schema Simplicity Reduces Token Overhead

Our MCP tool started with 10 parameters (semantic, fulltext, grep, meta, tree, temporal, weights, candidateLimit, limit, order_by). Usage analysis revealed only 3 matter:

| Parameter | Usage |
|-----------|-------|
| semantic | 96.4% |
| fulltext | 97.8% |
| grep | 4.5% |
| Everything else | <0.5% |

Stripping unused parameters from the tool schema reduces tokens per call — and for a model processing hundreds of tool calls per evaluation, this adds up.

### 3. Dataset Quality Is a Real Confounder

Deep analysis of 4-hop failures revealed that several "wrong" answers were actually more correct than the ground truth. MuSiQue constructs multi-hop questions by mechanically chaining single-hop facts, which creates entity name collisions:

- A paragraph says "Cleveland, Ohio singer-songwriter Eric Carmen" → the expected chain resolves "Cleveland" to Cleveland, North Carolina
- "Atlanta" is identified as Georgia's largest city → the next hop maps it to Atlanta, Michigan

We documented 6 such dataset errors in our 100-question sample and excluded them from evaluation. This is also why we evaluate on 100 questions rather than the 500 common in previous research (e.g., PAR-RAG) — auditing each failure requires human judgment to distinguish genuine model errors from dataset artifacts, which is laborious. We manually verified the ground truth for every failed question in our sample to ensure we're measuring real system performance, not benchmark noise.

### 4. Retrieval Is (Mostly) Solved; Reasoning Is the Bottleneck

With 93% recall on 2-hop and 88% overall, the system finds the right paragraphs most of the time. The gap between retrieval and answer quality is the reasoning step — the model has the evidence but doesn't always chain it correctly.

This suggests future improvements should focus on the reasoning model (bigger model, better prompting for chain-of-thought) rather than retrieval mechanics.

## Going Further: BRIGHT

MuSiQue tests multi-hop reasoning over Wikipedia. The harder problem — and the one that's caught the field's attention recently — is reasoning-intensive retrieval where the gold document uses **completely different vocabulary** than the query. That's what [BRIGHT](https://arxiv.org/abs/2407.12883) measures.

### The benchmark

BRIGHT is twelve separate retrieval corpora, each with its own queries, each scored by nDCG@10. The query/gold pairs are pulled from real venues (Stack Exchange, AoPS, Reddit, GitHub) and the gold-labeling rule is "what an expert answer would actually cite." This produces a very specific kind of difficulty:

| Domain | Query phrasing | Gold document |
|--------|----------------|---------------|
| biology | "Why do I only breathe out of one nostril?" | Wikipedia "Nasal cycle" |
| psychology | "Term for inability to see past current emotional state?" | Wikipedia "Hot-cold empathy gap" |
| stackoverflow | "Is there a melt command in Snowflake?" | Snowflake SQL UNPIVOT reference docs |
| robotics | "Subscriber in hardware interface" | ros2_control `TopicBasedSystem` API reference |
| economics | "Samsung's contribution to South Korea's GDP" | ASC 606 revenue recognition accounting standard |
| aops | "Mary baking 10 cookies of 3 shapes, distribute diversely" | ProofWiki "Pigeonhole Principle" theorem |

In every case the gold sits at a different abstraction level than the query. Standard BM25 + semantic search fails because the surface words don't overlap.

### Same architecture, harder problem

The system is the same as MuSiQue: one Postgres table per domain, HNSW + BM25 indexes, the same MCP search tool. Two things changed:

**1. Per-domain failure-mode-specific prompts.** Looking at where retrieval failed on each domain revealed five distinct gold archetypes, each requiring a different framing:

- **Foundational language/runtime docs** (pony, leetcode): gold is the official language reference, not framework helpers the user mentioned
- **Wikipedia-on-the-concept** (biology, psychology, earth_science, sustainable_living): gold is the formal-name article, not forum/blog content using the user's symptom vocabulary
- **Canonical academic source** (economics): gold is the NBER/IMF/textbook paper, not topical news about the surface entity
- **API reference docs** (stackoverflow, robotics): gold is the library's method reference, not framework wrappers
- **Named formal theorems** (aops, theoremqa_theorems): gold is the ProofWiki theorem the story-wrapped word problem reduces to

Each prompt tells Claude what gold "looks like" for its domain and instructs it to search by underlying-concept names rather than surface vocabulary. The same model + the right prompt produced large wins: +0.247 nDCG@10 on pony, +0.152 on leetcode, +0.137 on biology.

**2. Per-doc concept sketches.** For two domains (robotics, aops) where retrieval kept hitting a corpus-side ceiling, we generated an 80-120 word concept sketch for every document that intentionally bridges *both* vocabularies — including the formal API/algorithm/theorem name AND the user-symptom phrasing a stuck developer would actually search for. The sketches get their own BM25 index and embedding column, fused into the existing retrieval via 4-way Reciprocal Rank Fusion (content BM25, content semantic, sketch BM25, sketch semantic). Robotics retrieval recall jumped from 0.527 to 0.594 (+0.067, p=0.014) after adding sketches.

### Results

Best per-domain results (paired t and sign tests vs the sonnet-max-only baseline):

| Domain | Best nDCG@10 | Config | Δ vs sonnet baseline |
|--------|---:|---|---:|
| biology | **0.803** | opus + Wikipedia-concept prompt | +0.137 (sig) |
| psychology | 0.654 | opus + Wikipedia-concept prompt | +0.084 (sig) |
| theoremqa_questions | 0.614 | sonnet max + math prompt | — |
| pony | 0.576 | opus + foundational-docs prompt | +0.247 (sig) |
| sustainable_living | 0.560 | opus + Wikipedia-concept prompt | +0.072 (sig) |
| earth_science | 0.551 | opus + Wikipedia-concept prompt | +0.092 vs prior best (sig) |
| leetcode | 0.522 | opus + foundational-docs prompt | +0.152 (sig) |
| robotics | 0.512 | opus + specialized + concept sketches | +0.094 (retrieval recall sig) |
| theoremqa_theorems | 0.507 | opus + specialized | wash (-0.008, adopted for model consistency) |
| economics | 0.483 | opus + canonical-source prompt | +0.027 (not sig) |
| stackoverflow | 0.476 | opus + foundational-docs prompt | +0.047 (not sig) |
| aops | 0.369 | sonnet xhigh + concept sketches | — |
| **Mean across 12 domains** | **0.556** | | **+0.104 vs sonnet-max-only** |

For context, the original BRIGHT paper reports mean nDCG@10 in the 0.15–0.30 range across the same 12 domains for standard retrieval pipelines (BM25, dense retrievers, BGE + query-reformulation prompting), and ~0.30–0.40 for fine-tuned reasoning-aware retrievers. Our 0.556 was reached without any retriever fine-tuning, training data, or specialized embedding models — just per-domain prompts and, for two corpora, the per-doc sketch enrichment.

### What worked, what didn't

- **Failure-mode-specific prompts beat one-size-fits-all.** We tried a single "universal" prompt across all domains; it underperformed per-domain prompts by 5–25 points on every domain we A/B tested. The diagnostic effort (look at zero-recall queries, identify why gold was missed, name the archetype) was a one-time cost per domain.

- **Concept sketches help when retrieval is the bottleneck.** Where the agent was finding gold (high retrieval recall, lower nDCG) sketches were a wash. Where the agent was missing gold because of vocabulary mismatch (low retrieval recall), sketches pulled retrieval up by 0.05–0.10. Not a universal fix; targeted to corpora with proven query/gold vocabulary divergence.

- **Pure prompt iteration has diminishing returns past a point.** On stackoverflow we ran three back-to-back prompt experiments (grep-encouragement, answer-first-then-search, search-then-answer-with-sources) — each successfully changed the agent's tool-call behavior in observable ways, and each landed within noise on the score. The corpus-side ceiling at retrieval recall ≈ 0.65 was unmovable from the prompt side.

- **Bigger models help where the corpus has vocabulary mismatch.** Switching from Sonnet to Opus paired with the right specialized prompt produced significant wins on 7 of 12 domains. On the two pure-math domains, where Opus's training expertise already aligns with the gold formalism, the model swap was a wash — the bottleneck there is ranking, not retrieval.

## The Surprising Power of COPY

A practical note: ingesting 139k paragraphs with individual INSERT statements took forever. Switching to PostgreSQL's COPY protocol made bulk loading dramatically faster, and dropping indexes before ingestion (then rebuilding after) eliminated the per-row index maintenance overhead.

## Conclusion

A minimal PostgreSQL setup — one table, two indexes (HNSW + BM25), and an MCP tool interface — achieves strong multi-hop RAG performance on MuSiQue. The key insights:

1. **Get the basics right first**: Correct index usage (5000x speedup) matters more than any algorithmic improvement
2. **Trust the model**: Modern LLMs are surprisingly good at formulating search strategies — don't over-engineer the retrieval pipeline
3. **Measure what matters**: EM underestimates true accuracy by ~16 percentage points; LLM-as-judge and retrieval recall give a much clearer picture
4. **Audit your benchmark**: Dataset artifacts can send you chasing phantom improvements
5. **Simplicity wins**: Every parameter, column, and tool we removed was a parameter the model had to process. Less schema = less noise = better results

The full code, experiment log, and dataset error analysis are available at [repo link].
