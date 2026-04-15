import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// MuSiQue dataset types
// ---------------------------------------------------------------------------

export interface MuSiQueParagraph {
  idx: number;
  title: string;
  paragraph_text: string;
  is_supporting: boolean;
}

export interface DecompositionStep {
  id: number;
  question: string;
  answer: string;
  paragraph_support_idx: number;
}

export interface MuSiQueQuestion {
  id: string;
  paragraphs: MuSiQueParagraph[];
  question: string;
  question_decomposition: DecompositionStep[];
  answer: string;
  answer_aliases: string[];
  answerable: boolean;
}

// ---------------------------------------------------------------------------
// Corpus document (139k IRCoT paragraphs)
// ---------------------------------------------------------------------------

export interface CorpusDoc {
  id: string;
  title: string;
  paragraph_text: string;
}

// ---------------------------------------------------------------------------
// Eval result types
// ---------------------------------------------------------------------------

export interface QAResult {
  questionId: string;
  question: string;
  answer: string;
  answerAliases: string[];
  prediction: string;
  hops: number;
  f1: number;
  em: number;
  context: string;
  numToolCalls: number;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  retrievalRecall: number;
  accuracy: number;
}

export interface EvalRun {
  timestamp: string;
  totalQA: number;
  overallF1: number;
  overallEM: number;
  byHops: Record<number, { count: number; f1: number; em: number }>;
  description: string;
  results: QAResult[];
}
