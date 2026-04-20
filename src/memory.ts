// =============================================================================
// AUTORESEARCH: This is the file the agent modifies.
//
// Two main functions to iterate on:
//   ingest()   — how corpus paragraphs become memory rows
//   retrieve() — how questions find relevant context
//
// Everything here (embedding, helpers, constants) is fair game.
// =============================================================================

import { embedWithCache } from "./embed-cache.ts";
import { TABLE_NAME, BRIGHT_TABLE_NAME } from "./config.ts";
import type { Sql, CorpusDoc } from "./types.ts";
import type { BrightDocument } from "./types_bright.ts";

// -- Config ------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 2048;
const RETRIEVAL_LIMIT = 10;
const CANDIDATE_LIMIT = 30;
const RRF_K = 60;
const WEIGHTS = { semantic: 1.0, fulltext: 1.0 };

// -- Embedding ---------------------------------------------------------------

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data.map((item) => item.embedding);
}

// -- Ingestion ---------------------------------------------------------------

/** Convert a 32-char hex hash to UUID format (8-4-4-4-12) */
function hashToUuid(hash: string): string {
  const h = hash.padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function ingest(
  docs: CorpusDoc[],
  sql: Sql,
): Promise<void> {
  const rows = docs.map((doc) => ({
    id: hashToUuid(doc.id),
    content: `[${doc.title}] ${doc.paragraph_text}`,
  }));

  if (rows.length === 0) return;

  // Batch embed (with file-based cache)
  const contents = rows.map((r) => r.content);
  console.log(`  Embedding ${contents.length} paragraphs...`);
  const embeddings = await embedWithCache(contents, embed, EMBEDDING_BATCH_SIZE, EMBEDDING_MODEL);

  // Drop indexes for fast bulk insert
  console.log(`  Dropping indexes for bulk insert...`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${TABLE_NAME}_embedding_hnsw_idx`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${TABLE_NAME}_content_bm25_idx`);

  // COPY for fast bulk insert
  console.log(`  Inserting ${rows.length} rows via COPY...`);
  const writable = await sql.unsafe(`COPY ${TABLE_NAME} (id, content, embedding) FROM STDIN`).writable();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const vec = `[${embeddings[i]!.join(",")}]`;
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    const line = `${row.id}\t${esc(row.content)}\t${vec}\n`;
    if (!writable.write(line)) {
      await new Promise<void>((resolve) => writable.once("drain", resolve));
    }
    if ((i + 1) % 10000 === 0) {
      process.stdout.write(`  Progress: ${i + 1}/${rows.length}\n`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    writable.end(() => resolve());
    writable.on("error", reject);
  });
  process.stdout.write(`  Progress: ${rows.length}/${rows.length}\n`);

  // Recreate indexes
  console.log(`  Recreating indexes...`);
  console.log(`    HNSW (embedding)...`);
  await sql.unsafe(`
    CREATE INDEX ${TABLE_NAME}_embedding_hnsw_idx
      ON ${TABLE_NAME} USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  console.log(`    BM25 (content)...`);
  await sql.unsafe(`
    CREATE INDEX ${TABLE_NAME}_content_bm25_idx
      ON ${TABLE_NAME} USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`  Indexes rebuilt.`);
}

// -- BRIGHT Ingestion --------------------------------------------------------

export async function ingestBright(
  docs: BrightDocument[],
  sql: Sql,
): Promise<void> {
  if (docs.length === 0) return;

  const T = BRIGHT_TABLE_NAME;
  const contents = docs.map((d) => d.content);
  console.log(`  Embedding ${contents.length} documents...`);
  const embeddings = await embedWithCache(contents, embed, EMBEDDING_BATCH_SIZE, EMBEDDING_MODEL);

  // Drop indexes for fast bulk insert
  console.log(`  Dropping indexes for bulk insert...`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${T}_embedding_hnsw_idx`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${T}_content_bm25_idx`);

  // COPY for fast bulk insert
  console.log(`  Inserting ${docs.length} rows via COPY...`);
  const writable = await sql.unsafe(`COPY ${T} (id, content, embedding) FROM STDIN`).writable();

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const vec = `[${embeddings[i]!.join(",")}]`;
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    const line = `${esc(doc.id)}\t${esc(doc.content)}\t${vec}\n`;
    if (!writable.write(line)) {
      await new Promise<void>((resolve) => writable.once("drain", resolve));
    }
    if ((i + 1) % 10000 === 0) {
      process.stdout.write(`  Progress: ${i + 1}/${docs.length}\n`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    writable.end(() => resolve());
    writable.on("error", reject);
  });
  process.stdout.write(`  Progress: ${docs.length}/${docs.length}\n`);

  // Recreate indexes
  console.log(`  Recreating indexes...`);
  console.log(`    HNSW (embedding)...`);
  await sql.unsafe(`
    CREATE INDEX ${T}_embedding_hnsw_idx
      ON ${T} USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  console.log(`    BM25 (content)...`);
  await sql.unsafe(`
    CREATE INDEX ${T}_content_bm25_idx
      ON ${T} USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`  Indexes rebuilt.`);
}

// -- RRF Fusion --------------------------------------------------------------

interface RankedResult {
  id: string;
  score: number;
}

function rrfFusion(
  bm25Results: Array<{ id: string }>,
  semanticResults: Array<{ id: string }>,
  k: number,
  weights: { fulltext: number; semantic: number },
): RankedResult[] {
  const scores = new Map<string, number>();

  bm25Results.forEach((result, index) => {
    const rank = index + 1;
    const score = weights.fulltext / (k + rank);
    scores.set(result.id, (scores.get(result.id) ?? 0) + score);
  });

  semanticResults.forEach((result, index) => {
    const rank = index + 1;
    const score = weights.semantic / (k + rank);
    scores.set(result.id, (scores.get(result.id) ?? 0) + score);
  });

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// -- Retrieval ---------------------------------------------------------------

export async function retrieve(
  question: string,
  sql: Sql,
): Promise<string> {
  const [queryEmbedding] = await embed([question]);
  const vec = `[${queryEmbedding!.join(",")}]`;

  // Run BM25 and semantic search in parallel
  const [bm25Results, semanticResults] = await Promise.all([
    sql.unsafe<Array<{ id: string; content: string; score: number }>>(
      `SELECT id, content,
              -(content <@> to_bm25query($1, '${TABLE_NAME}_content_bm25_idx')) as score
       FROM ${TABLE_NAME}
       ORDER BY content <@> to_bm25query($1, '${TABLE_NAME}_content_bm25_idx')
       LIMIT $2`,
      [question, CANDIDATE_LIMIT],
    ),
    sql.unsafe<Array<{ id: string; content: string; score: number }>>(
      `SELECT id, content,
              (1 - (embedding <=> $1::halfvec)) as score
       FROM ${TABLE_NAME}
       WHERE embedding IS NOT NULL
         AND (embedding <=> $1::halfvec) < 1.0
       ORDER BY score DESC, created_at DESC
       LIMIT $2`,
      [vec, CANDIDATE_LIMIT],
    ),
  ]);

  // Fuse with RRF
  const fused = rrfFusion(bm25Results, semanticResults, RRF_K, WEIGHTS);
  const topIds = fused.slice(0, RETRIEVAL_LIMIT).map((r) => r.id);

  if (topIds.length === 0) return "(no relevant information found)";

  // Fetch full content for top results, preserving RRF rank order
  const rows = await sql.unsafe<Array<{ id: string; content: string }>>(
    `SELECT id, content FROM ${TABLE_NAME} WHERE id = ANY($1::text[])`,
    [topIds],
  );

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const lines = topIds
    .map((id, i) => {
      const row = rowMap.get(id);
      if (!row) return "";
      return `${i + 1}. ${row.content}`;
    })
    .filter((line) => line.length > 3);

  return lines.join("\n");
}

// -- Prompt ------------------------------------------------------------------

export function buildPrompt(
  question: string,
  context: string,
): string {
  // Tool mode: no pre-retrieved context, Claude searches via MCP tools
  if (!context) {
    return `You have access to memory tools containing a corpus of Wikipedia paragraphs. Use me_memory_search to find relevant information, then answer the question. You can use me_memory_get to retrieve a specific memory by ID for more detail. Use as many tool calls as needed.

This is a multi-hop question that requires combining facts from multiple paragraphs. Search for each piece of information separately — the answer to one sub-question may help you formulate the next search.

IMPORTANT: Your final answer must be ONLY a short phrase — no explanations, no reasoning, no markdown. Just the answer itself.

Question: ${question}
Short answer:`;
  }

  // Context mode: pre-retrieved context in prompt
  return `Based on the following retrieved paragraphs from Wikipedia, answer the question. This is a multi-hop question — you may need to combine facts from multiple paragraphs.

Retrieved paragraphs:
${context}

Answer with a short phrase. If the information needed is not present, say "unknown".

IMPORTANT: Your final answer must be ONLY a short phrase — no explanations, no reasoning, no markdown. Just the answer itself.

Question: ${question}
Short answer:`;
}

// -- BRIGHT Prompt -----------------------------------------------------------
// AUTORESEARCH: This prompt is modifiable by the research loop.

export function buildPromptBright(query: string): string {
  return `You have access to a search tool to find relevant documents in a corpus. Use me_memory_search to find documents relevant to the query below.

This query may require reasoning to identify which documents are relevant — the answer may not share obvious keywords with the query. Try multiple search strategies: semantic search, keyword search, and grep patterns.

After searching, return a ranked list of exactly 10 document IDs, ordered from most relevant to least relevant. Use the IDs shown in parentheses in the search results (e.g., "id: some_topic/Document_0.txt").

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings, most relevant first. No explanations.

Query: ${query}
Ranked document IDs:`;
}
