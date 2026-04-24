// BRIGHT benchmark evaluation.
//
// For each query, spawns Claude with MCP tools to search the corpus,
// collects ranked document IDs, and scores with nDCG@10.
//
// Usage:
//   bun run eval:bright -- --domain pony --desc "baseline"
//   bun run eval:bright:quick                                 # 20 queries, pony

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import postgres from "postgres";
import { buildPromptBright } from "./memory.ts";
import { ndcg } from "./ndcg.ts";
import { brightTableName } from "./config.ts";
import type { BrightExample, BrightQueryResult, BrightEvalRun } from "./types_bright.ts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let samples = Infinity;
  let domain = "";
  let description = "";
  let model = "haiku";
  let reason = false;
  let reasonModel = "";
  let effort = "xhigh"; // default for this harness; overridable per run

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--samples" && args[i + 1]) {
      samples = Number.parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === "--domain" && args[i + 1]) {
      domain = args[i + 1]!;
      i++;
    } else if (args[i] === "--desc" && args[i + 1]) {
      description = args[i + 1]!;
      i++;
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    } else if (args[i] === "--effort" && args[i + 1]) {
      effort = args[i + 1]!;
      i++;
    } else if (args[i] === "--reason") {
      reason = true;
    } else if (args[i] === "--reason-model" && args[i + 1]) {
      reasonModel = args[i + 1]!;
      reason = true;
      i++;
    }
  }

  return { samples, domain, description, model, effort, reason, reasonModel: reasonModel || model };
}

// ---------------------------------------------------------------------------
// LLM answering
// ---------------------------------------------------------------------------

function mcpConfigFor(
  tableName: string,
  domain: string,
  excludedIdsPath?: string,
): string {
  // aops and theoremqa_questions share a blended corpus with a populated
  // `tree` ltree column; their MCP variant exposes treeMatch.
  const serverFile =
    domain === "aops" || domain === "theoremqa_questions"
      ? "src/mcp-server-aops.ts"
      : "src/mcp-server.ts";
  const env: Record<string, string> = { MCP_TABLE: tableName };
  if (excludedIdsPath) env.MCP_EXCLUDED_IDS_PATH = excludedIdsPath;
  return JSON.stringify({
    mcpServers: {
      recall: {
        command: "bun",
        args: [serverFile],
        env,
      },
    },
  });
}

const MCP_TOOLS = "mcp__recall__me_memory_search";
const TIMEOUT_MS = 240_000;
const MAX_RETRIES = 2;
// Pinned Claude CLI settings file (copied from ~/.claude/settings.json into
// this repo's .claude/). Prevents experiments from silently drifting when the
// user edits their global Claude config between runs. The file is
// gitignored — each workstation must copy it in on first use.
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const JSON_SCHEMA = '{"type":"object","properties":{"ranked_ids":{"type":"array","items":{"type":"string"}}},"required":["ranked_ids"]}';

interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  resultIds: string[];
}

interface ClaudeResult {
  rankedIds: string[];
  toolCalls: ToolCallRecord[];
  retrievedIds: Set<string>;
}

async function askClaudeOnce(prompt: string, mcpConfig: string, model: string, effort: string): Promise<ClaudeResult> {
  const args = [
    "claude", "-p", prompt,
    "--settings", CLAUDE_SETTINGS_PATH,
    "--output-format", "json", "--verbose", "--model", model,
    "--effort", effort,
    "--json-schema", JSON_SCHEMA,
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--tools", MCP_TOOLS, "--allowedTools", MCP_TOOLS,
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.slice(0, 200) || `exit code ${exitCode}`);
  }

  try {
    const events = JSON.parse(stdout);
    const toolCallsById = new Map<string, ToolCallRecord>();
    const toolCalls: ToolCallRecord[] = [];
    const retrievedIds = new Set<string>();
    let rankedIds: string[] = [];

    for (const evt of events) {
      if (evt.type === "assistant") {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "tool_use") {
            const record: ToolCallRecord = {
              tool: block.name,
              args: block.input ?? {},
              resultIds: [],
            };
            toolCalls.push(record);
            if (block.id) toolCallsById.set(block.id, record);
          }
        }
      }
      if (evt.type === "user") {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text ?? "").join("")
              : String(block.content ?? "");
            const ids: string[] = [];
            for (const m of text.matchAll(/id: ([^,\)]+)[,\)]/g)) {
              const id = m[1]!.trim();
              ids.push(id);
              retrievedIds.add(id);
            }
            const record = block.tool_use_id ? toolCallsById.get(block.tool_use_id) : null;
            if (record) record.resultIds = ids;
          }
        }
      }
      if (evt.type === "result") {
        const output = evt.structured_output;
        if (output?.ranked_ids && Array.isArray(output.ranked_ids)) {
          rankedIds = output.ranked_ids;
        }
      }
    }

    // Fallback: if structured output failed, use retrieved IDs in order
    if (rankedIds.length === 0 && retrievedIds.size > 0) {
      rankedIds = [...retrievedIds];
    }

    return { rankedIds, toolCalls, retrievedIds };
  } catch {
    return { rankedIds: [], toolCalls: [], retrievedIds: new Set() };
  }
}

