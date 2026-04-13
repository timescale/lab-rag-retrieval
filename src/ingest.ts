// Ingest the 139k IRCoT corpus into the memory table.
//
// Run this after `bun run setup` and whenever you change ingestion in memory.ts.
// Usage: bun run ingest

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { ingest } from "./memory.ts";
import type { CorpusDoc } from "./types.ts";

const CORPUS_PATH = "data/corpus.jsonl";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  // Load corpus
  console.log("Loading corpus...");
  const lines = readFileSync(CORPUS_PATH, "utf-8").trim().split("\n");
  const docs: CorpusDoc[] = lines.map((line) => JSON.parse(line));
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
