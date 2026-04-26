import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postgres from "postgres";
import { embed } from "./memory.ts";
import { TABLE_NAME } from "./config.ts";

const RRF_K = 60;

// Allow overriding the table name via env var (e.g., for BRIGHT benchmark)
const ACTIVE_TABLE = process.env.MCP_TABLE ?? TABLE_NAME;

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const server = new McpServer({
  name: "recall",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// me_memory_search
// ---------------------------------------------------------------------------

server.tool(
  "me_memory_search",
  `Search memory. Modes: semantic, fulltext, grep. Usually combine semantic + fulltext. WARNING: grep is a HARD AND filter that excludes any document not matching the regex — it applies to BOTH semantic and fulltext results, so overly-specific grep patterns silently filter out correct documents that phrase things differently. Only use grep for highly distinctive literal terms you're confident must appear verbatim (rare API names, unique identifiers). Default to leaving grep empty.`,
  {
    semantic: z.string().nullable().describe("Natural language query for semantic/meaning search"),
    fulltext: z.string().nullable().describe("Keywords/phrases for BM25 exact matching"),
    grep: z.string().nullable().describe("Regex pattern (case-insensitive). HARD AND filter on all other modes — use only for highly distinctive literal terms you KNOW must appear verbatim. Leave empty when unsure."),
    candidateLimit: z.number().int().min(0).max(1000).describe("Candidates per search mode before RRF fusion (0 = default 30)"),
    limit: z.number().int().min(0).max(1000).describe("Maximum results (0 = default 10)"),
  },
  async (params) => {
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const candidateLimit = params.candidateLimit || 30;
    const limit = params.limit || 10;

    // Grep acts as an additional filter
    const filters: string[] = [];
    const filterValues: unknown[] = [];
    let paramIdx = 1;

    const hasGrep = params.grep && params.grep.length > 0;
    if (hasGrep) {
      filters.push(`content ~* $${paramIdx}`);
      filterValues.push(params.grep);
      paramIdx++;
    }

    const filterClause = filters.length > 0 ? " AND " + filters.join(" AND ") : "";

    const hasSemantic = params.semantic && params.semantic.length > 0;
    const hasFulltext = params.fulltext && params.fulltext.length > 0;

    let results: Array<{ id: string; content: string; score: number }>;

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
        // Build semantic filter clause with param indices offset by 2 (after $1=vec, $2=limit)
        const semFilters = [];
        const semFilterValues: unknown[] = [];
        let semParamIdx = 3;
        if (hasGrep) {
          semFilters.push(`content ~* $${semParamIdx}`);
          semFilterValues.push(params.grep);
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

      // RRF fusion
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

      const rows = await sql.unsafe<Array<{ id: string; content: string }>>(
        `SELECT id, content FROM ${ACTIVE_TABLE} WHERE id = ANY($1::text[])`,
        [topIds.map((r) => r.id)],
      );

      const rowMap = new Map(rows.map((r) => [r.id, r]));
      results = topIds.map((t) => {
        const row = rowMap.get(t.id);
        if (!row) return null;
        return { ...row, score: t.score };
      }).filter(Boolean) as typeof results;
    } else if (hasGrep) {
      const rows = await sql.unsafe<Array<{ id: string; content: string }>>(
        `SELECT id, content FROM ${ACTIVE_TABLE}
         WHERE content ~* $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [params.grep, limit] as any[],
      );
      results = rows.map((r) => ({ ...r, score: 0 }));
    } else {
      return { content: [{ type: "text" as const, text: "No search query provided." }] };
    }

    // Format as concise lines: content + id
    const lines = results.map((r, i) => {
      return `${i + 1}. ${r.content} (id: ${r.id})`;
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
