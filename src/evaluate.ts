import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { retrieve, buildPrompt } from "./memory.ts";
import { scoreBatch } from "./scoring.ts";
import type { MuSiQueQuestion, QAResult, EvalRun } from "./types.ts";

// Mode: "tool" = Claude searches via MCP tools, "context" = pre-retrieved context in prompt
const EVAL_MODE = (process.env.EVAL_MODE ?? "tool") as "tool" | "context";

const DEV_PATH = "data/dev.jsonl";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let samples = Infinity;
  let description = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--samples" && args[i + 1]) {
      samples = Number.parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === "--desc" && args[i + 1]) {
      description = args[i + 1]!;
      i++;
    }
  }

  return { samples, description };
}

// ---------------------------------------------------------------------------
// LLM answering
// ---------------------------------------------------------------------------

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    recall: {
      command: "bun",
      args: ["src/mcp-server.ts"],
    },
  },
});

const MCP_TOOLS = "mcp__recall__me_memory_search,mcp__recall__me_memory_get,mcp__recall__me_memory_tree";

const TIMEOUT_MS = 240_000;
const MAX_RETRIES = 2;

interface ClaudeResult {
  answer: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
}

async function askClaudeOnce(prompt: string, useMcp: boolean): Promise<ClaudeResult> {
  const JSON_SCHEMA = '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}';
  const args = ["claude", "-p", prompt, "--output-format", "json", "--verbose", "--model", "haiku", "--json-schema", JSON_SCHEMA];
  if (useMcp) {
    args.push("--mcp-config", MCP_CONFIG, "--strict-mcp-config", "--tools", MCP_TOOLS, "--allowedTools", MCP_TOOLS);
  }
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
    const toolCalls: ClaudeResult["toolCalls"] = [];
    let answer = "";
    for (const evt of events) {
      if (evt.type === "assistant") {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "tool_use") {
            toolCalls.push({ tool: block.name, args: block.input ?? {} });
          }
        }
      }
      if (evt.type === "result") {
        answer = (evt.structured_output?.answer ?? evt.result ?? "").trim();
      }
    }
    return { answer, toolCalls };
  } catch {
    return { answer: stdout.trim(), toolCalls: [] };
  }
}

