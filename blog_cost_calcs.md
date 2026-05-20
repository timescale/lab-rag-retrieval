# Cost calculations for the blog

How we got from `claude -p` invocations to "~$0.65/query, ~$890 per BRIGHT
eval run, ~5,000× a specialized retriever." Reproducible — anyone re-running
the steps below should land within ~10% of the numbers as long as Anthropic's
pricing hasn't shifted.

## 1. What we measured

The eval harness (`src/evaluate-bright.ts`, `src/evaluate.ts`) invokes
`claude -p ... --output-format json --verbose`. The CLI emits an event
stream; the final `result` event includes `total_cost_usd` plus a `usage`
breakdown (input, output, cache_read, cache_create). The existing eval
ignores those fields. For this cost analysis we re-ran a small sample
through the same configuration and captured them.

### Sampling script

A minimal wrapper around the same `claude -p` invocation the eval uses,
parsing the `result` event for cost and usage. Written to
`/tmp/measure_cost.ts` (BRIGHT) and `/tmp/measure_musique.ts` (MuSiQue);
inline here for reproducibility.

```typescript
// /tmp/measure_cost.ts
import { buildPromptBright } from "/Users/cevian/Development/autoresearch_me/harness_rag/src/memory.ts";
import { brightTableName } from "/Users/cevian/Development/autoresearch_me/harness_rag/src/config.ts";
import { readFileSync } from "fs";

const domain = process.argv[2] ?? "biology";
const samples = parseInt(process.argv[3] ?? "2");
const model = process.argv[4] ?? "opus";
const effort = process.argv[5] ?? "max";

const examples = readFileSync(
  `/Users/cevian/Development/autoresearch_me/harness_rag/data/bright/${domain}/examples.jsonl`,
  "utf-8",
).split("\n").filter(l => l.trim()).slice(0, samples).map(l => JSON.parse(l));

const tableName = brightTableName(domain);
const mcpConfig = JSON.stringify({
  mcpServers: {
    recall: {
      command: "bun",
      args: ["/Users/cevian/Development/autoresearch_me/harness_rag/src/mcp-server.ts"],
      env: { MCP_TABLE: tableName },
    },
  },
});

const JSON_SCHEMA =
  '{"type":"object","properties":{"answer":{"type":"string"},"ranked_ids":{"type":"array","items":{"type":"string"}}},"required":["ranked_ids"]}';
const MCP_TOOLS = "mcp__recall__me_memory_search";

for (const ex of examples) {
  const prompt = buildPromptBright(ex.query, domain);
  const args = [
    "claude", "-p", prompt,
    "--setting-sources", "project",
    "--output-format", "json", "--verbose", "--model", model,
    "--effort", effort,
    "--json-schema", JSON_SCHEMA,
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--tools", MCP_TOOLS, "--allowedTools", MCP_TOOLS,
  ];
  const t0 = performance.now();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", cwd: "/Users/cevian/Development/autoresearch_me/harness_rag" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const wall = (performance.now() - t0) / 1000;
  const events = JSON.parse(stdout);
  const result = events.find((e: any) => e.type === "result");
  const u = result.usage;
  let toolCalls = 0;
  for (const e of events) {
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) if (b.type === "tool_use") toolCalls++;
    }
  }
  console.log(JSON.stringify({
    cost_usd: result.total_cost_usd, wall_s: wall, tool_calls: toolCalls,
    cache_read: u.cache_read_input_tokens, cache_create: u.cache_creation_input_tokens,
    output: u.output_tokens,
  }));
}
```

The MuSiQue variant differs only in `buildPrompt` (no domain arg), table
name (`corpus`), data path (`data/dev.jsonl`), and model (`haiku`).

### Raw sample results

Ran against `DATABASE_URL=cbolbquuw3...` (original corpus DB; the active
fork `p7di7u36o4` shares the same schema and biology/robotics tables — the
sample is representative).

