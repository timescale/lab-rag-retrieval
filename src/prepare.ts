import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";

const GDRIVE_FILE_ID = "1tGdADlNjWFaHLeZZGShh2IRcpO6Lv24h";
const ZIP_PATH = "data/musique.zip";
const RAW_DIR = "data/musique";
const CORPUS_PATH = "data/corpus.jsonl";
const DEV_PATH = "data/dev.jsonl";

// ---------------------------------------------------------------------------
// Download MuSiQue dataset from Google Drive
// ---------------------------------------------------------------------------

async function downloadMusique(): Promise<void> {
  console.log("Downloading MuSiQue dataset from Google Drive...");
  mkdirSync("data", { recursive: true });

  // Try curl with confirm=t (bypasses virus scan warning for large files)
  const proc = Bun.spawn(
    [
      "curl", "-L", "-o", ZIP_PATH,
      `https://drive.google.com/uc?export=download&id=${GDRIVE_FILE_ID}&confirm=t`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;

  // Verify we got a valid zip (not an HTML error page)
  if (!existsSync(ZIP_PATH)) {
    throw new Error("Download failed — no file created");
  }
  const header = new Uint8Array(readFileSync(ZIP_PATH).buffer).slice(0, 4);
  if (header[0] !== 0x50 || header[1] !== 0x4B) {
    unlinkSync(ZIP_PATH);
    console.error("\nAutomatic download failed (Google Drive requires browser confirmation).");
    console.error("Please download manually:");
    console.error("  1. Visit: https://drive.google.com/file/d/1tGdADlNjWFaHLeZZGShh2IRcpO6Lv24h/view");
    console.error("  2. Download the zip file");
    console.error(`  3. Place it at: ${ZIP_PATH}`);
    console.error("  4. Re-run: bun run setup");
    process.exit(1);
  }

  // Unzip
  console.log("Extracting...");
  mkdirSync(RAW_DIR, { recursive: true });
  const unzip = Bun.spawn(["unzip", "-o", ZIP_PATH, "-d", RAW_DIR], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await unzip.exited;
  console.log("MuSiQue dataset extracted.");
}

// ---------------------------------------------------------------------------
// Build 139k IRCoT corpus from MuSiQue paragraphs
// ---------------------------------------------------------------------------

interface RawParagraph {
  title: string;
  paragraph_text: string;
}

function contentHash(title: string, text: string): string {
  return createHash("blake2b256")
    .update(`${title}\n${text}`)
    .digest("hex")
    .slice(0, 32);
}

async function buildCorpus(): Promise<void> {
  console.log("Building 139k corpus from MuSiQue paragraphs...");

  // Find all JSONL files in the raw data directory
  const jsonlFiles = [
    "musique_ans_v1.0_train.jsonl",
    "musique_ans_v1.0_dev.jsonl",
    "musique_ans_v1.0_test.jsonl",
    "musique_full_v1.0_train.jsonl",
    "musique_full_v1.0_dev.jsonl",
    "musique_full_v1.0_test.jsonl",
  ];

  const seen = new Map<string, { id: string; title: string; paragraph_text: string }>();

  for (const filename of jsonlFiles) {
    // Try both flat and nested directory structures
    let filepath = `${RAW_DIR}/${filename}`;
    if (!existsSync(filepath)) {
      // Try subdirectory (zip might have a nested folder)
      const dirs = Bun.spawnSync(["ls", RAW_DIR]).stdout.toString().trim().split("\n");
      for (const dir of dirs) {
        const nested = `${RAW_DIR}/${dir}/${filename}`;
        if (existsSync(nested)) {
          filepath = nested;
          break;
        }
      }
    }
    if (!existsSync(filepath)) {
      console.warn(`  Skipping ${filename} (not found)`);
      continue;
    }

    const lines = readFileSync(filepath, "utf-8").trim().split("\n");
    for (const line of lines) {
      const question = JSON.parse(line) as {
        paragraphs: Array<{ title: string; paragraph_text: string }>;
      };
      for (const para of question.paragraphs) {
        const hash = contentHash(para.title, para.paragraph_text);
        if (!seen.has(hash)) {
          seen.set(hash, {
            id: hash,
            title: para.title,
            paragraph_text: para.paragraph_text,
          });
        }
      }
    }
    console.log(`  ${filename}: processed (${seen.size} unique paragraphs so far)`);
  }

  // Write corpus
  const lines = Array.from(seen.values()).map((doc) => JSON.stringify(doc));
  writeFileSync(CORPUS_PATH, lines.join("\n") + "\n");
  console.log(`Corpus: ${seen.size} unique paragraphs saved to ${CORPUS_PATH}`);
}

// ---------------------------------------------------------------------------
// Extract dev questions
// ---------------------------------------------------------------------------

async function extractDevQuestions(): Promise<void> {
  console.log("Extracting dev questions...");

  // Find the ans dev file
  let filepath = `${RAW_DIR}/musique_ans_v1.0_dev.jsonl`;
  if (!existsSync(filepath)) {
    const dirs = Bun.spawnSync(["ls", RAW_DIR]).stdout.toString().trim().split("\n");
    for (const dir of dirs) {
      const nested = `${RAW_DIR}/${dir}/musique_ans_v1.0_dev.jsonl`;
      if (existsSync(nested)) {
        filepath = nested;
        break;
      }
    }
  }
  if (!existsSync(filepath)) {
    console.error("Could not find musique_ans_v1.0_dev.jsonl");
    process.exit(1);
  }

  const lines = readFileSync(filepath, "utf-8").trim().split("\n");
  writeFileSync(DEV_PATH, lines.join("\n") + "\n");
  console.log(`Dev set: ${lines.length} questions saved to ${DEV_PATH}`);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

async function setupDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required. Set it in .env");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { onnotice: () => {} });

  console.log("Creating extensions...");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS ltree");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_textsearch");

  console.log("Creating memory table...");
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content    text NOT NULL,
      meta       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
      tree       ltree NOT NULL DEFAULT '',
      temporal   tstzrange,
      embedding  halfvec(1536),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    )
  `);

  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE memory ADD CONSTRAINT temporal_bounds_convention CHECK (
        temporal IS NULL
        OR (lower(temporal) = upper(temporal) AND lower_inc(temporal) AND upper_inc(temporal))
        OR (lower(temporal) < upper(temporal) AND lower_inc(temporal) AND NOT upper_inc(temporal))
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  console.log("Creating indexes...");
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS memory_embedding_hnsw_idx
      ON memory USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS memory_content_bm25_idx
      ON memory USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  await sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_meta_gin_idx ON memory USING gin (meta)",
  );
  await sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_tree_gist_idx ON memory USING gist (tree)",
  );
  await sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_temporal_gist_idx ON memory USING gist (temporal) WHERE temporal IS NOT NULL",
  );

  const [row] = await sql`SELECT count(*)::int as count FROM memory`;
  console.log(`\nDone. Memory table has ${row!.count} rows.`);

  await sql.end();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("OPENAI_API_KEY is required. Set it in .env");
    process.exit(1);
  }

  // Step 1: Download dataset if needed
  const hasRawData = existsSync(RAW_DIR) &&
    (existsSync(`${RAW_DIR}/musique_ans_v1.0_dev.jsonl`) ||
     Bun.spawnSync(["find", RAW_DIR, "-name", "musique_ans_v1.0_dev.jsonl"]).stdout.toString().trim().length > 0);

  if (!hasRawData) {
    if (existsSync(ZIP_PATH)) {
      console.log("Zip found, extracting...");
      mkdirSync(RAW_DIR, { recursive: true });
      const unzip = Bun.spawn(["unzip", "-o", ZIP_PATH, "-d", RAW_DIR], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await unzip.exited;
    } else {
      await downloadMusique();
    }
  } else {
    console.log("MuSiQue raw data already exists.");
  }

  // Step 2: Build corpus
  if (!existsSync(CORPUS_PATH)) {
    await buildCorpus();
  } else {
    const lineCount = readFileSync(CORPUS_PATH, "utf-8").trim().split("\n").length;
    console.log(`Corpus already exists at ${CORPUS_PATH} (${lineCount} paragraphs)`);
  }

  // Step 3: Extract dev questions
  if (!existsSync(DEV_PATH)) {
    await extractDevQuestions();
  } else {
    const lineCount = readFileSync(DEV_PATH, "utf-8").trim().split("\n").length;
    console.log(`Dev set already exists at ${DEV_PATH} (${lineCount} questions)`);
  }

  // Step 4: Set up database
  await setupDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
