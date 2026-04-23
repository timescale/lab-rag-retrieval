// Variant of mcp-server.ts for the aops / theoremqa_questions corpus, which
// blends multiple sources (aqua, camel, gsm, math.test, math.train, theoremqa,
// aops) and has a populated `tree` ltree column. Adds `treeMatch` to the
// search tool and surfaces each result's tree label to the agent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import { embed } from "./memory.ts";
import { TABLE_NAME } from "./config.ts";
import { TECHNIQUES_LIST, CATEGORIES_LIST } from "./taxonomy.ts";

const RRF_K = 60;

const ACTIVE_TABLE = process.env.MCP_TABLE ?? TABLE_NAME;

// For BRIGHT eval: a per-query excluded-ids file path. If set, the MCP server
// silently applies `id != ALL(...)` to every search so the agent can never see
// or rank these docs. Used for aops/theoremqa_questions where the excluded
// list is ~9,200 IDs per query (too big to pass through the tool param).
const SILENT_EXCLUDED_IDS: string[] = (() => {
  const path = process.env.MCP_EXCLUDED_IDS_PATH;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "N/A");
})();
const HAS_SILENT_EXCLUSIONS = SILENT_EXCLUDED_IDS.length > 0;

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const server = new McpServer({
  name: "recall",
  version: "1.0.0",
});

