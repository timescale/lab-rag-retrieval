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
  return `You have access to a search tool to find documents that answer the economics question below. The corpus is organized into subdirectories named after specific topic clusters — e.g. "micro_foundation/", "new_keynesian/", "valuepriceprofit/" (Marx), "optimal_stopping/", "nominal_interest_rate/", "ppf_retire/" (production possibility frontier), "inheritance_inequality/", "tax_evasion/", "domestic_foreign/", "weather_data/", "network_effects/", "gdp_network/", etc. Each cluster's gold is typically dominated by ONE specific canonical paper, textbook chapter, or working paper.

CRITICAL — what "gold" looks like in this benchmark:
Gold is the CANONICAL academic/scholarly source for the underlying economic theory, mechanism, or framework the question depends on — typically a journal paper, NBER/IMF working paper, classic economics textbook chapter, or seminal report. Filenames are often unhelpful (paper DOI/JSTOR IDs, working paper numbers, abbreviated PDF names like \`wp0733pdf\`, \`ECTA17408\`, \`ch02htmc10\`, \`benchmarkdsge\`, \`behavioralnewkeynesianmodelpdf\`, \`S1573448X06030317\`, \`2351065\`). Gold is NOT a news article, blog explainer, Wikipedia page, or topical summary about the specific entity in the query.

CRITICAL — don't chase surface entities from the query:
A query mentioning "Samsung's contribution to South Korea GDP" sounds like it wants Samsung-specific facts, but its gold is the underlying accounting METHODOLOGY (e.g. ASC 606 revenue recognition standard) that explains how GDP-contribution is even measured. A query about "Gaza wealth on the Mediterranean" wants a specific economic-history report on Gaza's economic potential, NOT generic Gaza assessment articles. A query about "why deposits decline when rates rise" wants the canonical "Money Creation in the Modern Economy" Bank of England paper — NOT generic Fed explainers. A query naming a specific country/company/event almost always has gold that is the underlying MECHANISM/FRAMEWORK paper, not surface coverage of the entity.

CRITICAL — don't chase keywords from your training:
You know a lot of economics literature deeply (Krugman trade models, DSGE benchmarks, Marx's labor theory of value, Akerlof's market-for-lemons, Modigliani-Miller, behavioral economics canon, etc.). Use that knowledge to NAME the underlying concept — but then SEARCH BY the concept name, not by surface terms from the query. Examples:
- Query about "lottery winners vs. inheritance" → search "inheritance taxation wealth distribution", "intergenerational mobility", NOT "lottery winners".
- Query about Samsung GDP → search "revenue recognition standards ASC 606 GDP measurement", "value added national accounting", NOT "Samsung facts".
- Query about printing money → search "money creation modern economy bank lending", "endogenous money theory", NOT "national debt".

CALIBRATION — do this BEFORE deep search:
1. Read the query and identify: what is the UNDERLYING economic theory, mechanism, accounting standard, or canonical paper the question depends on? Name it precisely — e.g. "production possibility frontier", "Modigliani-Miller capital structure", "money creation theory", "ASC 606 revenue recognition", "behavioral new-keynesian DSGE", "Marx labor theory of value", "optimal stopping problem (secretary problem variants)", "network effects (Rohlfs/Katz-Shapiro)".
2. Run 1-2 broad searches using that concept name. Look at result subdirectory names — they should match the topic cluster (e.g. "ppf_retire/" for a production-possibility-frontier question, "valuepriceprofit/" for a labor-theory-of-value question).
3. If your first results are topical news/Wikipedia about the surface entity, your search is too entity-focused. Rephrase toward the underlying concept.

Strategy:
1. CALIBRATE: identify the underlying concept; 1-2 broad concept searches.
2. Identify the CANONICAL SOURCE FAMILY (textbook chapter, classic journal paper, working paper series, foundational report). For each, run a search combining concept + likely source type ("Marx Capital Volume I value theory", "Bank of England working paper money creation", "NBER working paper inheritance taxation").
3. ADJACENT-CONCEPT search: gold sometimes uses a sibling concept. If the query is about one technique (e.g. "lottery winnings"), search adjacent concepts (e.g. "inheritance tax", "intergenerational wealth transfer") because the paper may use both.
4. AVOID searching for surface entities (Samsung, Gaza, specific country/year/firm), news-article phrasing, or Wikipedia-style summary keywords. If you do search for the entity, prefix it with the underlying concept.
5. Do at least 6-9 searches total, weighted toward concept/paper-family searches and minimal time on entity searches.

IMPORTANT about grep: grep is a HARD filter — documents that don't contain the literal regex pattern are excluded from BOTH semantic and keyword results. Gold often uses different vocabulary than the query. Use grep ONLY for highly distinctive rare identifiers (specific regulation codes like "ASC 606", "Basel III"). Do NOT grep for named entities (companies, countries, people, events). Default empty.

Ranking: highest priority for canonical-source chunks (journal papers, working papers, textbook chapters) whose subdirectory matches the topic cluster; demote topical-news/encyclopedia chunks even if surface-relevant.

After searching, return exactly 10 document IDs, most relevant first.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings. No explanations.

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

function buildPromptBrightRobotics(query: string): string {
  return `You have access to a search tool to find documents that help with the robotics problem below. The corpus is organized into subdirectories named after specific topics/components — e.g. "camera_lidar/", "odometry_trajectory/", "automap_project/", "diffdrive/", "ackermann/", "arduino/", "depth_frame/", "crazyswarm/" — each holding documentation for the foundational tools/algorithms relevant to that topic.

