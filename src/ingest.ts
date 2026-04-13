// Ingest the 139k IRCoT corpus into the memory table.
//
// Run this after `bun run setup` and whenever you change ingestion in memory.ts.
// Usage: bun run ingest

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { ingest } from "./memory.ts";
import type { CorpusDoc } from "./types.ts";

const CORPUS_PATH = "data/corpus.jsonl";
const DEV_PATH = "data/dev.jsonl";
const QUICK_QUESTION_COUNT = 100; // cover eval:quick's 20 plus headroom

function loadQuickCorpus(): CorpusDoc[] {
  // Load the paragraph IDs referenced by the first N dev questions
  const devLines = readFileSync(DEV_PATH, "utf-8").trim().split("\n");
  const questions = devLines.slice(0, QUICK_QUESTION_COUNT).map((l) => JSON.parse(l));
  const neededIds = new Set<string>();
  for (const q of questions) {
    for (const p of q.paragraphs as Array<{ title: string; paragraph_text: string }>) {
      // Reconstruct the content hash the same way prepare.ts does
      const { createHash } = require("node:crypto");
      const hash = createHash("blake2b256")
        .update(`${p.title}\n${p.paragraph_text}`)
        .digest("hex")
        .slice(0, 32);
      neededIds.add(hash);
    }
  }

  // Load full corpus, keep only the paragraphs referenced by those questions
  const lines = readFileSync(CORPUS_PATH, "utf-8").trim().split("\n");
  const docs: CorpusDoc[] = lines
    .map((line) => JSON.parse(line))
    .filter((doc: CorpusDoc) => neededIds.has(doc.id));

  return docs;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const quick = process.argv.includes("--quick");

  // Load corpus
  console.log(quick ? "Loading quick corpus (subset)..." : "Loading corpus...");
  let docs: CorpusDoc[];
  if (quick) {
    docs = loadQuickCorpus();
  } else {
    const lines = readFileSync(CORPUS_PATH, "utf-8").trim().split("\n");
    docs = lines.map((line) => JSON.parse(line));
  }
  console.log(`${docs.length} paragraphs loaded`);

  // Check if corpus is already ingested
  const [row] = await sql`SELECT count(*)::int as count FROM memory`;
  if (row!.count > 0) {
    const force = process.argv.includes("--force");
    if (!force) {
      console.log(`Memory table already has ${row!.count} rows.`);
      console.log("Use --force to truncate and re-ingest.");
      await sql.end();
      return;
    }
  }

  // Truncate and ingest
  console.log("Truncating memory table...");
  await sql`TRUNCATE memory`;

  const t0 = performance.now();
  await ingest(docs, sql);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  const [finalRow] = await sql`SELECT count(*)::int as count FROM memory`;
  console.log(`\nDone. ${finalRow!.count} memories stored (${elapsed}s)`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
