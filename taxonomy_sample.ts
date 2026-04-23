// Sample chunks from bright_aops and extract free-form technique tags.
// Aggregate to discover the actual taxonomy (rather than guessing).
import postgres from "postgres";

const TAG_MODEL = "gpt-4o-mini"; // cheap, fast, good enough for tag extraction
const SAMPLE_SPEC = [
  // { source, count } - stratified
  { tree: "aops", n: 62 },           // all aops (tiny)
  { tree: "math_train", n: 100 },
  { tree: "math_test", n: 60 },
  { tree: "theoremqa", n: 100 },
  { tree: "aqua", n: 40 },
  { tree: "camel", n: 40 },
  { tree: "gsm", n: 40 },
];

const CONCURRENCY = 20;

const SYSTEM_PROMPT = `You tag mathematical text chunks. Return strictly valid JSON, nothing else.`;

const USER_PROMPT = (content: string) => `Read this math chunk and extract tags.

Output JSON exactly in this shape:
{
  "is_math": boolean,
  "kind": "problem" | "solution" | "theorem" | "explainer" | "mixed" | "other",
  "techniques": string[],   // 0-5 tags naming the MATHEMATICAL TECHNIQUES used
                            // (e.g. "vieta_formulas", "frobenius_number",
                            //  "modular_arithmetic", "pigeonhole", etc.)
                            // Free-form but lowercase_with_underscores.
                            // Prefer widely-known canonical names.
  "setup_tags": string[],   // 0-5 tags describing the CONCRETE SETUP
                            // (e.g. "polynomial_roots", "bricks_stacking",
                            //  "prime_pairs"). lowercase_with_underscores.
}

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

async function tagChunk(content: string): Promise<any> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TAG_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_PROMPT(content) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return JSON.parse(data.choices[0].message.content);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  // Sample chunks
  const samples: Array<{ id: string; content: string; tree: string }> = [];
  for (const spec of SAMPLE_SPEC) {
    const rows = await sql.unsafe(
      `SELECT id, content, tree::text as tree FROM bright_aops WHERE tree::text = $1 ORDER BY random() LIMIT $2`,
      [spec.tree, spec.n],
    );
    samples.push(...(rows as any[]));
    console.log(`sampled ${rows.length} from ${spec.tree}`);
  }
  console.log(`total samples: ${samples.length}`);

  // Tag in parallel batches
  const results: Array<any> = [];
  let done = 0;
  for (let i = 0; i < samples.length; i += CONCURRENCY) {
    const batch = samples.slice(i, i + CONCURRENCY);
    const tagged = await Promise.all(
      batch.map(async (s) => {
        try {
          const t = await tagChunk(s.content);
          return { ...s, ...t };
        } catch (e: any) {
          return { ...s, error: e.message?.slice(0, 60) };
        }
      }),
    );
    results.push(...tagged);
    done += batch.length;
    process.stdout.write(`tagged ${done}/${samples.length}\n`);
  }

  // Aggregate
  const techFreq = new Map<string, number>();
  const setupFreq = new Map<string, number>();
  const kindFreq = new Map<string, number>();
  const techByTree = new Map<string, Map<string, number>>();
  let errs = 0;

  for (const r of results) {
    if (r.error) { errs++; continue; }
    kindFreq.set(r.kind, (kindFreq.get(r.kind) || 0) + 1);
    for (const t of (r.techniques || [])) {
      techFreq.set(t, (techFreq.get(t) || 0) + 1);
      if (!techByTree.has(r.tree)) techByTree.set(r.tree, new Map());
      const m = techByTree.get(r.tree)!;
      m.set(t, (m.get(t) || 0) + 1);
    }
    for (const t of (r.setup_tags || [])) setupFreq.set(t, (setupFreq.get(t) || 0) + 1);
  }

  console.log(`\nErrors: ${errs}/${results.length}`);
  console.log(`\n=== KIND distribution ===`);
  for (const [k, v] of [...kindFreq.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  console.log(`\n=== TECHNIQUE tag frequency (top 40) ===`);
  const techSorted = [...techFreq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of techSorted.slice(0, 40)) console.log(`  ${v.toString().padStart(3)}  ${k}`);

  console.log(`\n=== SETUP tag frequency (top 40) ===`);
  const setupSorted = [...setupFreq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of setupSorted.slice(0, 40)) console.log(`  ${v.toString().padStart(3)}  ${k}`);

  console.log(`\n=== TECHNIQUE by tree (top 8 per tree) ===`);
  for (const [tree, m] of techByTree.entries()) {
    console.log(`  ${tree}:`);
    for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${v}  ${k}`);
    }
  }

  // Save raw tagged samples for inspection
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/taxonomy_samples.json", JSON.stringify(results, null, 2));
  console.log(`\nSaved raw results to /tmp/taxonomy_samples.json`);

  await sql.end({ timeout: 3 });
  process.exit(0);
}

main().catch((e) => { console.error("failed:", e); process.exit(1); });
