# Autoresearch RAG

An autoresearch harness for improving RAG retrieval, evaluated against the MuSiQue multi-hop QA benchmark using the IRCoT 139k Wikipedia paragraph corpus.

## Quick Start

```bash
bun install
python3 -m venv .venv && .venv/bin/pip install numpy nltk
bun run setup          # download MuSiQue dataset + build 139k corpus + create DB schema
bun run ingest         # embed + store 139k paragraphs in memory table (~10-15 min, once)
bun run eval:quick     # evaluate on 20 questions (fast iteration)
bun run eval           # evaluate on all 2,417 dev questions (full run)
```

## About MuSiQue

MuSiQue (Multi-hop Questions via Single-hop Question Composition) is a multi-hop reading comprehension benchmark with 2-4 hop questions. Unlike simpler benchmarks, each hop genuinely depends on previous hops — no shortcuts.

- **2,417 dev questions** (1,252 2-hop + 760 3-hop + 405 4-hop)
- **139,416 corpus paragraphs** (IRCoT Wikipedia subset, standard open-domain retrieval corpus)
- **Scoring**: SQuAD-style F1 + EM (token overlap after normalization), max over answer aliases

## Architecture (Autoresearch Pattern)

- `src/memory.ts` — Contains `ingest()`, `retrieve()`, and `buildPrompt()`. Primary experiment surface.
- `src/mcp-server.ts` — MCP tool definitions (me_memory_search, me_memory_get, me_memory_tree). Also fair game to modify.
- These two files are what you modify in the autoresearch loop. Everything else is fixed infrastructure.

### What you can change

**Ingestion** (`memory.ts` `ingest()`):
- Chunking method — paragraphs are stored as-is today, but you could split/merge, add overlap, or create summary chunks
- Content format — how title + text are combined (e.g., prefix with title, add section headers)
- Tree structure — currently `wiki.{title_slug}`, could add topic hierarchy or cluster-based paths
- Meta fields — currently `{title, corpus_id}`, could add extracted entities, paragraph type, topic tags
- Fact extraction — generate derived fact rows via LLM (like the LoCoMo harness does)

**Retrieval** (`memory.ts` `retrieve()`, `mcp-server.ts`):
- Search strategy — hybrid RRF weights, candidate limits, retrieval limit (top-K)
- Query rewriting — decompose multi-hop questions into sub-queries before searching
- Iterative retrieval — use initial results to formulate follow-up searches
- Filtering — use tree paths, meta fields, or grep patterns to narrow results
- Reranking — add a reranking step after initial retrieval

**Prompting** (`memory.ts` `buildPrompt()`):
- System/user prompt structure for the answering LLM
- Chain-of-thought instructions for multi-hop reasoning
- How retrieved context is formatted and presented

**MCP tools** (`mcp-server.ts`):
- Tool descriptions and parameter descriptions (guides how Claude uses them)
- Add new tools (e.g., a dedicated multi-hop search tool)
- Result formatting (concise lines vs. full paragraphs vs. structured output)

This is an incomplete list — anything in `memory.ts` and `mcp-server.ts` is fair game. You can also ALTER TABLE to add columns or indexes if needed.

## Eval Flow

1. **Setup** (once): Download MuSiQue, build 139k corpus, create DB schema
2. **Ingest** (once, or after changing ingestion): Embed + store 139k paragraphs in memory table
3. **Eval**: Answer questions by retrieving from the corpus, score with F1/EM

## Workflow

1. Read `results/history.jsonl` for experiment history
2. Analyze the latest `results/eval-*.json` to identify failure modes — which hop counts struggle, what types of questions fail, whether retrieval missed the right paragraphs or the LLM misinterpreted context
3. State your hypothesis — print what you think is causing failures and what specific change you expect will improve results
4. Modify `src/memory.ts` and/or `src/mcp-server.ts`
5. If you changed **retrieval or prompts**: just re-run eval
6. If you changed **ingestion**: re-run `bun run ingest --force`, then eval
7. Run `bun run eval:quick --desc "what changed"`
8. Update `experimental_log.md` immediately with hypothesis, changes, results table (with deltas vs baseline), analysis, and decision (adopted/reverted)
9. If F1 improved: `git commit` with scores in the message
10. If F1 regressed: `git checkout src/memory.ts src/mcp-server.ts`

**Always test one experiment at a time. Always update the experiment log after each experiment.**

## DB Schema

The `memory` table matches memory-engine's layout:

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, content hash (blake2b) |
| content | text | NOT NULL, `[Title] paragraph text` |
| meta | jsonb | NOT NULL, `{title, corpus_id}` |
| tree | ltree | NOT NULL, `wiki.{title_slug}` |
| temporal | tstzrange | unused for this benchmark |
| embedding | halfvec(1536) | OpenAI text-embedding-3-small |
| created_at | timestamptz | auto |
| updated_at | timestamptz | nullable |

Indexes: HNSW (halfvec_cosine_ops), BM25 (pg_textsearch), GIN (meta), GIST (tree), GIST (temporal).

## Environment

Requires `.env` with:
- `DATABASE_URL` — Postgres connection string (with pgvector, ltree, pg_textsearch)
- `OPENAI_API_KEY` — for embeddings

QA answering uses `claude -p` (Claude Code CLI), so no separate API key needed.

**Important**: Use a separate DATABASE_URL from the LoCoMo harness to avoid conflicts.

## Results

- `results/history.jsonl` — one-line summary per eval run
- `results/eval-{timestamp}.json` — full per-question details
- Git log — experiment history with scores in commit messages

## Experiment Log

`experimental_log.md` is the detailed record of all experiments. For every experiment, log:
- The hypothesis and what you changed
- Which hop counts it targets
- Full per-hop results table with deltas vs baseline
- Analysis of why it helped or hurt
- The decision (adopted, reverted, or combined with another experiment)

Update the log immediately after each experiment, before moving on to the next one.
