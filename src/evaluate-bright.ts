// BRIGHT benchmark evaluation.
//
// For each query, spawns Claude with MCP tools to search the corpus,
// collects ranked document IDs, and scores with nDCG@10.
//
// Usage:
//   bun run eval:bright -- --domain pony --desc "baseline"
//   bun run eval:bright:quick                                 # 20 queries, pony

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
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
    }
  }

  return { samples, domain, description };
}

// ---------------------------------------------------------------------------
// LLM answering
// ---------------------------------------------------------------------------

function mcpConfigFor(tableName: string): string {
  return JSON.stringify({
    mcpServers: {
      recall: {
        command: "bun",
        args: ["src/mcp-server.ts"],
        env: { MCP_TABLE: tableName },
      },
    },
  });
}

const MCP_TOOLS = "mcp__recall__me_memory_search";
const TIMEOUT_MS = 240_000;
const MAX_RETRIES = 2;
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

async function askClaudeOnce(prompt: string, mcpConfig: string): Promise<ClaudeResult> {
  const args = [
    "claude", "-p", prompt,
    "--output-format", "json", "--verbose", "--model", "haiku",
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
            for (const m of text.matchAll(/id: ([^\)]+)\)/g)) {
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

async function askClaude(prompt: string, mcpConfig: string): Promise<ClaudeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await askClaudeOnce(prompt, mcpConfig);
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { samples: maxSamples, domain, description } = parseArgs();

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
  const mcpConfig = mcpConfigFor(tableName);

  // Verify corpus is loaded
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const [memRow] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
  if (memRow!.count === 0) {
    console.error(`${tableName} table is empty. Run \`bun run ingest:bright -- --domain ${domain}\` first.`);
    await sql.end();
    process.exit(1);
  }
  console.log(`Corpus: ${memRow!.count} documents in ${tableName}\n`);
  await sql.end();

  // Evaluate queries
  const allResults: BrightQueryResult[] = new Array(examples.length);
  const CONCURRENCY = 5;

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
          const prompt = buildPromptBright(ex.query, domain);
          const result = await askClaude(prompt, mcpConfig);

          // Filter out excluded IDs
          const excludedSet = new Set(ex.excluded_ids.filter((id) => id !== "N/A"));
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
