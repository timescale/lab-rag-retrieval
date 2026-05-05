// Ingest BRIGHT documents into a per-domain table (e.g. bright_pony).
//
// Usage:
//   bun run ingest:bright -- --domain pony          # ingest pony domain
//   bun run ingest:bright -- --domain pony --force   # truncate and re-ingest

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { ingestBright } from "./memory.ts";
import { brightTableName } from "./config.ts";
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

  const tableName = brightTableName(domain);
  // Tiger's LB closes idle server sockets, so we let postgres.js close the
  // pool's idle conns and reopen on demand (default idle_timeout). Setting
  // idle_timeout=0 caused stale conns to be reused, hitting CONNECTION_CLOSED
  // on the next write. max_lifetime=0 prevents postgres.js from rotating
  // an actively-streaming connection mid-COPY.
  const sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {},
    max_lifetime: 0,
    idle_timeout: 20,
    connect_timeout: 30,
  });

  // Check existing data
  const [row] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
  if (row!.count > 0) {
    if (!force) {
      console.log(`${tableName} table already has ${row!.count} rows.`);
      console.log("Use --force to truncate and re-ingest.");
      await sql.end();
      return;
    }
  }

  // Truncate and ingest
  console.log(`Truncating ${tableName} table...`);
  await sql.unsafe(`TRUNCATE ${tableName}`);

  const t0 = performance.now();
  await ingestBright(docs, tableName, sql);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  const [finalRow] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
  console.log(`\nDone. ${finalRow!.count} documents stored in ${tableName} (${elapsed}s)`);

  await sql.end();
}

// Diagnostic hooks — last run silently exited mid-COPY with no error logged.
const log = (m: string) => process.stderr.write(`[ingest] ${new Date().toISOString()} ${m}\n`);
process.on("uncaughtException", (e) => { log(`UNCAUGHT EXCEPTION: ${e?.message}\n${e?.stack}`); process.exit(2); });
process.on("unhandledRejection", (e: any) => { log(`UNHANDLED REJECTION: ${e?.message ?? e}\n${e?.stack ?? ""}`); process.exit(3); });
process.on("SIGTERM", () => { log("got SIGTERM"); process.exit(15); });
process.on("SIGINT", () => { log("got SIGINT"); process.exit(2); });
process.on("SIGPIPE", () => { log("got SIGPIPE — likely COPY stream broke"); });
process.on("exit", (code) => { log(`process exit code=${code}`); });
process.on("beforeExit", (code) => { log(`beforeExit code=${code}`); });
log(`pid=${process.pid} starting`);

main().catch((err) => {
  log(`main caught error: ${err?.message ?? err}\n${err?.stack ?? ""}`);
  process.exit(1);
});
