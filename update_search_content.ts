// H3 step 2: populate bright_aops.search_content with content + pseudo_queries.
// Only tagged docs (meta.pseudo_queries present) get augmented; others stay
// as content. Run after tag_pseudo_queries.ts finishes.

import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  // Count how many docs have pseudo_queries
  const [before] = await sql.unsafe(`
    SELECT count(*)::int as c FROM bright_aops WHERE meta ? 'pseudo_queries'
  `);
  console.log(`docs with pseudo_queries: ${before.c}`);

  const t0 = Date.now();
  const res = await sql.unsafe(`
    UPDATE bright_aops
    SET search_content = content || E'\n\nRelated questions:\n' ||
        (SELECT string_agg(q, E'\n') FROM jsonb_array_elements_text(meta->'pseudo_queries') AS q)
    WHERE meta ? 'pseudo_queries'
      AND (meta->'pseudo_queries')::text <> '[]'
  `);
  console.log(`updated ${(res as any).count ?? "?"} rows in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // Sanity: show a sample
  const [sample] = await sql.unsafe(`
    SELECT id, length(content) AS c_len, length(search_content) AS s_len
    FROM bright_aops
    WHERE meta ? 'pseudo_queries' AND (meta->'pseudo_queries')::text <> '[]'
    LIMIT 3
  `) as any[];
  console.log("sample:", sample);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
