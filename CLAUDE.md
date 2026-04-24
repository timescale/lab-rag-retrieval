# Autoresearch RAG

An autoresearch harness for improving RAG retrieval, evaluated against two
benchmarks:

- **MuSiQue** — multi-hop QA over a 139k Wikipedia-paragraph corpus (IRCoT).
  Original benchmark. Scored with SQuAD-style F1 + EM.
- **BRIGHT** — reasoning-intensive retrieval over 12 domain-specific corpora.
  Added more recently. Scored with nDCG@10.

Most active iteration is on BRIGHT (the harder benchmark). Recent experiment
notes in `experimental_log_bright.md`; upcoming hypotheses in
`hypothesis-to-test.md`.

## Quick Start

```bash
bun install
python3 -m venv .venv && .venv/bin/pip install numpy nltk pandas pyarrow

# MuSiQue (original)
bun run setup          # download MuSiQue + build 139k corpus + create DB schema
bun run ingest         # embed + store 139k paragraphs (~10-15 min)
bun run eval:quick     # 20 questions
bun run eval           # all 2,417 dev questions

# BRIGHT (per-domain)
bun run setup:bright -- --domain pony          # download + table per domain
bun run ingest:bright -- --domain pony         # embed + index one domain
bun run eval:bright -- --domain pony --desc "baseline"
bun run eval:bright:quick                       # 20 queries, pony
```

BRIGHT eval options:
- `--model haiku | sonnet` (default: haiku)
- `--samples N` — only first N queries
- `--domain <name>` — required

## Benchmark snapshots

### MuSiQue
- 2,417 dev questions (1,252 × 2-hop + 760 × 3-hop + 405 × 4-hop)
- 139,416 corpus paragraphs (IRCoT Wikipedia subset)
- Scoring: SQuAD-style F1 + EM, max over answer aliases

### BRIGHT (12 domains)
Current Haiku scores (mean 0.347 across 12 domains):

| Tier | Domain | nDCG@10 |
|------|--------|---------|
| Text-rich | biology | 0.553 |
| | theoremqa_theorems | 0.512 |
| | psychology | 0.472 |
| | earth_science | 0.459 |
| | pony | 0.409 |
| Economics/social | economics | 0.369 |
| | sustainable_living | 0.360 |
| | stackoverflow | 0.341 |
| | robotics | 0.293 |
| Code/math | aops | 0.328 (with full stack) |
| | leetcode | 0.177 |
| | theoremqa_questions | 0.067 |
| **Sonnet econ** | | 0.462 |
| **Sonnet aops** | | 0.333 |

## Architecture (Autoresearch Pattern)

The primary experiment surfaces:

- `src/memory.ts` — ingestion (`ingest`, `ingestBright`), retrieval
  (`retrieve`), prompts (`buildPrompt`, `buildPromptBrightDefault`,
  `buildPromptBrightEconomics`, `buildPromptBrightMath`). Most prompt work
  happens here.
- `src/mcp-server.ts` — default MCP search tool for MuSiQue and most BRIGHT
  domains.
- `src/mcp-server-aops.ts` — variant for aops / theoremqa_questions. Adds
  `treeMatch`, `techniquesAny`, `categoryAny` params on top of the default
  tool, and surfaces `tree`/`cat`/`tech` in result lines.
- `src/config.ts` — table schema (`createCorpusTable`), tree-label helper
  (`brightSourceTree`), table-naming.
- `src/taxonomy.ts` — canonical technique + category lists used by both the
  MCP tool description and the math prompt. Single source of truth.