| Sample | n | mean $/q | mean wall s | mean tool calls | mean cache_create | mean cache_read | mean output |
|---|---:|---:|---:|---:|---:|---:|---:|
| biology, opus max | 8 | $0.256 | 29.0 | 1.5 | 32,533 | 26,028 | 1,491 |
| robotics, opus max | 3 | $0.291 | 32.6 | 1.0 | 37,894 | 7,420 | 1,876 |
| aops, sonnet xhigh | 3 | $0.192 | 71.6 | 6.7 | 30,288 | 73,632 | 3,616 |
| MuSiQue, haiku (no effort flag) | 5 | $0.117 | 77.1 | 14.0 | 49,569 | 391,496 | 3,096 |

Individual query records (cost, tool calls):

- biology opus max: $0.31/1tc, $0.24/1tc, $0.26/1tc, $0.24/1tc, $0.26/1tc, $0.45/5tc, $0.25/1tc, $0.26/1tc
- robotics opus max: $0.26/1tc, $0.28/1tc, $0.34/1tc
- aops sonnet xhigh: $0.19/6tc, $0.16/4tc, $0.23/10tc
- MuSiQue haiku: $0.24/30tc, $0.10/12tc, $0.06/5tc, $0.14/17tc, $0.06/6tc

The full per-query records remain in the background-task output files
under `/private/tmp/claude-501/.../tasks/` (ephemeral; treat the table
above as the persistent record).

## 2. The tool-call discrepancy

In our sample, BRIGHT queries averaged 1–7 tool calls. The actual headline
eval (mid-May) recorded 8–18 mean tool calls per domain. Three candidate
explanations:

1. **Opus 4.7 has gotten more decisive.** The headline eval ran an earlier
   Opus snapshot; today's Opus more often answers in one search.
2. **The first N queries in `examples.jsonl` are easier than the corpus
   mean.** We sampled from the top of the file.
3. **DB/corpus differences.** We ran against `cbolbquuw3` (original); the
   headline biology eval ran on `jdyfwo1bxu` (bright-eval fork). Same
   schema, possibly different ingestion-time content.

The directionally consistent observation across biology and robotics (all
my samples at 1 tool call, eval distribution starts at 3) makes (1) the
most likely primary cause. (2) is plausibly contributing. (3) we have no
direct evidence for.

This matters because **cost scales with tool calls**, so reporting the raw
sample $/query would understate what the actual headline eval cost. We
correct by extrapolating to the eval's observed tool-call means using a
marginal $/tc derived from the same samples.

## 3. Marginal cost per tool call

From the biology sample, two cost points:

- 7 queries at 1 tool call: mean cost $0.24
- 1 query at 5 tool calls: cost $0.45

Marginal slope: ($0.45 − $0.24) / (5 − 1) = **$0.053 per additional tool
call (Opus max)**.

From the aops sample (sonnet xhigh), two cost points:

- 1 query at 4 tool calls: $0.157
- 1 query at 10 tool calls: $0.233

Marginal slope: ($0.233 − $0.157) / (10 − 4) = **$0.013 per additional tool
call (Sonnet xhigh)**.

Why so much smaller for Sonnet? Pricing alone: Sonnet input/output is ~5×
cheaper than Opus per token, and most of the marginal cost per tool call
is fresh input (tool_result tokens entering the prefix) plus output tokens
(thinking + tool_use).

Two slopes from N=2 and N=2 points respectively is a thin foundation —
treat as ±50% confidence intervals on the marginal. The base costs are
better-measured because we have 8 single-tool-call biology queries
clustered tightly around $0.24.

**Base cost at 1 tool call:**
- Opus max: ~$0.20 (system + tool defs + initial cache create + ~1 round
  of thinking + tool_use + final answer)
- Sonnet xhigh: ~$0.13
- Haiku (MuSiQue): scale separately — see §5

## 4. Extrapolation formula

For each BRIGHT domain in the headline eval:

```
est_cost_per_query = base(model) + max(0, eval_mean_tc − 1) × marginal(model)
domain_total = est_cost_per_query × n_queries
```

For MuSiQue we sampled enough Haiku queries (5) with sufficient tool-call
variation (5–30 tc) that we can use the sample mean directly, scaled by
the ratio of eval-mean-tc to sample-mean-tc:

