// Ingest BRIGHT documents into the bright_corpus table.
//
// Usage:
//   bun run ingest:bright -- --domain pony          # ingest pony domain
//   bun run ingest:bright -- --domain pony --force   # truncate and re-ingest

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { ingestBright } from "./memory.ts";
import { BRIGHT_TABLE_NAME } from "./config.ts";
import type { BrightDocument } from "./types_bright.ts";

function parseArgs() {
  const args = process.argv.slice(2);
  let domain = "";
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) {
      domain = args[i + 1]!;
      i++;
    } else if (args[i] === "--force") {
      force = true;
    }
  }
  return { domain, force };
}

async function main() {
  const { domain, force } = parseArgs();
  if (!domain) {
    console.error("--domain is required. E.g.: bun run ingest:bright -- --domain pony");
    process.exit(1);
  }

  const docsPath = `data/bright/${domain}/documents.jsonl`;
  console.log(`Loading ${domain} documents from ${docsPath}...`);
  const lines = readFileSync(docsPath, "utf-8").trim().split("\n");
  const docs: BrightDocument[] = lines.map((line) => {
    const raw = JSON.parse(line);
    return { id: raw.id, content: raw.content };
  });
  console.log(`${docs.length} documents loaded`);

  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  // Check existing data
  const [row] = await sql.unsafe(`SELECT count(*)::int as count FROM ${BRIGHT_TABLE_NAME}`);
  if (row!.count > 0) {
    if (!force) {
      console.log(`${BRIGHT_TABLE_NAME} table already has ${row!.count} rows.`);
      console.log("Use --force to truncate and re-ingest.");
      await sql.end();
      return;
    }
  }

  // Truncate and ingest
  console.log(`Truncating ${BRIGHT_TABLE_NAME} table...`);
  await sql.unsafe(`TRUNCATE ${BRIGHT_TABLE_NAME}`);

  const t0 = performance.now();
  await ingestBright(docs, sql);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  const [finalRow] = await sql.unsafe(`SELECT count(*)::int as count FROM ${BRIGHT_TABLE_NAME}`);
  console.log(`\nDone. ${finalRow!.count} documents stored (${elapsed}s)`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
