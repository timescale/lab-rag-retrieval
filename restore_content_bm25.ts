import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
console.log("creating BM25 index on content (keeping search_content index too)...");
await sql.unsafe(`SET max_parallel_maintenance_workers = 0`);
const t0 = Date.now();
await sql.unsafe(`
  CREATE INDEX IF NOT EXISTS bright_aops_content_bm25_idx
    ON bright_aops USING bm25 (content)
    WITH (text_config = 'english', k1 = 1.2, b = 0.75)
`);
console.log(`done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
await sql.end();