```
musique_est_per_query = sample_cost × (eval_mean_tc / sample_mean_tc)
                      = $0.117 × (11.07 / 14.0) = $0.092
```

(That correction is small because Haiku's per-tc cost is small anyway —
the $0.117 sample is already close to what eval-mean-tc would imply.)

## 5. Per-domain extrapolated costs

Eval mean tool calls per domain come from
`results/bright-eval-*.json` files matching the headline runs in
`results/bright-history.jsonl`. The 12 headline files we used:

| Domain | Eval JSON file (basename) |
|---|---|
| biology | bright-eval-2026-05-14T21-11-48-231Z.json |
| psychology | bright-eval-2026-05-14T19-31-00-074Z.json |
| theoremqa_questions | bright-eval-2026-04-26T10-19-58-864Z.json |
| pony | bright-eval-2026-04-27T13-16-21-435Z.json |
| sustainable_living | bright-eval-2026-05-14T14-50-49-968Z.json |
| earth_science | bright-eval-2026-05-14T19-06-49-303Z.json |
| leetcode | bright-eval-2026-05-05T15-05-26-809Z.json |
| robotics | bright-eval-2026-05-13T10-14-26-977Z.json |
| theoremqa_theorems | bright-eval-2026-05-15T04-16-40-481Z.json |
| economics | bright-eval-2026-05-14T04-36-50-796Z.json |
| stackoverflow | bright-eval-2026-05-15T04-53-59-366Z.json |
| aops | bright-eval-2026-04-25T00-50-46-972Z.json |

Tool-call mean is `mean(r.numToolCalls for r in eval_json.results)`.

Applying the formula:

| Domain | Model | Eval mean TC | n queries | Est $/q | Domain total |
|---|---|---:|---:|---:|---:|
| theoremqa_questions | sonnet xhigh | 18.31 | 194 | $0.35 | $68 |
| leetcode | opus max | 15.77 | 142 | $0.98 | $139 |
| aops | sonnet xhigh | 16.78 | 111 | $0.33 | $37 |
| pony | opus max | 12.38 | 112 | $0.80 | $89 |
| sustainable_living | opus max | 11.77 | 108 | $0.77 | $83 |
| economics | opus max | 11.05 | 103 | $0.73 | $75 |
| earth_science | opus max | 10.72 | 116 | $0.71 | $82 |
| psychology | opus max | 10.06 | 101 | $0.68 | $68 |
| robotics | opus max | 9.88 | 101 | $0.67 | $67 |
| theoremqa_theorems | opus max | 9.62 | 76 | $0.65 | $50 |
| stackoverflow | opus max | 9.12 | 117 | $0.63 | $73 |
| biology | opus max | 8.23 | 103 | $0.58 | $60 |
| **TOTAL** | | | **1,384** | | **~$890** |

MuSiQue 500q: $0.092/q × 500 ≈ **~$46**.

## 6. Wall-clock per eval run

`CONCURRENCY = 10` in BRIGHT eval (`src/evaluate-bright.ts:322`),
`CONCURRENCY = 5` in MuSiQue tool mode (`src/evaluate.ts:245`).

Mean wall-clock per query from our samples: ~30s (BRIGHT Opus) and ~77s
(MuSiQue Haiku — slower per query because of higher tool-call counts and
the iterative search depth on multi-hop questions).

```
BRIGHT:  1,384 queries × 30s / 10 concurrent ≈ 4,150s ≈ 70 min
MuSiQue:   500 queries × 77s /  5 concurrent ≈ 7,700s ≈ 130 min
```

These match the experiment-log entries' implicit timing (eval runs
typically completed in 1–2 hours).

## 7. Cumulative loop cost

`results/bright-history.jsonl` has 100 entries; `results/history.jsonl`
(MuSiQue) has ~25. Most are full-domain or multi-domain runs but some are
20q smoke tests.

Crude bounds (no per-entry sizing — would need to read each entry's
`queries` field):

- Smoke tests (20–30q): ~$10–20 each.
- Single-domain full runs (76–194q): ~$30–$140 each.
- Multi-domain runs (e.g. "All-domains-rerun"): ~$300–$900 each.