async function askClaude(prompt: string, useMcp: boolean): Promise<ClaudeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await askClaudeOnce(prompt, useMcp);
    } catch (e: any) {
      if (attempt < MAX_RETRIES) {
        process.stderr.write(`  retry(${attempt + 1}) `);
      } else {
        console.error(`  claude failed after ${MAX_RETRIES + 1} attempts: ${e.message?.slice(0, 100)}`);
        return { answer: "", toolCalls: [] };
      }
    }
  }
  return { answer: "", toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function aggregateByKey(
  results: QAResult[],
  keyFn: (r: QAResult) => string,
): Record<string, { count: number; f1: number; em: number }> {
  const groups = new Map<string, QAResult[]>();
  for (const r of results) {
    const key = keyFn(r);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: Record<string, { count: number; f1: number; em: number }> = {};
  for (const [key, group] of groups) {
    out[key] = {
      count: group.length,
      f1: mean(group.map((r) => r.f1)),
      em: mean(group.map((r) => r.em)),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { samples: maxSamples, description } = parseArgs();

  // Load dev questions
  const lines = readFileSync(DEV_PATH, "utf-8").trim().split("\n");
  const allQuestions: MuSiQueQuestion[] = lines.map((l) => JSON.parse(l));
  const questions = allQuestions.slice(0, maxSamples);

  console.log(
    `=== MuSiQue RAG Evaluation ===\nQuestions: ${questions.length}/${allQuestions.length}\nMode: ${EVAL_MODE}\n`,
  );

  // Connect and verify corpus is loaded
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  const [memRow] = await sql`SELECT count(*)::int as count FROM memory`;
  if (memRow!.count === 0) {
    console.error("Memory table is empty. Run `bun run ingest` first.");
    await sql.end();
    process.exit(1);
  }
  console.log(`Corpus: ${memRow!.count} paragraphs in memory\n`);

  // Answer all questions
  const allResults: QAResult[] = new Array(questions.length);
  const CONCURRENCY = EVAL_MODE === "tool" ? 4 : 50;

  console.log(`Answering ${questions.length} questions...`);
  let t0 = performance.now();
  let completed = 0;

  for (let batch = 0; batch < questions.length; batch += CONCURRENCY) {
    const end = Math.min(batch + CONCURRENCY, questions.length);
    const promises: Promise<void>[] = [];

    for (let qi = batch; qi < end; qi++) {
      const q = questions[qi]!;
      const hops = q.question_decomposition?.length ?? 0;

      promises.push(
        (async () => {
          let prediction: string;
          let context: string;

          let numToolCalls = 0;
          let toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
          if (EVAL_MODE === "context") {
            context = await retrieve(q.question, sql);
            const prompt = buildPrompt(q.question, context);
            const result = await askClaude(prompt, false);
            prediction = result.answer;
          } else {
            const prompt = buildPrompt(q.question, "");
            const result = await askClaude(prompt, true);
            prediction = result.answer;
            toolCalls = result.toolCalls;
            numToolCalls = toolCalls.length;
            context = "(tool mode)";
          }

          allResults[qi] = {
            questionId: q.id,
            question: q.question,
            answer: q.answer,
            answerAliases: q.answer_aliases,
            prediction,
            hops,
            f1: 0,
            em: 0,
            context,
            numToolCalls,
            toolCalls,
          };

          completed++;
          process.stdout.write(`  Answer: ${completed}/${questions.length}\n`);
        })(),
      );
    }

    await Promise.all(promises);
  }
  const answerTime = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`Answering complete (${answerTime}s)\n`);

  // Batch score with Python scorer
  console.log("Scoring...");
  t0 = performance.now();
  const scoreInputs = allResults.map((r) => ({
    prediction: r.prediction,
    answer: r.answer,
    answer_aliases: r.answerAliases,
  }));
  const scores = await scoreBatch(scoreInputs);
  const scoreTime = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`Scoring complete (${scoreTime}s)\n`);

  // Update results with scores
  for (let i = 0; i < allResults.length; i++) {
    allResults[i]!.f1 = scores[i]!.f1;
    allResults[i]!.em = scores[i]!.em;
  }

  // Compute aggregates
  const overallF1 = mean(allResults.map((r) => r.f1));
  const overallEM = mean(allResults.map((r) => r.em));
  const byHops = aggregateByKey(allResults, (r) => String(r.hops));

  // Print summary
  console.log("By Hop Count:");
  for (const [hops, stats] of Object.entries(byHops).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(
      `  ${hops}-hop: F1=${stats.f1.toFixed(3)} EM=${stats.em.toFixed(3)} (n=${stats.count})`,
    );
  }
  const avgToolCalls = mean(allResults.map((r) => r.numToolCalls));
  console.log(
    `\nOverall: F1=${overallF1.toFixed(3)} EM=${overallEM.toFixed(3)} (${allResults.length} questions, avg ${avgToolCalls.toFixed(1)} tool calls)\n`,
  );

  // Build eval run
  const timestamp = new Date().toISOString();
  const memoryTsSource = readFileSync("src/memory.ts", "utf-8");

  const evalRun: EvalRun = {
    timestamp,
    totalQA: allResults.length,
    overallF1,
    overallEM,
    byHops: Object.fromEntries(
      Object.entries(byHops).map(([k, v]) => [Number(k), v]),
    ),
    description,
    results: allResults,
  };

  // Save detailed results
  mkdirSync("results", { recursive: true });
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const resultPath = `results/eval-${safeTimestamp}.json`;
  writeFileSync(resultPath, JSON.stringify(evalRun, null, 2));

  // Append to history log
  const memoryHash = createHash("sha256")
    .update(memoryTsSource)
    .digest("hex")
    .slice(0, 12);
  const historyLine = JSON.stringify({
    timestamp,
    f1: Number(overallF1.toFixed(4)),
    em: Number(overallEM.toFixed(4)),
    questions: allResults.length,
    mode: EVAL_MODE,
    description,
    memory_ts_hash: memoryHash,
  });
  appendFileSync("results/history.jsonl", historyLine + "\n");

  console.log(`Results saved to ${resultPath}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
