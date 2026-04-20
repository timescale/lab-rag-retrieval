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

- Only 4 tool calls per query on average — the agent may not be searching enough
- nDCG@10 of 0.114 means the agent finds some relevant docs but ranking is poor
- BRIGHT queries require reasoning to identify relevance — surface keyword matching is insufficient
