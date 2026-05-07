// Probe: how good is robotics retrieval with the RAW user query as input
// (no agent reformulation)? Establishes a baseline for "best-case retrieval
// with what the user actually typed".
//
// For each query: BM25 top-30 on content + semantic top-30 on embedding,
// RRF-fuse to top-30. Compare gold IDs against this set.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { embed } from "./src/memory.ts";

const RRF_K = 60;
const TOPK = 30;
const URL = process.env.DATABASE_URL!;

interface Example { id: string; query: string; gold_ids: string[]; }

async function main() {
  const lines = readFileSync("data/bright/robotics/examples.jsonl", "utf-8").trim().split("\n");
  const examples: Example[] = lines.map((l) => {
    const r = JSON.parse(l);
    return { id: r.id, query: r.query, gold_ids: r.gold_ids ?? [] };
  });
  console.log(`loaded ${examples.length} queries`);

  const sql = postgres(URL, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30 });
  const T = "bright_robotics";

  // Batch embed queries (cache via OpenAI, no local cache here — fast enough)
  const queryTexts = examples.map((e) => e.query);
  console.log("embedding queries...");
  const embeddings: number[][] = [];
  for (let i = 0; i < queryTexts.length; i += 100) {
    const batch = queryTexts.slice(i, i + 100);
    const out = await embed(batch);
    embeddings.push(...out);
    process.stderr.write(`  embedded ${embeddings.length}/${queryTexts.length}\n`);
  }

  // Per-query metrics
  let totalGold = 0;
  let foundAtTop10 = 0;
  let foundAtTop30 = 0;
  let foundAtTop100 = 0;
  let queryRR_10 = 0; // sum of per-query RR at top-10
  let queryRR_30 = 0;
  let queryRR_100 = 0;
  let zeroAt10 = 0;
  let zeroAt30 = 0;
  let zeroAt100 = 0;

  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i]!;
    const vec = `[${embeddings[i]!.join(",")}]`;

    // BM25 top-100, semantic top-100, RRF
    const [bm25, sem] = await Promise.all([
      sql.unsafe<Array<{ id: string }>>(
        `SELECT id FROM ${T}
         ORDER BY content <@> to_bm25query($1, '${T}_content_bm25_idx')
         LIMIT 100`,
        [ex.query],
      ),
      sql.unsafe<Array<{ id: string }>>(
        `SELECT id FROM ${T}
         WHERE embedding IS NOT NULL AND (embedding <=> $1::halfvec) < 1.0
         ORDER BY (embedding <=> $1::halfvec) ASC
         LIMIT 100`,
        [vec],
      ),
    ]);
    const scores = new Map<string, number>();
    bm25.forEach((r, j) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (RRF_K + j + 1)));
    sem.forEach((r, j) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (RRF_K + j + 1)));
    const fused = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id);

    const top10 = new Set(fused.slice(0, 10));
    const top30 = new Set(fused.slice(0, 30));
    const top100 = new Set(fused.slice(0, 100));
    const goldSet = new Set(ex.gold_ids);

    let g10 = 0, g30 = 0, g100 = 0;
    for (const g of goldSet) {
      totalGold++;
      if (top10.has(g)) { foundAtTop10++; g10++; }
      if (top30.has(g)) { foundAtTop30++; g30++; }
      if (top100.has(g)) { foundAtTop100++; g100++; }
    }
    const n = goldSet.size;
    queryRR_10 += n > 0 ? g10 / n : 0;
    queryRR_30 += n > 0 ? g30 / n : 0;
    queryRR_100 += n > 0 ? g100 / n : 0;
    if (n > 0 && g10 === 0) zeroAt10++;
    if (n > 0 && g30 === 0) zeroAt30++;
    if (n > 0 && g100 === 0) zeroAt100++;
  }

  const N = examples.length;
  console.log(`\n=== Robotics raw-query retrieval baseline ===`);
  console.log(`N=${N} queries, ${totalGold} total gold IDs`);
  console.log();
  console.log(`per-query mean retrieval recall:`);
  console.log(`  @10:  ${(queryRR_10 / N).toFixed(3)}`);
  console.log(`  @30:  ${(queryRR_30 / N).toFixed(3)}`);
  console.log(`  @100: ${(queryRR_100 / N).toFixed(3)}`);
  console.log();
  console.log(`gold-coverage rate (gold found / total gold):`);
  console.log(`  @10:  ${(foundAtTop10 / totalGold).toFixed(3)}`);
  console.log(`  @30:  ${(foundAtTop30 / totalGold).toFixed(3)}`);
  console.log(`  @100: ${(foundAtTop100 / totalGold).toFixed(3)}`);
  console.log();
  console.log(`zero-gold queries (no gold in top-K):`);
  console.log(`  @10:  ${zeroAt10}/${N}`);
  console.log(`  @30:  ${zeroAt30}/${N}`);
  console.log(`  @100: ${zeroAt100}/${N}`);
  console.log();
  console.log(`agent baseline for comparison:`);
  console.log(`  agent retrieval recall @ K-merged-tool-calls: 0.527 (sonnet+opus mix)`);
  console.log(`  agent ranking recall @ top-10: 0.480`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