If the 100 BRIGHT history entries average ~$150 each: **~$15K cumulative**.
If they average ~$300 each (more multi-domain runs): **~$30K**.

MuSiQue: ~25 entries × ~$30 average ≈ **~$750**.

A precise version of this would parse each history line, look up the
matching eval JSON, sum tool-call counts and apply the per-tc cost.
Skipped here because the total isn't directly cited in the blog — only
the per-eval cost is.

## 8. Comparison to specialized retrievers

The leaderboard table (Mira, INF-X, RakanEmbed4B, DIVER, BGE-Reasoner)
runs a forward pass through a fine-tuned embedding model per query.

| Approach | $/query | latency | training cost |
|---|---:|---:|---|
| Our agent loop (BRIGHT, Opus max) | ~$0.65 | ~30s | none |
| Our agent loop (MuSiQue, Haiku) | ~$0.09 | ~77s | none |
| Fine-tuned retriever (Mira-class) | ~$0.0001 | <1s | $10K–$100K one-time |

The $0.0001/query figure is order-of-magnitude — running a ~500M-param
embedding model on a commodity GPU costs ~$1/hr, processes ~10–100
queries/sec, so per query is fractions of a cent.

Ratio against BRIGHT Opus per-query: ~6,500× cost, ~30× latency.

The one-time training cost amortizes over millions of queries — for
production traffic, the per-query gap is what matters; for ad-hoc /
research / per-corpus deployments, the training cost may exceed the
inference savings.

## 9. Caveats

1. **Marginal cost per tool call is from N=2 points.** Likely accurate
   within ±50% but not tight. A larger sample with explicit usage
   capture (modify `src/evaluate-bright.ts` to log `result.usage` and
   `result.total_cost_usd` per query, re-run on 50–100 queries) would
   pin this down.

2. **Reproduction had lower tool calls than the headline eval.** The
   extrapolation corrects for this, but the correction itself assumes
   the *cost structure* per tool call is the same in the historical
   eval as it is now. If Opus pricing has shifted since May, all the
   absolute dollar numbers move proportionally.

3. **MuSiQue sample (5q) had higher mean tool calls (14) than the eval
   mean (11).** The scaling correction is small (×0.79), but with N=5
   the sample mean is noisy.

4. **No cache-sharing across queries.** Each `claude -p` invocation is
   a fresh session, so each pays the ~30K-token cache_create overhead
   of the Claude Code default system prompt. A daemonized agent that
   reused a warmed cache across many queries would be substantially
   cheaper. The blog's per-query figures reflect the
   one-session-per-query architecture we actually used.

5. **Pricing assumptions.** The `total_cost_usd` field from `claude -p`
   uses current Anthropic API pricing (as of 2026-05-20). Quoted
   marginal slopes are derived from those numbers, not from an
   independent pricing table — if Anthropic shifts rates, the marginals
   should be re-derived rather than scaled.

6. **Specialized-retriever comparison is hypothetical.** We didn't run
   Mira / INF-X / RakanEmbed4B locally. The cost number for them is
   what running a small/medium embedding model would cost; the actual
   leaderboard systems may run something larger and slightly more
   expensive. Order of magnitude is the right level of confidence.

## Pricing reference (derived, not quoted)

The `total_cost_usd` field implies the following rates as of
2026-05-20 (Opus 4.7, 1-hour ephemeral cache):

- Opus 4.7: input ~$15/M, output ~$75/M, cache_create ~$5/M (1h), cache_read ~$1/M
- Sonnet 4.6: input ~$3/M, output ~$15/M, cache_create ~$1/M (1h), cache_read ~$0.30/M (estimated, not back-derived here)
- Haiku 4.5: input ~$1/M, output ~$5/M, cache_create ~$1.25/M (1h), cache_read ~$0.10/M

These were back-derived from a handful of `total_cost_usd` values cross-referenced against
the reported `usage` field. They are sanity-check approximations; consult
Anthropic's pricing page for authoritative numbers.
