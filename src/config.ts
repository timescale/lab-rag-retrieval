export const TABLE_NAME = "corpus";

/** Per-domain table name for BRIGHT. Keeps domains isolated. */
export function brightTableName(domain: string): string {
  return `bright_${domain.replace(/[^a-z0-9_]/g, "_")}`;
}

/** Create (or recreate) a corpus table with the standard schema. */
export async function createCorpusTable(sql: any, tableName: string): Promise<void> {
  console.log(`Creating ${tableName} table...`);
  await sql.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
  await sql.unsafe(`
    CREATE TABLE ${tableName} (
      id         text PRIMARY KEY,
      content    text NOT NULL,
      tree       ltree,
      embedding  halfvec(1536),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const [row] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
  console.log(`Done. ${tableName} table has ${row!.count} rows.`);
}

/**
 * Derive an ltree path label from a BRIGHT doc ID.
 * Handles the aops/theoremqa_questions corpus which blends multiple sources
 * (aqua, camel, gsm, math, TheoremQA, aops).
 */
export function brightSourceTree(id: string): string | null {
  // math_test_xxx / math_train_xxx -> math_test / math_train (single label)
  // ltree's `|` alternation only works between single-position labels, so we
  // keep each source on one level to allow patterns like `aops|math_train|...`
  const mathMatch = id.match(/^math_(test|train)_/);
  if (mathMatch) return `math_${mathMatch[1]}`;
  // TheoremQA_xxx -> theoremqa
  if (id.startsWith("TheoremQA_")) return "theoremqa";
  // aops_xxx -> aops
  if (id.startsWith("aops_")) return "aops";
  // camel_xxx -> camel
  if (id.startsWith("camel_")) return "camel";
  // aqua_xxx -> aqua
  if (id.startsWith("aqua_")) return "aqua";
  // gsm_xxx -> gsm
  if (id.startsWith("gsm_")) return "gsm";
  // BRIGHT text corpora use folder/file_N.txt; use the folder as tree.
  // Sanitize: ltree labels only allow alnum and underscore.
  const slashMatch = id.match(/^([^/]+)\//);
  if (slashMatch) {
    const label = slashMatch[1]!.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
    return label || null;
  }
  return null;
}
