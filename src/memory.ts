// =============================================================================
// AUTORESEARCH: This is the file the agent modifies.
//
// Two main functions to iterate on:
//   ingest()   — how corpus paragraphs become memory rows
//   retrieve() — how questions find relevant context
//
// Everything here (embedding, helpers, constants) is fair game.
// =============================================================================

import type { Sql, CorpusDoc } from "./types.ts";

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

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) {
      throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    for (const item of data.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

// -- Ingestion ---------------------------------------------------------------

function slugFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 100);
}

/**
 * Ingest corpus documents into the memory table.
 * Each doc is a single Wikipedia paragraph — no further chunking needed.
 */
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
    meta: {
      title: doc.title,
      corpus_id: doc.id,
    },
    tree: `wiki.${slugFromTitle(doc.title)}`,
  }));

  if (rows.length === 0) return;

  // Batch embed
  const contents = rows.map((r) => r.content);
  console.log(`  Embedding ${contents.length} paragraphs...`);
  const embeddings = await embed(contents);

  // Batch insert
  console.log(`  Inserting ${rows.length} memories...`);
  const BATCH = 100;
  for (let b = 0; b < rows.length; b += BATCH) {
    const end = Math.min(b + BATCH, rows.length);
    await sql.begin(async (tx) => {
      for (let i = b; i < end; i++) {
        const row = rows[i]!;
        const vec = `[${embeddings[i]!.join(",")}]`;
        await tx`
          INSERT INTO memory (id, content, meta, tree, embedding)
          VALUES (
            ${row.id}::uuid,
            ${row.content},
            ${sql.json(row.meta as any)},
            ${row.tree}::ltree,
            ${vec}::halfvec
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }
    });
    if ((b + BATCH) % 5000 < BATCH) {
      process.stdout.write(`  Progress: ${Math.min(b + BATCH, rows.length)}/${rows.length}\n`);
    }
  }
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
              -(content <@> to_bm25query($1, 'memory_content_bm25_idx')) as score
       FROM memory
       WHERE content <@> to_bm25query($1, 'memory_content_bm25_idx') < 0
       ORDER BY score DESC, created_at DESC
       LIMIT $2`,
      [question, CANDIDATE_LIMIT],
    ),
    sql.unsafe<Array<{ id: string; content: string; score: number }>>(
      `SELECT id, content,
              (1 - (embedding <=> $1::halfvec)) as score
       FROM memory
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
    `SELECT id, content FROM memory WHERE id = ANY($1::uuid[])`,
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