async function askClaude(prompt: string, mcpConfig: string, model: string, effort: string): Promise<ClaudeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await askClaudeOnce(prompt, mcpConfig, model, effort);
    } catch (e: any) {
      if (attempt < MAX_RETRIES) {
        process.stderr.write(`  retry(${attempt + 1}) `);
      } else {
        console.error(`  claude failed after ${MAX_RETRIES + 1} attempts: ${e.message?.slice(0, 100)}`);
        return { rankedIds: [], toolCalls: [], retrievedIds: new Set() };
      }
    }
  }
  return { rankedIds: [], toolCalls: [], retrievedIds: new Set() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// Pre-computed query reasoning (BRIGHT canonical technique; +12.2 nDCG in
// the paper). Runs a separate LLM call with the exact prompt from BRIGHT's
// reference `reason.py` to produce a step-by-step analysis of the query.
// The reasoning text is prepended to the search agent's prompt so the
// agent has it as context for planning its searches, without costing its
// own output-token budget.
// ---------------------------------------------------------------------------
// Lean variant of BRIGHT's reasoning prompt: force a brief, technique-focused
// analysis rather than a full solution. The full solution is ~500-1000 tokens
// which bloats the agent's prompt and seems to dilute its attention. This
// version targets ~150 tokens with the diagnostic information (problem type,
// techniques, solution strategy outline).
const BRIGHT_REASONING_PROMPT = (query: string) => `${query}

Produce a BRIEF analysis (under 150 words) with three parts:
1. Problem type: what kind of problem is this in one short phrase (e.g. "quadratic Diophantine equation", "probability via Fibonacci recurrence", "power sums of polynomial roots").
2. Key techniques: the 2-4 specific named theorems / techniques that apply (e.g. Vieta's formulas, Newton's identities, Frobenius number, Pigeonhole, Chinese Remainder Theorem).
3. Solution outline: one or two sentences sketching the solution path — the key step, not the full arithmetic.

Be concise. Do not produce a full derivation.`;

async function reasonAboutQuery(query: string, model: string, effort: string): Promise<string> {
  const proc = Bun.spawn([
    "claude", "-p", BRIGHT_REASONING_PROMPT(query),
    "--settings", CLAUDE_SETTINGS_PATH,
    "--output-format", "json", "--model", model, "--effort", effort,
  ], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  try {
    const evts = JSON.parse(stdout);
    for (const evt of (Array.isArray(evts) ? evts : [evts])) {
      if (evt.type === "result" && typeof evt.result === "string") return evt.result;
    }
  } catch {
    /* fall through */
  }
  return ""; // empty reasoning on failure; agent still runs with raw query
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { samples: maxSamples, domain, description, model, effort, reason, reasonModel } = parseArgs();

  if (!domain) {
    console.error("--domain is required. E.g.: bun run eval:bright -- --domain pony");
    process.exit(1);
  }

  // Load examples
  const examplesPath = `data/bright/${domain}/examples.jsonl`;
  const lines = readFileSync(examplesPath, "utf-8").trim().split("\n");
  const allExamples: BrightExample[] = lines.map((l) => JSON.parse(l));
  const examples = allExamples.slice(0, maxSamples);

  console.log(`=== BRIGHT Evaluation (${domain}) ===`);
  console.log(`Queries: ${examples.length}/${allExamples.length}\n`);

  const tableName = brightTableName(domain);
  // Per-query MCP config so we can inject query-specific excluded_ids via env var.
  const excludedDir = pathJoin(tmpdir(), `bright-excluded-${Date.now()}-${process.pid}`);
  mkdirSync(excludedDir, { recursive: true });

  // Verify corpus is loaded
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const [memRow] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
  if (memRow!.count === 0) {
    console.error(`${tableName} table is empty. Run \`bun run ingest:bright -- --domain ${domain}\` first.`);
    await sql.end();
    process.exit(1);
  }
  console.log(`Corpus: ${memRow!.count} documents in ${tableName}`);
  console.log(`Model: ${model}, effort: ${effort}`);
  if (reason) console.log(`Reasoning pre-pass: enabled (model=${reasonModel})`);
  console.log();
  await sql.end();

  // Evaluate queries
  const allResults: BrightQueryResult[] = new Array(examples.length);
  const CONCURRENCY = 10;

  console.log(`Answering ${examples.length} queries...`);
  let t0 = performance.now();
  let completed = 0;

  for (let batch = 0; batch < examples.length; batch += CONCURRENCY) {
    const end = Math.min(batch + CONCURRENCY, examples.length);
    const promises: Promise<void>[] = [];

    for (let qi = batch; qi < end; qi++) {
      const ex = examples[qi]!;
      promises.push(
        (async () => {
          let prompt = buildPromptBright(ex.query, domain);
          if (reason) {
            const reasoning = await reasonAboutQuery(ex.query, reasonModel, effort);
            if (reasoning) {
              // Prepend the reasoning as added context. Keep the original
              // prompt structure intact so the agent's existing directives
              // (search tool usage, ranking output format) still apply.
              prompt = `Before you begin, here is a step-by-step analysis of this query produced by a separate reasoning pass. Use it as context for planning your searches, but follow the task instructions below.\n\n=== REASONING ===\n${reasoning}\n=== END REASONING ===\n\n${prompt}`;
            }
          }

          // Build per-query MCP config with excluded_ids injected silently via env var.
          const realExcluded = ex.excluded_ids.filter((id) => id !== "N/A");
          let excludedPath: string | undefined;
          if (realExcluded.length > 0) {
            excludedPath = pathJoin(excludedDir, `${qi}.txt`);
            writeFileSync(excludedPath, realExcluded.join("\n"));
          }
          const perQueryMcpConfig = mcpConfigFor(tableName, domain, excludedPath);
          const result = await askClaude(prompt, perQueryMcpConfig, model, effort);

          // Belt-and-braces: still strip excluded from final ranking output in case
          // the agent echoes an excluded id it had seen before exclusion was in effect.
          const excludedSet = new Set(realExcluded);

          // Optional second-pass rerank: fresh LLM context with only
          // (query, candidate contents), avoiding attention dilution from the
          // agent's tool-call history. Candidates = all unique IDs the agent saw.
          const filteredIds = result.rankedIds.filter((id) => !excludedSet.has(id));

          // Compute nDCG@10
          const goldSet = new Set(ex.gold_ids);
          const score = ndcg(filteredIds, goldSet, 10);

          // Recall metrics
          const top10 = new Set(filteredIds.slice(0, 10));
          const seenFromToolCalls = new Set<string>();
          for (const tc of result.toolCalls) {
            for (const id of tc.resultIds) {
              if (goldSet.has(id)) seenFromToolCalls.add(id);
            }
          }
          const goldCount = goldSet.size;
          const retrievalRecall = goldCount === 0 ? 0 : seenFromToolCalls.size / goldCount;
          const inTop10 = [...goldSet].filter((id) => top10.has(id)).length;
          const rankingRecall = goldCount === 0 ? 0 : inTop10 / goldCount;

          allResults[qi] = {
            domain,
            queryId: ex.id,
            query: ex.query,
            goldIds: ex.gold_ids,
            retrievedIds: filteredIds.slice(0, 10),
            ndcg10: score,
            retrievalRecall,
            rankingRecall,
            numToolCalls: result.toolCalls.length,
            toolCalls: result.toolCalls,
          };

          completed++;
          process.stdout.write(`  Query: ${completed}/${examples.length}\n`);
        })(),
      );
    }

    await Promise.all(promises);
  }
  const answerTime = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`Evaluation complete (${answerTime}s)\n`);

  // Clean up temp excluded-ids files
  try { rmSync(excludedDir, { recursive: true, force: true }); } catch {}

  // Compute aggregates
  const overallNdcg10 = mean(allResults.map((r) => r.ndcg10));
  const overallRetrievalRecall = mean(allResults.map((r) => r.retrievalRecall));
  const overallRankingRecall = mean(allResults.map((r) => r.rankingRecall));
  const avgToolCalls = mean(allResults.map((r) => r.numToolCalls));
  const queriesWithZeroGoldSeen = allResults.filter((r) => r.retrievalRecall === 0).length;

  console.log(`Domain: ${domain}`);
  console.log(`  nDCG@10:          ${overallNdcg10.toFixed(3)}`);
  console.log(`  Retrieval recall: ${overallRetrievalRecall.toFixed(3)}  (gold seen in any tool call)`);
  console.log(`  Ranking recall:   ${overallRankingRecall.toFixed(3)}  (gold in final top-10)`);
  console.log(`  Zero-gold queries: ${queriesWithZeroGoldSeen}/${allResults.length}`);
  console.log(`  Avg tool calls:   ${avgToolCalls.toFixed(1)}`);
  console.log(`  Queries:          ${allResults.length}\n`);

  // Save results
  const timestamp = new Date().toISOString();
  const evalRun: BrightEvalRun = {
    timestamp,
    totalQueries: allResults.length,
    overallNdcg10,
    overallRetrievalRecall,
    overallRankingRecall,
    byDomain: {
      [domain]: {
        count: allResults.length,
        ndcg10: overallNdcg10,
        retrievalRecall: overallRetrievalRecall,
        rankingRecall: overallRankingRecall,
      },
    },
    description,
    results: allResults,
  };

  mkdirSync("results", { recursive: true });
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const resultPath = `results/bright-eval-${safeTimestamp}.json`;
  writeFileSync(resultPath, JSON.stringify(evalRun, null, 2));

  const historyLine = JSON.stringify({
    timestamp,
    domain,
    ndcg10: Number(overallNdcg10.toFixed(4)),
    retrievalRecall: Number(overallRetrievalRecall.toFixed(4)),
    rankingRecall: Number(overallRankingRecall.toFixed(4)),
    queries: allResults.length,
    description,
  });
  appendFileSync("results/bright-history.jsonl", historyLine + "\n");

  console.log(`Results saved to ${resultPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
