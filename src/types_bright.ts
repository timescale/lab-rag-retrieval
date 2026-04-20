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
  numToolCalls: number;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
}

export interface BrightEvalRun {
  timestamp: string;
  totalQueries: number;
  overallNdcg10: number;
  byDomain: Record<string, { count: number; ndcg10: number }>;
  description: string;
  results: BrightQueryResult[];
}