server.tool(
  "me_memory_search",
  `Search memory. Modes: semantic, fulltext, grep. Usually combine semantic + fulltext. WARNING: grep is a HARD AND filter that excludes any document not matching the regex — overly-specific grep patterns silently filter out correct documents. Default to leaving grep empty. Use excludeIds to drop specific document IDs. Use treeMatch to filter by source label (lquery pattern). Use techniquesAny / categoryAny to filter by mathematical concept (results have "meta" with techniques + category). The corpus includes pre-computed technique tags on the useful sources (aops / math_test / math_train / theoremqa); aqua/camel/gsm have no meta.`,
  {
    semantic: z.string().nullable().describe("Natural language query for semantic/meaning search"),
    fulltext: z.string().nullable().describe("Keywords/phrases for BM25 exact matching"),
    grep: z.string().nullable().describe("Regex pattern (case-insensitive). HARD AND filter on all other modes — use only for highly distinctive literal terms you KNOW must appear verbatim. Leave empty when unsure."),
    excludeIds: z.array(z.string()).nullable().describe("Document IDs to exclude from results. Filtered out silently across all modes before returning."),
    treeMatch: z.string().nullable().describe("ltree lquery pattern to restrict results by source label (e.g. 'aops|math_train|math_test|theoremqa')."),
    techniquesAny: z.array(z.string()).nullable().describe(`Filter: keep only docs whose meta.techniques array overlaps with any of these tags. Only the useful sources have tags; aqua/camel/gsm rows return nothing if this filter is used. Canonical technique names (lowercase_with_underscores): ${TECHNIQUES_LIST}.`),
    categoryAny: z.array(z.string()).nullable().describe(`Filter: keep only docs whose meta.category is one of these. Only the useful sources have meta; aqua/camel/gsm rows return nothing if this filter is used. Categories: ${CATEGORIES_LIST}.`),
    candidateLimit: z.number().int().min(0).max(1000).describe("Candidates per search mode before RRF fusion (0 = default 30)"),
    limit: z.number().int().min(0).max(1000).describe("Maximum results (0 = default 10)"),
  },
  async (params) => {
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const candidateLimit = params.candidateLimit || 30;
    const limit = params.limit || 10;

    const filters: string[] = [];
    const filterValues: unknown[] = [];
    let paramIdx = 1;

    const hasGrep = params.grep && params.grep.length > 0;
    if (hasGrep) {
      filters.push(`content ~* $${paramIdx}`);
      filterValues.push(params.grep);
      paramIdx++;
    }

    const hasExclude = params.excludeIds && params.excludeIds.length > 0;
    if (hasExclude) {
      filters.push(`id != ALL($${paramIdx}::text[])`);
      filterValues.push(params.excludeIds);
      paramIdx++;
    }

    // Silent per-query exclusion (set via MCP_EXCLUDED_IDS_PATH env var)
    if (HAS_SILENT_EXCLUSIONS) {
      filters.push(`id != ALL($${paramIdx}::text[])`);
      filterValues.push(SILENT_EXCLUDED_IDS);
      paramIdx++;
    }

    const hasTreeMatch = params.treeMatch && params.treeMatch.length > 0;
    if (hasTreeMatch) {
      filters.push(`tree ~ $${paramIdx}::lquery`);
      filterValues.push(params.treeMatch);
      paramIdx++;
    }

    // techniquesAny / categoryAny: explicit OR of `meta @> $n::text::jsonb`
    // so each clause uses the jsonb_path_ops GIN index (planner does BitmapOr).
    // The `::text::jsonb` double-cast is needed because postgres.js wraps
    // string params as JSON string literals when bound as `::jsonb` directly.
    const hasTechniques = params.techniquesAny && params.techniquesAny.length > 0;
    if (hasTechniques) {
      const ors: string[] = [];
      for (const t of params.techniquesAny!) {
        ors.push(`meta @> $${paramIdx}::text::jsonb`);
        filterValues.push(JSON.stringify({ techniques: [t] }));
        paramIdx++;
      }
      filters.push(`(${ors.join(" OR ")})`);
    }

    const hasCategory = params.categoryAny && params.categoryAny.length > 0;
    if (hasCategory) {
      const ors: string[] = [];
      for (const c of params.categoryAny!) {
        ors.push(`meta @> $${paramIdx}::text::jsonb`);
        filterValues.push(JSON.stringify({ category: c }));
        paramIdx++;
      }
      filters.push(`(${ors.join(" OR ")})`);
    }

    const hasSemantic = params.semantic && params.semantic.length > 0;
    const hasFulltext = params.fulltext && params.fulltext.length > 0;

    let results: Array<{ id: string; content: string; tree: string | null; meta: any; score: number }>;

    if (hasSemantic || hasFulltext) {
      const bm25Results: Array<{ id: string }> = [];
      const semanticResults: Array<{ id: string }> = [];

      if (hasFulltext) {
        const tBm25 = performance.now();
        const bm25 = await sql.unsafe<Array<{ id: string }>>(
          `SELECT id FROM ${ACTIVE_TABLE}
           ${filters.length > 0 ? "WHERE " + filters.join(" AND ") : ""}
           ORDER BY content <@> to_bm25query($${paramIdx}, '${ACTIVE_TABLE}_content_bm25_idx')
           LIMIT $${paramIdx + 1}`,
          [...filterValues, params.fulltext, candidateLimit] as any[],
        );
        timings.bm25_ms = Math.round(performance.now() - tBm25);
        bm25Results.push(...bm25);
      }

      if (hasSemantic) {
        const tEmbed = performance.now();
        const [queryEmbedding] = await embed([params.semantic!]);
        timings.embed_ms = Math.round(performance.now() - tEmbed);
        const vec = `[${queryEmbedding!.join(",")}]`;
        const tSem = performance.now();
        const semFilters: string[] = [];
        const semFilterValues: unknown[] = [];
        let semParamIdx = 3;
        if (hasGrep) {
          semFilters.push(`content ~* $${semParamIdx}`);
          semFilterValues.push(params.grep);
          semParamIdx++;
        }
        if (hasExclude) {
          semFilters.push(`id != ALL($${semParamIdx}::text[])`);
          semFilterValues.push(params.excludeIds);
          semParamIdx++;
        }
        if (HAS_SILENT_EXCLUSIONS) {
          semFilters.push(`id != ALL($${semParamIdx}::text[])`);
          semFilterValues.push(SILENT_EXCLUDED_IDS);
          semParamIdx++;
        }
        if (hasTreeMatch) {
          semFilters.push(`tree ~ $${semParamIdx}::lquery`);
          semFilterValues.push(params.treeMatch);
          semParamIdx++;
        }
        if (hasTechniques) {
          const ors: string[] = [];
          for (const t of params.techniquesAny!) {
            ors.push(`meta @> $${semParamIdx}::text::jsonb`);
            semFilterValues.push(JSON.stringify({ techniques: [t] }));
            semParamIdx++;
          }
          semFilters.push(`(${ors.join(" OR ")})`);
        }
        if (hasCategory) {
          const ors: string[] = [];
          for (const c of params.categoryAny!) {
            ors.push(`meta @> $${semParamIdx}::text::jsonb`);
            semFilterValues.push(JSON.stringify({ category: c }));
            semParamIdx++;
          }
          semFilters.push(`(${ors.join(" OR ")})`);
        }
        const semFilterClause = semFilters.length > 0 ? " AND " + semFilters.join(" AND ") : "";
        const sem = await sql.unsafe<Array<{ id: string }>>(
          `SELECT id FROM ${ACTIVE_TABLE}
           WHERE embedding IS NOT NULL
             AND (embedding <=> $1::halfvec) < 1.0${semFilterClause}
           ORDER BY (embedding <=> $1::halfvec) ASC, created_at DESC
           LIMIT $2`,
          [vec, candidateLimit, ...semFilterValues] as any[],
        );
        timings.semantic_ms = Math.round(performance.now() - tSem);
        semanticResults.push(...sem);
      }

      const scores = new Map<string, number>();
      bm25Results.forEach((r, i) => {
        scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (RRF_K + i + 1));
      });
      semanticResults.forEach((r, i) => {
        scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (RRF_K + i + 1));
      });

      const topIds = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, score]) => ({ id, score }));

      if (topIds.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }

      const rows = await sql.unsafe<Array<{ id: string; content: string; tree: string | null; meta: any }>>(
        `SELECT id, content, tree::text as tree, meta FROM ${ACTIVE_TABLE} WHERE id = ANY($1::text[])`,
        [topIds.map((r) => r.id)],
      );

      const rowMap = new Map(rows.map((r) => [r.id, r]));
      results = topIds.map((t) => {
        const row = rowMap.get(t.id);
        if (!row) return null;
        return { ...row, score: t.score };
      }).filter(Boolean) as typeof results;
    } else if (hasGrep) {
      const clauses: string[] = [];
      const qparams: unknown[] = [params.grep, limit];
      let idx = 3;
      if (hasExclude) { clauses.push(`id != ALL($${idx}::text[])`); qparams.push(params.excludeIds); idx++; }
      if (HAS_SILENT_EXCLUSIONS) { clauses.push(`id != ALL($${idx}::text[])`); qparams.push(SILENT_EXCLUDED_IDS); idx++; }
      if (hasTreeMatch) { clauses.push(`tree ~ $${idx}::lquery`); qparams.push(params.treeMatch); idx++; }
      if (hasTechniques) {
        const ors: string[] = [];
        for (const t of params.techniquesAny!) {
          ors.push(`meta @> $${idx}::text::jsonb`);
          qparams.push(JSON.stringify({ techniques: [t] }));
          idx++;
        }
        clauses.push(`(${ors.join(" OR ")})`);
      }
      if (hasCategory) {
        const ors: string[] = [];
        for (const c of params.categoryAny!) {
          ors.push(`meta @> $${idx}::text::jsonb`);
          qparams.push(JSON.stringify({ category: c }));
          idx++;
        }
        clauses.push(`(${ors.join(" OR ")})`);
      }
      const extra = clauses.length > 0 ? " AND " + clauses.join(" AND ") : "";
      const rows = await sql.unsafe<Array<{ id: string; content: string; tree: string | null }>>(
        `SELECT id, content, tree::text as tree, meta FROM ${ACTIVE_TABLE}
         WHERE content ~* $1${extra}
         ORDER BY created_at DESC
         LIMIT $2`,
        qparams as any[],
      ) as any as Array<{ id: string; content: string; tree: string | null; meta: any }>;
      results = rows.map((r) => ({ ...r, score: 0 }));
    } else {
      return { content: [{ type: "text" as const, text: "No search query provided." }] };
    }

    const lines = results.map((r, i) => {
      const treeLabel = r.tree ? `, tree: ${r.tree}` : "";
      const cat = r.meta?.category ? `, cat: ${r.meta.category}` : "";
      const techs = Array.isArray(r.meta?.techniques) && r.meta.techniques.length > 0
        ? `, tech: [${r.meta.techniques.join(",")}]` : "";
      return `${i + 1}. ${r.content} (id: ${r.id}${treeLabel}${cat}${techs})`;
    });

    timings.total_ms = Math.round(performance.now() - t0);
    const timingStr = Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(" ");

    return {
      content: [{
        type: "text" as const,
        text: (lines.length > 0 ? lines.join("\n") : "No results found.") + `\n[timing: ${timingStr}]`,
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
