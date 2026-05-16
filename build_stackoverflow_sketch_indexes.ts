// Step 2 after tag_stackoverflow_sketches.ts: add sketch + sketch_embedding
// columns, populate from meta.sketch_v2->>'sketch', embed via OpenAI, build
// BM25 + HNSW indexes. Mirrors build_robotics_sketch_indexes_v2.ts.

import postgres from "postgres";
import { embed } from "./src/memory.ts";
import { embedWithCache } from "./src/embed-cache.ts";

const EMBEDDING_BATCH_SIZE = 1024;

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30 });

  console.log("[1/5] Adding sketch + sketch_embedding columns if missing...");
  await sql.unsafe(`ALTER TABLE bright_stackoverflow ADD COLUMN IF NOT EXISTS sketch TEXT`);
  await sql.unsafe(`ALTER TABLE bright_stackoverflow ADD COLUMN IF NOT EXISTS sketch_embedding halfvec(1536)`);

  console.log("[2/5] Populating sketch column from meta.sketch_v2->>'sketch'...");
  const t0 = Date.now();
  // NULLIF so empty sketches stay NULL (not embedded, not indexed)
  const updated = await sql.unsafe(`
    UPDATE bright_stackoverflow
    SET sketch = NULLIF(meta->'sketch_v2'->>'sketch', ''),
        sketch_embedding = NULL
    WHERE meta ? 'sketch_v2'
  `);
  console.log(`  populated ${(updated as any).count ?? "?"} rows in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  console.log("[3/5] Embedding sketches (with file-cache)...");
  const sketches = await sql.unsafe(`
    SELECT id, sketch FROM bright_stackoverflow
    WHERE sketch IS NOT NULL AND sketch <> '' AND sketch_embedding IS NULL
    ORDER BY id
  `) as any[];
  console.log(`  ${sketches.length} to embed`);
  if (sketches.length > 0) {
    const texts = sketches.map((s) => s.sketch);
    const t1 = Date.now();
    const embeddings = await embedWithCache(texts, embed, EMBEDDING_BATCH_SIZE, "text-embedding-3-small");
    console.log(`  embedded in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    console.log("  Writing embeddings to DB...");
    const t2 = Date.now();
    let written = 0;
    for (let i = 0; i < sketches.length; i += 500) {
      const batch = sketches.slice(i, i + 500);
      const ids = batch.map((s) => s.id);
      const vecs = batch.map((_, j) => `[${embeddings[i+j]!.join(",")}]`);
      await sql.unsafe(
        `UPDATE bright_stackoverflow AS b
         SET sketch_embedding = v.vec::halfvec
         FROM unnest($1::text[], $2::text[]) AS v(id, vec)
         WHERE b.id = v.id`,
        [ids, vecs] as any[],
      );
      written += batch.length;
      if (written % 5000 === 0) console.log(`    wrote ${written}/${sketches.length}`);
    }
    console.log(`  wrote in ${((Date.now()-t2)/1000).toFixed(1)}s`);
  }

  console.log("[4/5] Rebuilding BM25 (sketch)...");
  await sql.unsafe(`SET max_parallel_maintenance_workers = 0`);
  const t3 = Date.now();
  await sql.unsafe(`DROP INDEX IF EXISTS bright_stackoverflow_sketch_bm25_idx`);
  await sql.unsafe(`
    CREATE INDEX bright_stackoverflow_sketch_bm25_idx
      ON bright_stackoverflow USING bm25 (sketch)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`  built in ${((Date.now()-t3)/1000).toFixed(1)}s`);

  console.log("[5/5] Rebuilding HNSW (sketch_embedding)...");
  const t4 = Date.now();
  await sql.unsafe(`DROP INDEX IF EXISTS bright_stackoverflow_sketch_embedding_hnsw_idx`);
  await sql.unsafe(`
    CREATE INDEX bright_stackoverflow_sketch_embedding_hnsw_idx
      ON bright_stackoverflow USING hnsw (sketch_embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  console.log(`  built in ${((Date.now()-t4)/1000).toFixed(1)}s`);

  const stats = await sql.unsafe(`
    SELECT
      count(*) FILTER (WHERE meta ? 'sketch_v2') as has_v2,
      count(*) FILTER (WHERE sketch IS NOT NULL AND sketch <> '') as nonempty_sketch,
      count(*) FILTER (WHERE sketch_embedding IS NOT NULL) as has_emb
    FROM bright_stackoverflow
  `) as any[];
  console.log(`stats: has_v2=${stats[0].has_v2} nonempty_sketch=${stats[0].nonempty_sketch} has_emb=${stats[0].has_emb}`);

  console.log("All done.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