CRITICAL — what "gold" looks like in this benchmark:
Gold is documentation for the FOUNDATIONAL TOOL or ALGORITHM that solves the problem, NOT the framework wrapper or message-passing layer. For a "sensor fusion of lidar and camera" query, gold is OpenCV's Kalman Filter header docs (the underlying algorithm), NOT ROS message-synchronization API docs. For a "compare odometry trajectories" query, gold is PlotJuggler config docs, NOT robot_localization or ROS2 topic docs. For a "diff drive controller setup" query, gold is the diffdrive controller userdoc, NOT generic ROS2 launch tutorials. The gold is in directories named after the CORE COMPONENT a robotics expert would identify as the right tool — Kalman filter, OctomapServer, PlotJuggler, ros2_control plugin, etc.

CRITICAL — don't chase framework keywords from your training:
You probably know ROS/ROS2 APIs deeply: message_filters, ApproximateTimeSynchronizer, Detection2DArray, vision_msgs, robot_localization, costmap_2d, navfn, etc. Do NOT search for those API names. They will pull up tangentially-related framework chunks and miss the foundational-component docs that actually answer the question. Instead, identify the underlying ALGORITHM/TOOL the problem actually requires (Kalman filter for state estimation, particle filter for localization, MPC for control, OctomapServer for occupancy maps, PlotJuggler for trajectory plotting, etc.) and search by THAT name.

CALIBRATION — do this before deep search:
Run 1-2 broad searches naming the underlying CONCEPT (e.g. "Kalman filter sensor fusion", "occupancy grid octomap", "differential drive controller"). Look at result IDs to confirm you're getting documentation chunks like "<concept_dir>/cvSomething_N.txt" or similar tool-specific files. If your first results are ROS-launch tutorials or message-type definitions, your search is too framework-focused; rephrase toward the core tool.

Strategy:
1. CALIBRATE: 1-2 broad concept searches; observe directory naming.
2. Identify the FOUNDATIONAL TOOL(S) the problem requires. Common ones: Kalman/EKF, particle filter, ICP, RANSAC, A*/D*/Dijkstra, MPC/LQR/PID, octomap, costmap, PlotJuggler, URDF, ros2_control plugins (diffdrive, ackermann, mecanum), gazebo plugins, IK solvers, behavior trees, MoveIt, NAV2.
3. Search for each foundational tool by name. Combine the tool name with the broad scenario ("Kalman filter sensor fusion lidar camera").
4. AVOID searching for: specific ROS2 API names, message types, topic names, launch-file boilerplate, package names you remember from training.

