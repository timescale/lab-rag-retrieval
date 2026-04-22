import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {}, idle_timeout: 0, max_lifetime: 0, connect_timeout: 15,
  });
  console.log(`[${new Date().toISOString()}] BM25 on 413k docs...`);
  const t = Date.now();
  await sql.unsafe(`SET max_parallel_maintenance_workers = 0`);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS bright_leetcode_content_bm25_idx
      ON bright_leetcode USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`[${new Date().toISOString()}] done in ${((Date.now()-t)/1000).toFixed(0)}s`);
  await sql.end({ timeout: 5 });
  process.exit(0);
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