Supporting (usually don't modify):
- `src/evaluate-bright.ts` — BRIGHT eval harness. Routes aops /
  theoremqa_questions to mcp-server-aops; others to mcp-server. Does
  per-query silent injection of `excluded_ids` via `MCP_EXCLUDED_IDS_PATH`
  env var + temp file (BRIGHT's per-query near-duplicate exclusion set is
  ~9,200 IDs per query on aops — too big for the tool parameter).
- `src/evaluate.ts` — MuSiQue eval harness.
- `src/embed-cache.ts` + `src/file-cache.ts` — embedding batch cache and
  generic JSON-keyed file cache. Reused by corpus tagging.
- `src/prepare-bright.ts`, `src/ingest-bright.ts` — per-domain prepare +
  ingest scripts.
- `tag_aops_corpus.ts` — one-off per-chunk tagging for the aops corpus
  (Claude Haiku). Produces `meta.techniques` / `meta.category` / `meta.kind`
  used by aops-MCP filters.

### What you can change

**Ingestion** (memory.ts ingest / ingestBright, config.ts):
- Chunking: paragraphs stored as-is for MuSiQue; BRIGHT docs as-shipped by
  the benchmark — changing chunk boundaries breaks the gold-ID contract.
- Content format: prefix with title, inject summaries, annotate with
  metadata.
- Tree structure (ltree): source label (aqua/camel/gsm/math_train/...)
  for blended corpora. Lquery patterns supported by the aops MCP.
- Meta fields: jsonb. Currently `{category, techniques, setup_tags, kind}`
  on aops chunks (populated by `tag_aops_corpus.ts`). Indexed with
  `GIN (meta jsonb_path_ops)`.
- LLM-derived fact extraction: per-chunk or per-document. See
  tag_aops_corpus.ts for pattern + taxonomy derivation methodology.

**Retrieval** (memory.ts retrieve, mcp-server*.ts):
- Hybrid RRF weights, candidate limits, result count.
- Query rewriting / decomposition / HyDE-style hypothetical docs.
- Iterative retrieval using round-1 results to seed round-2 queries.
- Filter parameters: grep, treeMatch (lquery), techniquesAny /
  categoryAny (jsonb containment), excludeIds.
- Reranking: tested a separate-pass LLM reranker (reverted — lost the
  agent's reasoning-state context). See experimental log.

**Prompting** (memory.ts buildPromptBright*):
- Domain-specific prompts route through `buildPromptBright(query, domain)`:
  economics → expansion prompt, aops + theoremqa_questions → math prompt
  with tag-directive, everything else → default prompt.
- Canonical technique + category vocabulary lives in `src/taxonomy.ts`.
- CAVEAT: Haiku has an output-token budget ceiling. Prompts that expand
  output obligations (answer-forcing, deliberation-before-ranking,
  generate-and-explain) regress because they trade tool calls for text.
  Structural changes (tags, tree filters, silent exclusion, HyDE sibling)
  win because they add capability without costing output budget.

**MCP tools** (mcp-server*.ts):
- Parameters, tool description (model reads this).
- Result line format (currently `N. <content> (id: X, tree: Y, cat: Z, tech: [...])` for aops).
- New tools (e.g., a dedicated decomposition search).

### Fair game with `ALTER TABLE`

Adding columns, GIN/GIST indexes, ltree migrations — all within scope of
the harness. See git history for the `meta` jsonb column, `tree` ltree
migration, and BM25 index fixes.

## BRIGHT specifics worth knowing

### Per-query exclusion lists
aops + theoremqa_questions queries have ~9,200 excluded IDs per query
(near-duplicate filtering). Our eval writes them to a temp file and passes
`MCP_EXCLUDED_IDS_PATH` to the MCP server, which silently appends
`id != ALL(...)` to every search. Agent never sees the excluded docs.

### Gold labeling methodology (important)
BRIGHT gold is **the specific sources an expert answer would cite** — not
topical overviews. For aops competition problems, gold is usually a sibling
problem in the same concept cluster (Frobenius problem ↔ brick stacking
↔ coin denominations). Query and gold often share a technique but not
surface vocabulary.

### BM25 parallel-build workaround
pg_textsearch's parallel workers fail with `tp_worker_0.0: No such file` on
corpora ≥ ~188k docs. `ingestBright` issues `SET
max_parallel_maintenance_workers = 0` before BM25 index creation to avoid
this.

### Token-batching edge cases
- OpenAI 300k tokens/request limit. js-tiktoken can undercount vs
  server-side count by up to 12% on code-heavy content. Embed-cache caps
  batches at 240k tokens.
- BRIGHT docs occasionally exceed the per-doc 8000 token limit — truncated
  at ingest.
- CR in content breaks `COPY ... FROM STDIN`. Handled via `\r` escape.

## Eval Flow

### MuSiQue
1. `bun run setup` (once): download + build corpus + schema.
2. `bun run ingest` (once or after changing ingestion): embed + store.
3. `bun run eval:quick` for iteration / `bun run eval` for full.

### BRIGHT
1. `bun run setup:bright -- --domain X` (once per domain).
2. `bun run ingest:bright -- --domain X` (once or after changing ingestion).
3. `bun run eval:bright -- --domain X --desc "what"`.

## Workflow

1. Pick next hypothesis from `hypothesis-to-test.md` or from your own
   analysis of `results/*-history.jsonl` and the latest `results/*-eval-*`.
2. State the hypothesis explicitly before coding: what failure are you
   targeting, what change, what metric should move.
3. Modify the right surface:
   - Retrieval/prompt only → just re-run eval
   - Ingestion → re-ingest (`--force`) then eval
4. Run eval with a descriptive `--desc`:
   - BRIGHT: `bun run eval:bright -- --domain <d> --desc "<change>"`
   - MuSiQue: `bun run eval:quick -- --desc "<change>"`
5. Compare against the previous baseline with paired-t and sign tests on
   per-query deltas. Report nDCG + retrieval recall + ranking recall +
   zero-gold count. See any recent BRIGHT entry for the stats template.
6. Update the experimental log **immediately** (`experimental_log.md` for
   MuSiQue, `experimental_log_bright.md` for BRIGHT) — hypothesis, change,
   results table, analysis, decision.
7. If improved: commit with scores in the message. If regressed: revert
   the code (`git checkout src/memory.ts src/mcp-server*.ts`).

**Rules.** Always test one experiment at a time. Always log before moving
on. Sign-test vs paired-t disagreement is informative — a metric that's
directionally significant (sign) but not magnitude-significant (t) is
still a real signal; both-insignificant is noise.

## DB Schema (BRIGHT)

`bright_<domain>` tables (via `createCorpusTable`):

| Column | Type | Notes |
|--------|------|-------|
| id | text | PK. BRIGHT gold IDs are text (e.g. `math_train_..._513`) — not UUIDs. |
| content | text | NOT NULL. |
| tree | ltree | Source label. Set by `brightSourceTree(id)` at ingest. |
| meta | jsonb | Per-chunk metadata. Currently populated for aops only via `tag_aops_corpus.ts`. |
| embedding | halfvec(1536) | OpenAI text-embedding-3-small. |
| created_at | timestamptz | Auto. |

Indexes per table: PK, HNSW (embedding halfvec_cosine_ops), BM25 (content
via pg_textsearch), GIST (tree), GIN (meta jsonb_path_ops).

The MuSiQue `corpus` table has the same columns minus `meta`.

## Environment

Requires `.env` with:
- `DATABASE_URL` — Postgres with pgvector, ltree, pg_textsearch, pg_trgm.
- `OPENAI_API_KEY` — for embeddings.

QA answering and BRIGHT eval use `claude -p` (Claude Code CLI) — no
separate Anthropic key needed.

**Important**: use a separate DATABASE_URL from the LoCoMo harness to
avoid table collisions.

## Results

- `results/history.jsonl` — MuSiQue one-line-per-run.
- `results/bright-history.jsonl` — BRIGHT one-line-per-run (includes
  nDCG / retrieval recall / ranking recall).
- `results/eval-{timestamp}.json` — full MuSiQue per-question.
- `results/bright-eval-{timestamp}.json` — full BRIGHT per-query,
  including each tool call's `args` and `resultIds` for later diagnosis.
- Git log — experiment history with scores in commit messages.

## Experiment Logs

- `experimental_log.md` — MuSiQue experiments.
- `experimental_log_bright.md` — BRIGHT experiments (current primary log).

For every experiment, log:
- Hypothesis and what changed
- Which domain/hops it targets
- Full metrics table with deltas + paired-t + sign-test p-values
- Analysis of why it helped / hurt
- Decision (adopted / reverted / needs-follow-up)

Update the log immediately after each experiment, before moving on.

## Planned work

See `hypothesis-to-test.md` for the current queue of BRIGHT experiments
ranked by expected impact / effort. Top of the list: pre-computed query
reasoning (BRIGHT canonical technique, paper claims +12.2 nDCG on
reasoning-intensive queries when done as a separate pre-pass).