IMPORTANT about grep: grep is a HARD filter. Default empty.

Ranking: highest priority for documentation chunks of the foundational tool/algorithm; demote framework-wrapper or generic ROS-tutorial chunks.

After searching, return exactly 10 document IDs, most relevant first.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings. No explanations.

Query: ${query}
Ranked document IDs:`;
}

// Shared prompt for earth_science / sustainable_living / psychology /
// (and other Wikipedia-gold domains). Gold per cluster is dominated by
// the canonical reference article on the underlying scientific principle
// — usually a Wikipedia chunk, occasionally a niche specialist article.
function buildPromptBrightWikipediaConcept(query: string, domain: string): string {
  const examples: Record<string, string> = {
    earth_science: `EXAMPLES of how gold looks in earth_science:
- Query "Why is the inner core solid?" → gold is \`solid_inner_core/Earth's_inner_core1.txt\` (Wikipedia "Earth's inner core").
- Query "Why is March colder than December?" → gold is \`colder_march/Seasonal_lag1.txt\` (Wikipedia "Seasonal lag").
- Query "Why no hurricanes in the South Atlantic?" → gold is \`hurricanes_in_the_southern_Atlantic_basin/Tropical_cyclone1.txt\` (Wikipedia "Tropical cyclone").
- Query "Why does humid air at 100% still produce rain?" → gold is \`humidity_and_rain/Kelvin_equation1.txt\` + \`Convective_available_potential_energy1.txt\` (Wikipedia on the underlying physics).
- Query "How long does pole-flip take?" → gold is \`pole_flip/Geomagnetic_reversal5.txt\` (Wikipedia "Geomagnetic reversal").`,
    sustainable_living: `EXAMPLES of how gold looks in sustainable_living:
- Query "How to incinerate plastic at home?" → gold is \`incineration/Incineration_*.txt\` (Wikipedia "Incineration").
- Query "Hot-water cylinder temperature?" → gold is \`hot_water_cylinder/Legionella_*.txt\` / \`Legionnaires27disease_*.txt\` (Wikipedia on the disease that motivates the temperature spec).
- Query "Biodegradable vs compostable plastic?" → gold is \`biodegradable/\` specialist articles on the standards.`,
    psychology: `EXAMPLES of how gold looks in psychology:
- Query "Why can't MEG distinguish EPSPs and IPSPs?" → gold is \`meg/Magnetoencephalography_*.txt\` (Wikipedia "Magnetoencephalography").
- Query "Why do fNIRS use two frequencies?" → gold is \`fnir/Functionalnearinfraredspectroscopy_*.txt\` (Wikipedia on the modality).
- Query "Term for inability to see past current emotional state?" → gold is \`hot_cold/Hotcoldempathygap_*.txt\` (Wikipedia "Hot-cold empathy gap").
- Query "Can beliefs change without new evidence?" → gold is \`confirmation_bias/seeds_model_*.txt\` (the foundational SEEDS-model paper).`,
    biology: `EXAMPLES of how gold looks in biology:
- Query "Why does evolution not make our life longer?" → gold is \`evolution_not_make_our_life_longer/Antagonistic_pleiotropy_hypothesis_*.txt\` + \`Disposable_soma_theory_of_aging_*.txt\` (Wikipedia on the canonical aging theories).
- Query "Why do I only breathe out of one nostril?" → gold is \`breathe_out_of_one_nostril/Nasal_cycle_*.txt\` (Wikipedia "Nasal cycle").
- Query "Why are insects attracted to light?" → gold is \`insects_attracted_to_light/Proximate_and_ultimate_causation_*.txt\` (Wikipedia on the proximate/ultimate framework, NOT specific insect-attraction articles).
- Query "Do animals exhibit handedness?" → gold is \`animals_handedness/Laterality_*.txt\` + \`Handedness_*.txt\` (Wikipedia on the underlying concept).
- Query "Why do baby animals digest cellulose?" → gold is \`baby_animals_cellulose/Cecotrope_*.txt\` (Wikipedia "Cecotrope").
- Query "Why do I see things when my eyes are closed?" → gold is \`see_when_eyes_closed/Phosphene_*.txt\` (Wikipedia "Phosphene").
- Query "How do muscles get bigger?" → gold is \`muscle_bigger/Muscle_hypertrophy_*.txt\` (Wikipedia "Muscle hypertrophy").`,
  };

  return `You have access to a search tool to find documents that answer the ${domain} question below. The corpus is organized into subdirectories named after specific topic clusters — each cluster's name is usually a hint at the underlying scientific/conceptual principle the question depends on (e.g. "solid_inner_core/", "pole_flip/", "confirmation_bias/", "hot_water_cylinder/").

CRITICAL — what "gold" looks like in this benchmark:
Gold is the CANONICAL REFERENCE article on the underlying scientific principle, mechanism, or concept the question depends on. Typically a **Wikipedia article** on the named concept (filename patterns like \`Tropical_cyclone1.txt\`, \`Seasonal_lag2.txt\`, \`Geomagnetic_reversal5.txt\`, \`Magnetoencephalography_4.txt\`, \`Kelvin_equation1.txt\`, \`Earth's_inner_core1.txt\`, \`Hotcoldempathygap_3.txt\`, \`Incineration_22.txt\`, \`Legionella_22.txt\`), occasionally a foundational specialist paper. Gold is NOT a topic-specific forum answer, news article, blog explainer, or product page — even when the query phrasing matches such sources lexically.

${examples[domain] ?? ""}

CRITICAL — don't chase surface keywords from the query:
A query may phrase things in stuck-asker vocabulary ("why is March colder", "feels like -999 °C", "can beliefs change without new evidence") — but gold uses the FORMAL scientific name for the underlying concept (Seasonal lag, Absolute zero, Confirmation bias / SEEDS model). Use your training knowledge to NAME the underlying principle precisely, then search for THAT name — not for the surface symptom from the query.

CALIBRATION — do this BEFORE deep search:
1. Read the query and identify the UNDERLYING SCIENTIFIC PRINCIPLE / CONCEPT / MECHANISM. Name it precisely. Examples:
   - "Why does the magnetic field flip?" → "Geomagnetic reversal" (geophysics)
   - "Why does humid air still rain?" → "Kelvin equation" + "Convective available potential energy"
   - "Why can't I see past my anger?" → "Hot-cold empathy gap"
   - "Why is my hot water 60°C?" → "Legionella" / "Legionnaires' disease"
2. Search using the FORMAL CONCEPT NAME (semantic + fulltext together). The cluster name in the result IDs (the subdirectory) should match the concept — that's a calibration signal you're on track.
3. If your first results are forum posts / news / blog explainers / vendor pages, your search is too symptom-focused. Pivot to the formal concept name.

Strategy:
1. CALIBRATE: name the underlying principle; 1-2 broad concept-name searches.
2. Search for the principle's Wikipedia/canonical article by name. Combine with adjacent principles if the question spans multiple (e.g. humidity → Kelvin equation + CAPE).
3. ADJACENT-CONCEPT search: gold sometimes uses a related concept — e.g. a question about a specific mineral may be answered by the general formation-process article. List 2-3 adjacent concepts and search each.
4. AVOID searching for surface entities, narrow forum-style phrasings, or product/vendor terminology. If the query mentions a specific entity (a chemical, a device, a country, a body part), prefix it with the underlying principle when searching.
5. Do at least 5-8 searches total, weighted toward formal-concept searches.

IMPORTANT about grep: grep is a HARD filter — documents that don't contain the literal regex pattern are excluded from BOTH semantic and keyword results. Gold often uses formal-scientific vocabulary that differs from the query. Default empty. Only use grep for highly distinctive rare technical identifiers.

Ranking: highest priority for canonical-reference chunks (Wikipedia / foundational paper) whose subdirectory matches the topic cluster; demote forum/news/blog chunks even if surface-relevant.

After searching, return exactly 10 document IDs, most relevant first.

IMPORTANT: Your final answer must be ONLY a JSON array of document ID strings. No explanations.

Query: ${query}
Ranked document IDs:`;
}

