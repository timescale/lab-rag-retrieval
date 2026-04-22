// Build leetcode HNSW + BM25 indexes outside ingestBright to avoid the
// long-connection timeout that killed the previous attempt at ~5h.
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {},
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: 15,
  });

  console.log(`[${new Date().toISOString()}] drop partial indexes`);
  await sql.unsafe(`DROP INDEX IF EXISTS bright_leetcode_embedding_hnsw_idx`);
  await sql.unsafe(`DROP INDEX IF EXISTS bright_leetcode_content_bm25_idx`);

  console.log(`[${new Date().toISOString()}] HNSW on 413k halfvec...`);
  const t1 = Date.now();
  await sql.unsafe(`
    CREATE INDEX bright_leetcode_embedding_hnsw_idx
      ON bright_leetcode USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  console.log(`[${new Date().toISOString()}] HNSW done in ${((Date.now()-t1)/1000).toFixed(0)}s`);

  console.log(`[${new Date().toISOString()}] BM25...`);
  const t2 = Date.now();
  await sql.unsafe(`SET max_parallel_maintenance_workers = 0`);
  await sql.unsafe(`
    CREATE INDEX bright_leetcode_content_bm25_idx
      ON bright_leetcode USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`[${new Date().toISOString()}] BM25 done in ${((Date.now()-t2)/1000).toFixed(0)}s`);

  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
