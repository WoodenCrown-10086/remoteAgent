import type { EmbeddingProvider, SearchResult } from './types';

export interface ChunkInput {
  id: string;
  sessionId: string;
  sourceMessageId?: string;
  content: string;
  kind: 'user' | 'assistant_text' | 'tool_result' | 'file';
  embedding: number[];
  seqFrom: number;
  seqTo: number;
}

export class VectorStore {
  private chunks: ChunkInput[] = []; // 内存 + DB 双写（DB 持久化见后续任务）

  constructor(private embedding: EmbeddingProvider) {}

  chunkText(text: string, maxLen: number = 500): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }

  async upsert(chunk: ChunkInput): Promise<void> {
    this.chunks.push(chunk);
  }

  async search(
    queryEmbedding: number[],
    sessionId: string,
    k: number = 5,
  ): Promise<SearchResult[]> {
    const scored = this.chunks
      .filter((c) => c.sessionId === sessionId)
      .map((c) => ({ c, score: cosine(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return scored.map(({ c, score }) => ({
      content: c.content,
      kind: c.kind,
      sessionId: c.sessionId,
      score,
    }));
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