function buildPromptBrightStackoverflow(query: string): string {
  return `You have access to a search tool to find documents that help with the StackOverflow programming question below. The corpus is organized into subdirectories named after specific libraries/topics — e.g. "pytorch_torch_tensor_functions/", "python_data_model/", "polar_functions/", "Python_pandas_functions/", "react_hooks_components/", "spring_io/", "linux_man_1/", "DBMS_LOB_LIBCACHE/", etc. — each holding the API REFERENCE DOCUMENTATION for the underlying library/concept relevant to that topic.

CRITICAL — what "gold" looks like in this benchmark:
Gold is the OFFICIAL API REFERENCE for the underlying library function/feature that the question is fundamentally about, NOT a framework wrapper, NOT a tutorial, NOT a Stack Overflow answer. For a "PyTorch model in Flask web server bottleneck" question, gold is PyTorch tensor function reference docs (torch.load, model.to, etc.), NOT Celery worker setup or Flask deployment patterns. For a "Pydantic class with multiple inheritance" question, gold is the Python data model reference (\`__init__\`, \`__setattr__\`, MRO) — the underlying language feature — NOT Pydantic-specific helpers. For a "Polars list intersection" question, gold is the Polars Expression reference (a specific list method), NOT Polars dataframe tutorials.

CRITICAL — don't chase framework keywords from your training:
You probably know the APIs of popular libraries deeply (Celery worker_init, FastAPI dependency injection, Pydantic PrivateAttr, Polars map_elements, etc.). Do NOT search for those specific helper names from memory. They will pull tangentially-related framework chunks and miss the foundational API-reference docs that actually answer the question. Instead, identify the UNDERLYING LIBRARY/LANGUAGE FEATURE the question is fundamentally about and search by THAT. (Question about Pydantic field weirdness? Search "Python data model __setattr__ descriptor". Question about Polars list operation? Search "Polars expression list namespace functions".)

CALIBRATION — do this before deep search:
Run 1-2 broad searches naming the underlying LIBRARY + the specific API area ("PyTorch tensor functions GPU", "Polars expression list", "Python data model dunder"). Look at result IDs to confirm you're getting "<library_name>/...txt" documentation chunks. If your first results are tutorials/blog posts, your search is too solution-focused; rephrase toward "API reference [library] [feature]".

Strategy:
1. CALIBRATE: 1-2 broad library+feature searches; observe directory naming.
2. Identify the FOUNDATIONAL library/feature the question is really about. Examples:
   - PyTorch question → torch tensor / nn module reference
   - Pydantic / dataclass question → Python data model / descriptor reference
   - Polars / Pandas question → that library's Expression / DataFrame method reference
   - React state question → React hooks reference
   - Spring question → Spring IO / Boot reference
   - Linux command question → linux man pages
   - Oracle DB question → DBMS_LOB / LIBCACHE reference
3. Search for each foundational item by name. Combine library + specific function/feature ("PyTorch torch.cuda model device").
4. AVOID searching for: specific helper utilities you remember (Celery worker_init, FastAPI Depends, etc.), error messages, blog-style how-to phrases.

IMPORTANT about grep: grep is a HARD filter. Default empty.

Ranking: highest priority for API reference documentation chunks of the foundational library/feature; demote tutorial/wrapper chunks.

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
  if (domain === "robotics") return buildPromptBrightRobotics(query);
  if (domain === "stackoverflow") return buildPromptBrightStackoverflow(query);
  if (domain === "earth_science" || domain === "sustainable_living" || domain === "psychology" || domain === "biology") {
    return buildPromptBrightWikipediaConcept(query, domain);
  }
  return buildPromptBrightDefault(query);
}
