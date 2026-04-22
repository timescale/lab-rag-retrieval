// Variant of mcp-server.ts for the aops / theoremqa_questions corpus, which
// blends multiple sources (aqua, camel, gsm, math.test, math.train, theoremqa,
// aops) and has a populated `tree` ltree column. Adds `treeMatch` to the
// search tool and surfaces each result's tree label to the agent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postgres from "postgres";
import { embed } from "./memory.ts";
import { TABLE_NAME } from "./config.ts";

const RRF_K = 60;

const ACTIVE_TABLE = process.env.MCP_TABLE ?? TABLE_NAME;

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const server = new McpServer({
  name: "recall",
  version: "1.0.0",
});

server.tool(
  "me_memory_search",
  `Search memory. Modes: semantic, fulltext, grep. Usually combine semantic + fulltext. WARNING: grep is a HARD AND filter that excludes any document not matching the regex — it applies to BOTH semantic and fulltext results, so overly-specific grep patterns silently filter out correct documents that phrase things differently. Only use grep for highly distinctive literal terms you're confident must appear verbatim (rare API names, unique identifiers). Default to leaving grep empty. Use excludeIds to drop specific document IDs. Use treeMatch to filter by source label (an ltree lquery pattern). This corpus blends multiple source types visible as "tree: <label>" in results — observe the labels to see what's available.`,
  {
    semantic: z.string().nullable().describe("Natural language query for semantic/meaning search"),
    fulltext: z.string().nullable().describe("Keywords/phrases for BM25 exact matching"),
    grep: z.string().nullable().describe("Regex pattern (case-insensitive). HARD AND filter on all other modes — use only for highly distinctive literal terms you KNOW must appear verbatim. Leave empty when unsure."),
    excludeIds: z.array(z.string()).nullable().describe("Document IDs to exclude from results. Filtered out silently across all modes before returning."),
    treeMatch: z.string().nullable().describe("ltree lquery pattern to restrict results by source label (e.g. 'math.*' matches math.train and math.test; '!camel' excludes camel; check the 'tree:' labels in prior results to see available source types)."),
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

    const hasTreeMatch = params.treeMatch && params.treeMatch.length > 0;
    if (hasTreeMatch) {
      filters.push(`tree ~ $${paramIdx}::lquery`);
      filterValues.push(params.treeMatch);
      paramIdx++;
    }

    const hasSemantic = params.semantic && params.semantic.length > 0;
    const hasFulltext = params.fulltext && params.fulltext.length > 0;

    let results: Array<{ id: string; content: string; tree: string | null; score: number }>;

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
        if (hasTreeMatch) {
          semFilters.push(`tree ~ $${semParamIdx}::lquery`);
          semFilterValues.push(params.treeMatch);
          semParamIdx++;
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

      const rows = await sql.unsafe<Array<{ id: string; content: string; tree: string | null }>>(
        `SELECT id, content, tree::text as tree FROM ${ACTIVE_TABLE} WHERE id = ANY($1::text[])`,
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
      if (hasTreeMatch) { clauses.push(`tree ~ $${idx}::lquery`); qparams.push(params.treeMatch); idx++; }
      const extra = clauses.length > 0 ? " AND " + clauses.join(" AND ") : "";
      const rows = await sql.unsafe<Array<{ id: string; content: string; tree: string | null }>>(
        `SELECT id, content, tree::text as tree FROM ${ACTIVE_TABLE}
         WHERE content ~* $1${extra}
         ORDER BY created_at DESC
         LIMIT $2`,
        qparams as any[],
      );
      results = rows.map((r) => ({ ...r, score: 0 }));
    } else {
      return { content: [{ type: "text" as const, text: "No search query provided." }] };
    }

    const lines = results.map((r, i) => {
      const treeLabel = r.tree ? `, tree: ${r.tree}` : "";
      return `${i + 1}. ${r.content} (id: ${r.id}${treeLabel})`;
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
