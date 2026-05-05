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
import { TABLE_NAME, brightSourceTree } from "./config.ts";
import { TECHNIQUES_LIST, CATEGORIES_LIST } from "./taxonomy.ts";
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

  // PostgreSQL text rejects NUL bytes (U+0000); strip before COPY.
  const stripNulMusique = (s: string) => s.replace(/\x00/g, "");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const vec = `[${embeddings[i]!.join(",")}]`;
    const esc = (s: string) => stripNulMusique(s).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
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
  tableName: string,
  sql: Sql,
): Promise<void> {
  if (docs.length === 0) return;

  const T = tableName;
  const contents = docs.map((d) => d.content);
  console.log(`  Embedding ${contents.length} documents...`);
  const embeddings = await embedWithCache(contents, embed, EMBEDDING_BATCH_SIZE, EMBEDDING_MODEL);

  // The embedding cache step takes 10-30 min during which the original sql
  // connection sits idle. Tiger Cloud's LB closes idle server sockets, but
  // postgres.js doesn't always notice, so the next query (DROP INDEX) hangs
  // forever silently — event loop drains, process exits 0. Refresh the
  // postgres client now that we have embeddings and need DB-heavy work.
  process.stderr.write(`[ingestBright] ${new Date().toISOString()} closing stale sql client and reopening fresh one for DB-heavy phase\n`);
  try { await sql.end({ timeout: 5 }); } catch {}
  // Re-import postgres lazily because the caller passed in `sql` as Sql<{}>.
  const postgres = (await import("postgres")).default;
  sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {},
    max_lifetime: 0,
    idle_timeout: 20,
    connect_timeout: 30,
  }) as Sql;
  // Sanity-check the new conn before the long DB-heavy phase
  await sql.unsafe(`SELECT 1`);

  // Drop indexes for fast bulk insert
  const dlog = (m: string) => process.stderr.write(`[ingestBright] ${new Date().toISOString()} ${m}\n`);
  dlog(`dropping indexes`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${T}_embedding_hnsw_idx`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${T}_content_bm25_idx`);
  await sql.unsafe(`DROP INDEX IF EXISTS ${T}_tree_gist_idx`);

  // PostgreSQL text type rejects NUL bytes (U+0000); strip them before COPY.
  const stripNul = (s: string) => s.replace(/\x00/g, "");
  const esc = (s: string) => stripNul(s).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");

  // Stream COPY in small batches so a single broken/closed underlying socket
  // only loses one batch's worth of work and we can retry it. Earlier we hit
  // a failure mode where postgres.js's COPY writable silently lost its socket
  // ~10k rows in (no error/close event), causing the event loop to drain and
  // the process to exit cleanly with 0 — losing the whole COPY.
  const BATCH_SIZE = 10_000;
  const MAX_RETRIES = 3;
  console.log(`  Inserting ${docs.length} rows via COPY (${BATCH_SIZE}-row batches)...`);

  async function copyBatch(start: number, end: number): Promise<void> {
    const writable = await sql.unsafe(`COPY ${T} (id, content, tree, embedding) FROM STDIN`).writable();
    let copyErr: any = null;
    writable.on("error", (e: any) => { copyErr = e; });
    try {
      for (let i = start; i < end; i++) {
        if (copyErr) throw copyErr;
        const doc = docs[i]!;
        const vec = `[${embeddings[i]!.join(",")}]`;
        const tree = brightSourceTree(doc.id) ?? "\\N";
        const line = `${esc(doc.id)}\t${esc(doc.content)}\t${tree}\t${vec}\n`;
        const ok = writable.write(line);
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { writable.off("error", onErr); resolve(); };
            const onErr = (e: any) => { writable.off("drain", onDrain); reject(e); };
            writable.once("drain", onDrain);
            writable.once("error", onErr);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        writable.end((err?: any) => err ? reject(err) : resolve());
        writable.once("error", reject);
      });
    } catch (e) {
      try { writable.destroy(); } catch {}
      throw e;
    }
  }

  for (let start = 0; start < docs.length; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, docs.length);
    let attempt = 0;
    for (;;) {
      try {
        await copyBatch(start, end);
        break;
      } catch (e: any) {
        attempt++;
        dlog(`batch ${start}-${end} attempt ${attempt} failed: ${e?.message ?? e}`);
        if (attempt >= MAX_RETRIES) throw new Error(`batch ${start}-${end} failed after ${MAX_RETRIES} attempts: ${e?.message ?? e}`);
        // Some COPY failures leave partial rows in the table. Best-effort cleanup:
        // delete any rows we may have written for this batch's ids before retry.
        try {
          const ids = docs.slice(start, end).map(d => d.id);
          await sql.unsafe(`DELETE FROM ${T} WHERE id = ANY($1::text[])`, [ids]);
          dlog(`cleaned ${ids.length} ids before retry`);
        } catch (e2: any) {
          dlog(`cleanup before retry failed (continuing): ${e2?.message ?? e2}`);
        }
      }
    }
    process.stdout.write(`  Progress: ${end}/${docs.length}\n`);
  }
  dlog(`all ${docs.length} rows COPY-loaded`);

  // Recreate indexes
  console.log(`  Recreating indexes...`);
  console.log(`    HNSW (embedding)...`);
  await sql.unsafe(`
    CREATE INDEX ${T}_embedding_hnsw_idx
      ON ${T} USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  console.log(`    BM25 (content)...`);
  // pg_textsearch's parallel workers fail with "tp_worker_0.0: No such file" on
  // large corpora (~188k+ docs). Disable parallelism for this session.
  await sql.unsafe(`SET max_parallel_maintenance_workers = 0`);
  await sql.unsafe(`
    CREATE INDEX ${T}_content_bm25_idx
      ON ${T} USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  console.log(`    GIST (tree)...`);
  await sql.unsafe(`
    CREATE INDEX ${T}_tree_gist_idx
      ON ${T} USING gist (tree)
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
// AUTORESEARCH: These prompts are modifiable by the research loop.

function buildPromptBrightDefault(query: string): string {
  return `You have access to a search tool to find relevant documents in a corpus of programming language documentation, tutorials, and source code.

Your task: find documents that would help someone solve the problem described in the query below. Think about what CONCEPTS, LANGUAGE FEATURES, and TECHNIQUES are needed — don't just search for keywords from the problem statement.

Strategy:
1. First, identify the key concepts needed (e.g., loops, string manipulation, sorting, error handling, data structures)
2. Search for each concept separately — search for tutorials, language features, and documentation about those concepts
3. Also search for related API functions and standard library features
4. Do at least 5-6 searches with different strategies before finalizing

IMPORTANT about grep: grep is a HARD filter — documents that don't contain the literal regex pattern are excluded from BOTH semantic and keyword results. Only use grep when you have a HIGHLY DISTINCTIVE term (a rare API name, a specific function signature, a unique identifier) that you are CONFIDENT must appear verbatim in the answer documents. Do NOT use grep for topic names, common words, or guesses about what the answer "should" mention — this will filter out correct documents that use different phrasing. When in doubt, leave grep empty and rely on semantic + fulltext.

After searching, return a ranked list of exactly 10 document IDs, ordered from most relevant to least relevant.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings, most relevant first. No explanations.

Query: ${query}
Ranked document IDs:`;
}

function buildPromptBrightEconomics(query: string): string {
  return `You have access to a search tool to find articles relevant to the economics question below.

CRITICAL INSIGHT: The most relevant documents often use DIFFERENT vocabulary than the query itself. A question phrased in everyday terms may be answered by articles that use formal academic terminology; a question about one technique may be answered by articles about an adjacent technique that solves the same problem; a question about a specific entity may be answered by articles about the underlying accounting or methodology. Searching only for terms that appear in the query will miss these.

STEP 1 — BRAINSTORM (before any search):
Spend real effort enumerating alternative vocabulary the gold documents might use. Write out the lists BEFORE you start searching. The categories to consider:
(a) Formal / academic terminology for the core concept — what would a textbook or academic paper call this?
(b) Named theorems, models, classic frameworks, or canonical papers that bear on this question
(c) Adjacent or alternative techniques that address the same underlying problem differently — if the query names one technique, what are the siblings?
(d) Prerequisite methodology, accounting standards, or measurement frameworks that the answer depends on — what concept do you need to understand BEFORE you can answer?
(e) Opposite or contrasting concepts, and the broader category they both belong to

STEP 2 — SEARCH broadly using the expanded vocabulary:
Run 8-12 searches covering:
- The query topic as stated
- Each alternative term / framework from the brainstorm
- Adjacent techniques
- Prerequisite methodology articles
Use semantic + fulltext together. Try vocabulary combinations you would not guess from just the query.

STEP 3 — RANK:
After retrieving candidates, rank the 10 most relevant. A document that addresses the underlying concept using different vocabulary is often MORE relevant than a surface-lexical match.

IMPORTANT about grep: grep is a HARD filter — documents that don't contain the literal regex pattern are excluded from BOTH semantic and keyword results. This ESPECIALLY hurts economics queries where gold docs use different vocabulary than the query. Only use grep for highly distinctive literal terms (rare dataset names, specific regulation codes). Do NOT grep for named entities (companies, countries, people, events). When in doubt, leave grep empty.

IMPORTANT: Your final answer must be ONLY a JSON array of exactly 10 document ID strings, most relevant first. No explanations.

Query: ${query}
Ranked document IDs:`;
}

function buildPromptBrightMath(query: string): string {
  return `You have access to a search tool to find documents that help solve the math problem below.

Corpus structure (visible via "tree: <label>" in search results): the corpus blends seven sources, each tagged by a single-label tree label you can filter with treeMatch:
- aops — competition math problems (AMC, AIME, etc.)
- math_test / math_train — worked solutions to textbook-style math problems (the MATH dataset)
- theoremqa — theorem-application questions with solutions
- aqua — short algebra / arithmetic word problems (very short chunks, weak context)
- camel — synthetic math problem-solution pairs, often shallow
- gsm — grade-school math word problems

The aqua, camel, and gsm chunks are typically too elementary or too synthetic to help with a serious competition-level problem. They dominate the corpus by volume but are rarely the most relevant source. When your query is at a comparable level to AMC/AIME/theorem-application, focus search on aops, math_test, math_train, theoremqa.

The useful sources (aops / math_test / math_train / theoremqa) also carry pre-computed metadata tags on each chunk — visible in results as "cat: <category>, tech: [tag1,tag2,...]". You can filter by these with the techniquesAny and categoryAny parameters.

Canonical technique tags: ${TECHNIQUES_LIST}. Categories: ${CATEGORIES_LIST}.

Strategy:
1. Identify the mathematical techniques the problem requires (e.g. "Vieta's formulas", "Newton's identities", "polynomial roots", "modular arithmetic"). Search for each technique by name (semantic + fulltext together).
2. Search for problem structure (e.g. "polynomial whose roots are...", "triangle with integer side lengths"). The MATH dataset chunks often phrase problems similarly.
3. HYPOTHETICAL SIBLING PROBLEM: imagine a DIFFERENT math problem that would use the SAME techniques as this query — with different concrete objects and numbers but the same underlying structure. Write a short (~3-sentence) problem statement for this hypothetical sibling, then pass it as the "semantic" parameter (leave fulltext empty). Gold for a query is often a real sibling problem, and sibling problems embed closer to each other than either does to abstract technique names. Do 2-3 hypothetical-sibling searches covering varied concrete setups.
4. TAG-BASED RETRIEVAL: once you've identified the techniques this problem uses (step 1), try one search with techniquesAny set to those canonical tags (e.g. techniquesAny = ["frobenius_number","diophantine_equations"]). This pulls every chunk in the corpus whose meta.techniques overlaps — a deterministic way to find sibling problems sharing the same concept, even when embedding similarity misses them. Be specific: use "frobenius_number" rather than generic "diophantine_equations" when Frobenius reasoning applies; use "newtons_identities" rather than "polynomial_roots" when Newton's is the key technique.
5. Use treeMatch to restrict noisy sources. The lquery syntax to restrict to the four useful sources is exactly: treeMatch = "aops|math_test|math_train|theoremqa" (pipe-separated single-position alternation — do NOT use curly braces or dots in labels; both are syntax errors). Start without treeMatch to see what surfaces; add it on follow-ups when aqua/camel/gsm dominates.
6. Do at least 6-9 searches total, roughly split across: technique names (step 1), problem structure (step 2), hypothetical siblings (step 3), and 1-2 tag-filtered searches (step 4).

IMPORTANT about grep: grep is a HARD filter — documents that don't contain the literal regex pattern are excluded from BOTH semantic and keyword results. Only use grep for highly distinctive literal terms you're confident must appear verbatim. Default empty.

After searching, return a ranked list of exactly 10 document IDs, most relevant first.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings. No explanations.

Query: ${query}
Ranked document IDs:`;
}

function buildPromptBrightPony(query: string): string {
  return `You have access to a search tool to find documents that help solve a programming problem in the Pony language. The corpus contains the Pony language tutorial and reference docs — chapter-style primers (e.g. "1_variables", "2_primitives", "4_control-structures", "5_methods") plus standard-library reference (e.g. "builtin-String", "src-builtin-string-..."), a few thousand docs total.

CRITICAL — what "gold" looks like in this benchmark:
The gold documents are NOT the answer code, NOT the specific function that solves your problem, and NOT the implementation source. Gold is what a teacher would cite to TEACH the relevant concept — typically a primer/tutorial chapter explaining the underlying feature. For a "how do I repeat a string" query, gold is the chapter on "methods" or "primitives", not a string-multiply implementation. For a "how do I loop until X" query, gold is the chapter on "control structures", not a specific while-loop snippet.

CRITICAL — match the corpus's phrasing, not your own knowledge:
You may already know Pony syntax. Do NOT search for specific identifiers you remember (USize, mul, repeat_str, recover, iso, consume, etc.) — those will pull up implementation docs and miss the primer chapters. Instead, search for the BROAD CONCEPT a learner would type. If you catch yourself typing a syntax keyword from memory, stop and rephrase as a topic phrase ("loops", "string handling", "methods on objects").

Strategy:
1. CALIBRATE: Run 1-2 broad exploratory searches first ("Pony tutorial introduction", "Pony language overview") and look at the result IDs. Notice the chapter/file naming pattern (e.g. "N_topic_M.txt"). Pick searches that match that level.
2. Decompose the problem into 2-4 concept TOPIC AREAS (e.g. "string operations", "loops/iteration", "methods", "type system", "variables"). Search each topic by name — the natural-language phrasing a learner would use, not the syntax names a Pony expert would use.
3. Aim for 5-8 broad concept searches, not narrow ones. A search that returns ONLY src-builtin-* implementation docs probably needs to be re-phrased toward the tutorial level.
4. Rank highest the chapter-style primers (numbered tutorial files), then standard-library reference, then implementation source.

IMPORTANT about grep: grep is a HARD filter. Default empty.

After searching, return exactly 10 document IDs, most relevant first.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings. No explanations.

Query: ${query}
Ranked document IDs:`;
}

function buildPromptBrightLeetcode(query: string): string {
  return `You have access to a search tool to find documents in a corpus of LeetCode problem statements. Each doc is a complete LeetCode problem with its title, description, examples, and constraints.

CRITICAL — what "gold" looks like in this benchmark:
For a LeetCode query, gold is OTHER LeetCode problem statements that share the same algorithmic pattern. Gold is a SIBLING PROBLEM, not the answer to the query. Two problems sharing the same algorithm (sliding window, monotonic stack, two-pointer, dynamic programming on intervals, BFS on graph, prefix sums, etc.) ARE good matches even when their problem scenarios are completely different (one is about elevation maps, the other about points on a line). Two problems sharing surface words (same data type, same operation names) but using different algorithms are NOT good matches.

CRITICAL — don't search for the algorithm; search for the problem:
You may already recognize the algorithmic pattern needed to solve the query (DP, BFS, two-pointer, etc.). Do NOT search for that algorithm name. Searching for "dynamic programming on subsets" or "monotonic stack" or "GCD slope calculation" returns implementation discussions and algorithm explanations — but those are NOT the corpus. The corpus has problem statements only. Instead, search the way another LeetCode problem would BE PHRASED: in terms of the input/output (arrays, strings, intervals, graphs) and the question being asked (count, maximum, find pattern, etc.).

CRITICAL — don't try to solve and find the answer:
Your job is NOT to figure out the solution and then find a doc with that solution. The corpus doesn't contain solutions. Your job is to find SIBLING PROBLEMS that would teach the same algorithmic pattern. Resist the urge to search for "how to implement X" or "solution to problem Y".

Strategy:
1. CALIBRATE: do 1-2 broad searches first using problem-statement language ("array of integers", "trap rainwater", "maximum subarray") and look at result IDs. Confirm you're seeing leetcode/leetcode_NNNN.txt entries (problem statements), not external docs.
2. Decompose the query into 2-4 PROBLEM-PHRASING terms — what's the input shape, what's being asked, what's the constraint. Examples:
   - Input shape: "array of integers", "string s", "binary tree", "list of intervals", "graph with N nodes"
   - Question type: "find maximum / minimum", "count number of X", "return all valid Y", "rearrange so that"
   - Constraint: "non-decreasing", "with target sum", "such that no two adjacent"
3. Run 5-8 searches mixing input-shape, question-type, constraint phrasing. AVOID typing algorithm names from your training (no "sliding window", "monotonic queue", "two pointers", "binary search", etc.). Those phrases pull up tutorials and miss sibling problems.
4. If a search returns mostly implementation/tutorial docs (non leetcode_NNNN ids), the search was too algorithmic — rephrase as problem-statement language.

IMPORTANT about grep: grep is a HARD filter. Default empty.

Ranking: highest priority for leetcode_NNNN.txt sibling problems whose stated input/output and question type closely match the query.

After searching, return exactly 10 document IDs, most relevant first.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings. No explanations.

Query: ${query}
Ranked document IDs:`;
}

export function buildPromptBright(query: string, domain: string): string {
  if (domain === "economics") return buildPromptBrightEconomics(query);
  if (domain === "aops" || domain === "theoremqa_questions") return buildPromptBrightMath(query);
  if (domain === "pony") return buildPromptBrightPony(query);
  if (domain === "leetcode") return buildPromptBrightLeetcode(query);
  return buildPromptBrightDefault(query);
}
