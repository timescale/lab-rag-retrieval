// H3 step 3: rebuild BM25 index on search_content (swap from content).
// Keeps the embedding HNSW index untouched.

import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  console.log("dropping old BM25 index on content...");
  await sql.unsafe(`DROP INDEX IF EXISTS bright_aops_content_bm25_idx`);

  console.log("creating new BM25 index on search_content (this takes a while)...");
  await sql.unsafe(`SET max_parallel_maintenance_workers = 0`);
  const t0 = Date.now();
  await sql.unsafe(`
    CREATE INDEX bright_aops_search_content_bm25_idx
      ON bright_aops USING bm25 (search_content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`index built in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
