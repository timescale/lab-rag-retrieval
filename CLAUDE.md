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

## Current database (active fork)

- **Active fork**: `jdyfwo1bxu` (name: `bright-eval`, Ghost dev) — referenced
  in `.env`'s `DATABASE_URL`. Restored as active 2026-04-25 after H3 reverted.
  Contains:
  - All 12 BRIGHT domain tables populated
  - `meta` jsonb column on `bright_aops` populated via
    `tag_aops_corpus.ts` (~13k tagged chunks in useful sources)
  - Flat single-label tree values for aops
- **Idle fork (H3 leftover)**: `p7di7u36o4` (name: `bright-h3-pseudoqueries`)
  — fork of `jdyfwo1bxu` taken 2026-04-24 for H3 experiment. H3 declared
  non-viable; this fork still holds the pseudo-query data and the
  `search_content` column / index for reference. Ghost MCP doesn't expose
  pause, so this is left running unless manually paused via Ghost UI.
- **Prior fork**: `cbolbquuw3` (name: `autoresearch-rag`, ~15 GiB, running
  again) — original DB. Not in active rotation.

See "Database fork workflow" below for the rule on when to fork.

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
3. **If the experiment requires changing DB schema or data** (column
   additions, new indexes, re-tagging, re-embedding, tree migration):
   fork the DB first. See "Database fork workflow" below. **Prompt-only
   or MCP-tool-only experiments do NOT need a fork** — run them on the
   current active DB.
4. Modify the right surface:
   - Retrieval/prompt only → just re-run eval
   - Ingestion → re-ingest (`--force`) then eval
5. Run eval with a descriptive `--desc`:
   - BRIGHT: `bun run eval:bright -- --domain <d> --desc "<change>"`
   - MuSiQue: `bun run eval:quick -- --desc "<change>"`
6. Compare against the previous baseline with paired-t and sign tests on
   per-query deltas. Report nDCG + retrieval recall + ranking recall +
   zero-gold count. See any recent BRIGHT entry for the stats template.
7. Update the experimental log **immediately** (`experimental_log.md` for
   MuSiQue, `experimental_log_bright.md` for BRIGHT) — hypothesis, change,
   results table, analysis, decision.
8. Commit in both cases, so the experiment log entry is preserved:
   - If improved: commit the code changes + log entry together, with
     scores in the message.
   - If regressed: revert the code (`git checkout src/memory.ts
     src/mcp-server*.ts`) but still commit the log entry (and any
     result JSON artifacts) so the reasoning is recorded for future
     sessions. The commit message should note the revert and the
     regression magnitude.
9. If the experiment used a fork, resolve it (see fork workflow): keep
   the winning fork, pause the losing one, update the "Current database
   (active fork)" section at the top of this file.

**Rules.** Always test one experiment at a time. Always log before moving
on. Sign-test vs paired-t disagreement is informative — a metric that's
directionally significant (sign) but not magnitude-significant (t) is
still a real signal; both-insignificant is noise.

**Iterate before abandoning.** For each hypothesis from
`hypothesis-to-test.md` (or self-generated), if the first attempt
doesn't work, analyze the failure and try to fix the implementation
before abandoning the idea. Allow **up to 3 attempts per hypothesis**.
Each attempt should:
- Identify what went wrong (regressed metric, agent behavior, tool
  usage, bug in the mechanism).
- Propose a specific correction (prompt tweak, parameter change,
  different formulation of the same core idea).
- Run and log the result independently.

You can also decide at any point that the idea is non-viable and stop
early — document why. Examples of reasonable non-viability calls:
- The mechanism fundamentally conflicts with something load-bearing
  (e.g. answer-forcing steals tool-call budget → can't be fixed without
  removing tool calls).
- The hypothesis wasn't specific enough and the corrected versions are
  really separate ideas.
- Diminishing returns: two attempts showed the best variant was still
  regressing; the next tweak is unlikely to flip it.

Either way, **log each attempt** in the experimental log — including the
ones you abandon — so future sessions see what was tried and why it
didn't land. Pattern: one log section per hypothesis with an entry per
attempt (numbered) and a final "Decision" block.

## Database fork workflow

**When to fork.**
- Adding / removing / ALTERing a column.
- Changing ingestion logic (re-chunk, re-embed, enrichment, new metadata).
- Running a tagging / annotation job that writes to the DB.
- Anything else that mutates schema or data.

**When NOT to fork.**
- Prompt changes only.
- MCP server / eval-harness code changes that only *read* the DB.
- Adding flags or new search params that don't require DB state.

**The fork procedure.**

1. Fork the current active DB via the Ghost MCP:
   `mcp__ghost__ghost_fork(id=<active-fork-id>, name="bright-<experiment>",
   wait=true)`. A fork is ready in a minute or two.
2. Update `.env`'s `DATABASE_URL` to the new fork's connection string.
3. Run the schema/ingest change + the eval on the fork.
4. Resolve at the end:
   - **Experiment wins** (adopting the change): keep the new fork as the
     active fork. Pause the OLD fork via
     `mcp__ghost__ghost_pause(id=<old-id>)`. Update the "Current database
     (active fork)" section of this file: move the old entry to "Prior
     fork" and put the new one as "Active fork", noting the experiment
     name + what schema/data it holds.
   - **Experiment loses** (reverting the change): the old fork is still
     correct. Pause the NEW fork via
     `mcp__ghost__ghost_pause(id=<new-id>)`. Revert the .env to the old
     `DATABASE_URL`. Add the paused fork to the log for reference but
     don't promote it.
5. Log the fork resolution in the experimental log alongside the results
   table, including fork IDs.

**Reuse.** If you're iterating on a change that's still being refined,
stay on the same fork rather than forking again per micro-iteration.
Fork per *experiment class*, not per prompt-tweak.

**Cost note.** Paused Ghost DBs retain data but don't bill compute. We
can always resume a paused fork if we want to re-examine a dead-end
experiment.

**Current forks** are tracked at the top of this file; update that
section after every resolution.

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
