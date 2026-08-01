export interface SummaryData {
  summary: string;
  tokens: number;
}

export interface SearchResult {
  content: string;
  kind: string;
  sessionId: string;
  score: number;
}

export interface EmbeddingProvider {
  name: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type LlmSummarizeFn = (prompt: string) => Promise<string>;
