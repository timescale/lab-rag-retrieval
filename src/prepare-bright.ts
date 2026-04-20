// Download BRIGHT dataset from HuggingFace and create the bright_corpus table.
//
// Usage:
//   bun run setup:bright                    # all domains
//   bun run setup:bright -- --domain pony   # single domain

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { BRIGHT_TABLE_NAME, createCorpusTable } from "./config.ts";

const BRIGHT_DOMAINS = [
  "biology", "earth_science", "economics", "psychology", "robotics",
  "stackoverflow", "sustainable_living", "leetcode", "pony", "aops",
  "theoremqa_questions", "theoremqa_theorems",
];

const PYTHON = ".venv/bin/python3";
const PARQUET_SCRIPT = "src/parquet_to_jsonl.py";

function parseArgs() {
  const args = process.argv.slice(2);
  let domain: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) {
      domain = args[i + 1]!;
      i++;
    }
  }
  return { domain };
}

async function ensurePythonDeps(): Promise<void> {
  const check = Bun.spawnSync([PYTHON, "-c", "import pandas; import pyarrow"], {
    stdout: "pipe", stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    console.log("Installing pandas and pyarrow...");
    const install = Bun.spawn([".venv/bin/pip", "install", "pandas", "pyarrow"], {
      stdout: "inherit", stderr: "inherit",
    });
    await install.exited;
  }
}

async function downloadDomain(domain: string): Promise<void> {
  const dir = `data/bright/${domain}`;
  mkdirSync(dir, { recursive: true });

  for (const config of ["examples", "documents"]) {
    const jsonlPath = `${dir}/${config}.jsonl`;
    if (existsSync(jsonlPath)) {
      console.log(`  ${config}.jsonl already exists, skipping`);
      continue;
    }

    console.log(`  Downloading ${config}/${domain}...`);

    // Get parquet file URLs from HuggingFace API
    const apiUrl = `https://huggingface.co/api/datasets/xlangai/BRIGHT/parquet/${config}/${domain}`;
    const res = await fetch(apiUrl);
    if (!res.ok) {
      console.error(`  Failed to fetch parquet URLs: ${res.status} ${await res.text()}`);
      continue;
    }
    const parquetUrls = await res.json() as string[];
    if (!parquetUrls || parquetUrls.length === 0) {
      console.error(`  No parquet files found for ${config}/${domain}`);
      continue;
    }

    // Download each parquet file and convert to JSONL
    const allLines: string[] = [];
    for (const url of parquetUrls) {
      const parquetPath = `${dir}/${config}.parquet`;

      const dlRes = await fetch(url);
      if (!dlRes.ok) {
        console.error(`  Failed to download parquet: ${dlRes.status}`);
        continue;
      }
      const buffer = await dlRes.arrayBuffer();
      writeFileSync(parquetPath, Buffer.from(buffer));

      // Convert to JSONL via Python
      const proc = Bun.spawn([PYTHON, PARQUET_SCRIPT, parquetPath], {
        stdout: "pipe", stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      for (const line of stdout.trim().split("\n")) {
        if (line) allLines.push(line);
      }

      // Clean up parquet
      try { Bun.spawnSync(["rm", parquetPath]); } catch {}
    }

    writeFileSync(jsonlPath, allLines.join("\n") + "\n");
    console.log(`  ${config}: ${allLines.length} rows saved to ${jsonlPath}`);
  }
}

async function main() {
  const { domain } = parseArgs();
  const domains = domain ? [domain] : BRIGHT_DOMAINS;

  if (!domains.every((d) => BRIGHT_DOMAINS.includes(d))) {
    console.error(`Invalid domain. Valid: ${BRIGHT_DOMAINS.join(", ")}`);
    process.exit(1);
  }

  await ensurePythonDeps();

  for (const d of domains) {
    console.log(`\n=== ${d} ===`);
    await downloadDomain(d);
  }

  // Create table
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  await createCorpusTable(sql, BRIGHT_TABLE_NAME);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
