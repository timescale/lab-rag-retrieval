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
      embedding  halfvec(1536),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const [row] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
  console.log(`Done. ${tableName} table has ${row!.count} rows.`);
}
