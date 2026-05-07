// Step 2 after tag_robotics_sketches_v2.ts: replace the sketch column
// with the v2 sketches, re-embed, rebuild indexes.
//
// v1 sketches stay in meta.sketch for revert. v2 sketches are stored
// in meta.sketch_v2 as a jsonb object {package, purpose, canonical_terms,
// alternatives, sketch}; we use only the assembled `sketch` field for
// indexing.

import postgres from "postgres";
import { embed } from "./src/memory.ts";
import { embedWithCache } from "./src/embed-cache.ts";

const EMBEDDING_BATCH_SIZE = 1024;

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30 });

  console.log("[1/5] Replacing sketch column with v2 sketches...");
  const t0 = Date.now();
  // Set sketch from meta.sketch_v2->>'sketch' for every row that has v2.
  // Use NULLIF to keep sketch NULL for empty strings (so they don't get
  // embedded or BM25-indexed).
  const updated = await sql.unsafe(`
    UPDATE bright_robotics
    SET sketch = NULLIF(meta->'sketch_v2'->>'sketch', ''),
        sketch_embedding = NULL
    WHERE meta ? 'sketch_v2'
  `);
  console.log(`  updated ${(updated as any).count ?? "?"} rows in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  console.log("[2/5] Embedding v2 sketches (with file-cache)...");
  const sketches = await sql.unsafe(`
    SELECT id, sketch FROM bright_robotics
    WHERE sketch IS NOT NULL AND sketch <> '' AND sketch_embedding IS NULL
    ORDER BY id
  `) as any[];
  console.log(`  ${sketches.length} to embed`);
  if (sketches.length > 0) {
    const texts = sketches.map((s) => s.sketch);
    const t1 = Date.now();
    const embeddings = await embedWithCache(texts, embed, EMBEDDING_BATCH_SIZE, "text-embedding-3-small");
    console.log(`  embedded in ${((Date.now()-t1)/1000).toFixed(1)}s`);

    console.log("[3/5] Writing embeddings to DB...");
    const t2 = Date.now();
    let written = 0;
    for (let i = 0; i < sketches.length; i += 500) {
      const batch = sketches.slice(i, i + 500);
      const ids = batch.map((s) => s.id);
      const vecs = batch.map((_, j) => `[${embeddings[i+j]!.join(",")}]`);
      await sql.unsafe(
        `UPDATE bright_robotics AS b
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
  await sql.unsafe(`DROP INDEX IF EXISTS bright_robotics_sketch_bm25_idx`);
  await sql.unsafe(`
    CREATE INDEX bright_robotics_sketch_bm25_idx
      ON bright_robotics USING bm25 (sketch)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`  built in ${((Date.now()-t3)/1000).toFixed(1)}s`);

  console.log("[5/5] Rebuilding HNSW (sketch_embedding)...");
  const t4 = Date.now();
  await sql.unsafe(`DROP INDEX IF EXISTS bright_robotics_sketch_embedding_hnsw_idx`);
  await sql.unsafe(`
    CREATE INDEX bright_robotics_sketch_embedding_hnsw_idx
      ON bright_robotics USING hnsw (sketch_embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  console.log(`  built in ${((Date.now()-t4)/1000).toFixed(1)}s`);

  // Quick stats to confirm v2 sketches are in place
  const stats = await sql.unsafe(`
    SELECT
      count(*) FILTER (WHERE meta ? 'sketch_v2') as has_v2,
      count(*) FILTER (WHERE sketch IS NOT NULL AND sketch <> '') as nonempty_sketch,
      count(*) FILTER (WHERE sketch_embedding IS NOT NULL) as has_emb
    FROM bright_robotics
  `) as any[];
  console.log(`stats: has_v2=${stats[0].has_v2} nonempty_sketch=${stats[0].nonempty_sketch} has_emb=${stats[0].has_emb}`);

  console.log("All done.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
