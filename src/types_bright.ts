// ---------------------------------------------------------------------------
// BRIGHT benchmark types
// ---------------------------------------------------------------------------

export interface BrightExample {
  id: string;
  query: string;
  reasoning: string;
  gold_ids: string[];
  gold_ids_long: string[];
  excluded_ids: string[];
  gold_answer: string;
}

export interface BrightDocument {
  id: string;
  content: string;
}

export interface BrightQueryResult {
  domain: string;
  queryId: string;
  query: string;
  goldIds: string[];
  retrievedIds: string[];
  ndcg10: number;
  retrievalRecall: number; // gold seen in any tool call / total gold
  rankingRecall: number;   // gold in final top-10 / total gold
  numToolCalls: number;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    resultIds: string[];
  }>;
}

export interface BrightEvalRun {
  timestamp: string;
  totalQueries: number;
  overallNdcg10: number;
  overallRetrievalRecall: number;
  overallRankingRecall: number;
  byDomain: Record<string, { count: number; ndcg10: number; retrievalRecall: number; rankingRecall: number }>;
  description: string;
  results: BrightQueryResult[];
}
