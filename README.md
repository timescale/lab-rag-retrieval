# Lab RAG Retrieval

An experimentation harness for improving RAG retrieval, evaluated against two benchmarks:

- **MuSiQue** — multi-hop QA over a 139k Wikipedia-paragraph corpus (IRCoT). Scored with SQuAD-style F1 + EM.
- **BRIGHT** — reasoning-intensive retrieval over 12 domain-specific corpora. Scored with nDCG@10.

Retrieval is agentic: an MCP tool exposes hybrid search (BM25 + vector, RRF-combined) over a Postgres corpus, and `claude -p` drives it directly — no separate query planner or reranker.

## Quick start

```bash
bun install
python3 -m venv .venv && .venv/bin/pip install numpy nltk pandas pyarrow

# MuSiQue
bun run setup          # download MuSiQue + build 139k corpus + create DB schema
bun run ingest         # embed + store 139k paragraphs (~10-15 min)
bun run eval:quick     # 20 questions
bun run eval           # all 2,417 dev questions

# BRIGHT (per-domain)
bun run setup:bright -- --domain pony
bun run ingest:bright -- --domain pony
bun run eval:bright -- --domain pony --desc "baseline"
```

Requires a Postgres database with `pgvector`, `ltree`, and `pg_textsearch`, plus an OpenAI API key for embeddings, both set via `.env`. See `CLAUDE.md` for full architecture notes, database schema, and the experiment log workflow.
