import type { EmbeddingProvider, SearchResult } from './types';
import { getDb } from '@/db/db';
import { messageChunks } from '@/db/schema';
import { eq } from 'drizzle-orm';

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

// ── DB 持久化 ──

/** 将单个块写入 message_chunks 表（embedding 序列化为 JSON 字符串） */
export async function persistChunk(chunk: ChunkInput): Promise<void> {
  const db = getDb();
  await db.insert(messageChunks).values({
    id: chunk.id,
    sessionId: chunk.sessionId,
    sourceMessageId: chunk.sourceMessageId || null,
    content: chunk.content,
    embedding: JSON.stringify(chunk.embedding),
    kind: chunk.kind,
    seqFrom: chunk.seqFrom,
    seqTo: chunk.seqTo,
    createdAt: new Date().toISOString(),
  });
}

/** 从 message_chunks 表加载某会话的全部块，用于恢复内存向量库 */
export async function loadChunks(sessionId: string): Promise<ChunkInput[]> {
  const db = getDb();
  const rows = await db.select().from(messageChunks).where(eq(messageChunks.sessionId, sessionId));
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    sourceMessageId: r.sourceMessageId || undefined,
    content: r.content,
    kind: r.kind as ChunkInput['kind'],
    embedding: JSON.parse(r.embedding),
    seqFrom: r.seqFrom ?? 0,
    seqTo: r.seqTo ?? 0,
  }));
}
