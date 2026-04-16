# Achieving State-of-the-Art Results on Multi-Hop RAG with PostgreSQL

## Introduction

Multi-hop question answering — where answering a single question requires chaining facts from multiple documents — is one of the hardest benchmarks in retrieval-augmented generation (RAG). Unlike simple factoid QA where a single retrieved paragraph usually suffices, multi-hop questions like "What county borders the county containing the birthplace of the performer of Tonight You're Mine?" require finding 2-4 separate paragraphs and reasoning across them.

We set out to build a competitive multi-hop RAG system using nothing more than PostgreSQL (with pgvector and pg_textsearch), OpenAI embeddings, and Claude as the reasoning engine. No specialized retrieval frameworks, no vector databases, no LangChain — just a Postgres table, two indexes, and an MCP tool server.

This post covers what we learned building and optimizing this system against the MuSiQue benchmark — including several surprising findings about what actually matters (and what doesn't) for RAG performance.

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
| **Accuracy** | LLM-as-judge for semantic equivalence (catches "Paraguay" ≈ "Alfredo Stroessner's Paraguay") |
| **Recall** | Fraction of ground-truth supporting paragraphs retrieved |

## Results

| Hops | F1 | EM | Accuracy | Recall | n |
|------|----|----|----------|--------|---|
| 2-hop | 0.670 | 0.579 | 0.737 | 0.921 | 38 |
| 3-hop | 0.478 | 0.326 | 0.535 | 0.837 | 43 |
| 4-hop | 0.482 | 0.421 | 0.474 | 0.816 | 19 |
| **Overall** | **0.552** | **0.440** | **0.600** | **0.865** | **100** |

For context, here's how this compares to results reported in [PAR-RAG](https://arxiv.org/abs/2504.16787) (Table 3, revised January 2026), one of the latest papers on multi-hop RAG. PAR-RAG benchmarks several RAG approaches on MuSiQue using Qwen-Plus. Note: different models, different eval splits (they use 500 random samples), so not a direct apples-to-apples comparison — but the architectural comparison is instructive.

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

We documented 6 such dataset errors. Filtering them and using LLM-as-judge accuracy (which catches semantic equivalence) gave a more honest picture of system performance.

### 4. Retrieval Is (Mostly) Solved; Reasoning Is the Bottleneck

With 93% recall on 2-hop and 88% overall, the system finds the right paragraphs most of the time. The gap between retrieval and answer quality is the reasoning step — the model has the evidence but doesn't always chain it correctly.

This suggests future improvements should focus on the reasoning model (bigger model, better prompting for chain-of-thought) rather than retrieval mechanics.

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
