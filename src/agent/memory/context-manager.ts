import type { EmbeddingProvider } from './types';
import { VectorStore, loadChunks, persistChunk } from './vector-store';
import { buildContext as legacyBuildContext } from '@/agent/context';
import type { BuildContextResult } from '@/agent/context';
import type { Message } from '@/db/schema';

/**
 * ContextManager：上下文统一入口。
 * - buildContext：委托给 legacy 压缩引擎构建 LLM 上下文
 * - onMessagePersisted：消息落库后异步向量化并双写内存 + DB
 * - search：向量检索历史块
 */
export class ContextManager {
  private vectorStore: VectorStore;
  private initialized = false;

  constructor(
    private opts: {
      sessionId: string;
      embeddingProvider: EmbeddingProvider;
      apiKey?: string;
      enableVector?: boolean;
    },
  ) {
    this.vectorStore = new VectorStore(opts.embeddingProvider);
  }

  async buildContext(prompt: string): Promise<BuildContextResult> {
    return legacyBuildContext(this.opts.sessionId, prompt, { apiKey: this.opts.apiKey });
  }

  /** 消息落库后调用：向量化（异步，不阻塞） */
  async onMessagePersisted(msg: Message): Promise<void> {
    if (!this.opts.enableVector) return;
    if (!this.initialized) {
      const chunks = await loadChunks(this.opts.sessionId);
      for (const c of chunks) await this.vectorStore.upsert(c);
      this.initialized = true;
    }
    if (!['user', 'text', 'tool_result'].includes(msg.type)) return;
    if (!msg.content || msg.content.length < 10) return;

    const kind: 'user' | 'tool_result' | 'assistant_text' =
      msg.type === 'user' ? 'user' : msg.type === 'tool_result' ? 'tool_result' : 'assistant_text';
    try {
      const [embedding] = await this.opts.embeddingProvider.embed([msg.content.slice(0, 2000)]);
      const chunk = {
        id: msg.id,
        sessionId: this.opts.sessionId,
        sourceMessageId: msg.id,
        content: msg.content.slice(0, 2000),
        kind,
        embedding,
        seqFrom: msg.sequence,
        seqTo: msg.sequence,
      };
      await this.vectorStore.upsert(chunk);
      await persistChunk(chunk).catch((e) => console.error('[vector persist]', e.message));
    } catch (e) {
      console.error('[vector embed] 跳过（不影响主流程）', e);
    }
  }

  async search(query: string, k = 5) {
    if (!this.opts.enableVector) return [];
    const [vec] = await this.opts.embeddingProvider.embed([query]);
    return this.vectorStore.search(vec, this.opts.sessionId, k);
  }

  dispose() {}
}
