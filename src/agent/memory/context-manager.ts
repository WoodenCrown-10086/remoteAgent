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
  private initPromise: Promise<void> | null = null;
  private textBuffer = new Map<number, string>(); // stepIndex → 聚合文本（流式碎片按 step 缓冲，等待 step_finish/done 一次性向量化）

  // user 任务关键词过滤：包含任一关键词才认为该消息值得向量化
  private static readonly taskKeywords = [
    '写', '创建', '修复', '运行', '执行', '安装', '测试',
    '代码', '文件', '命令', '脚本', '函数', '错误', 'bug',
    '报错', '输出', '结果', '配置', '依赖', '部署',
  ];

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

  /** 确保向量库已从 DB 加载过（promise 锁防止并发重复加载） */
  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const chunks = await loadChunks(this.opts.sessionId);
        for (const c of chunks) await this.vectorStore.upsert(c);
        this.initialized = true;
      })();
    }
    return this.initPromise;
  }

  async buildContext(prompt: string): Promise<BuildContextResult> {
    return legacyBuildContext(this.opts.sessionId, prompt, { apiKey: this.opts.apiKey });
  }

  /** 消息落库后调用：向量化（异步，不阻塞） */
  async onMessagePersisted(msg: Message): Promise<void> {
    if (!this.opts.enableVector) return;

    // ── text 碎片：同步聚合到缓冲区，不立即向量化（避免碎片被过滤/重复向量化）──
    if (msg.type === 'text' && msg.content) {
      const idx = msg.stepIndex ?? 0;
      this.textBuffer.set(idx, (this.textBuffer.get(idx) || '') + msg.content);
      return;
    }

    // ── step_finish：flush 该 step 完整回复，整体向量化 ──
    if (msg.type === 'step_finish') {
      const idx = msg.stepIndex ?? 0;
      const full = this.textBuffer.get(idx) || '';
      this.textBuffer.delete(idx);
      if (full.length > 0) {
        await this.vectorize(full, 'assistant_text', msg.id, msg.sequence);
      }
      return;
    }

    // ── done：flush 残留缓冲区（未收到 step_finish 的 step）──
    if (msg.type === 'done') {
      for (const [idx, text] of this.textBuffer) {
        if (text.length > 0) {
          await this.vectorize(text, 'assistant_text', msg.id, msg.sequence);
        }
      }
      this.textBuffer.clear();
      return;
    }

    // ── tool_result：content 为 null，结果在 metadata.toolResult（JSON）里 ──
    if (msg.type === 'tool_result' && msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata) as Record<string, unknown>;
        const raw = meta.toolResult;
        const resultContent = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
        if (resultContent && resultContent.length > 0) {
          await this.vectorize(resultContent, 'tool_result', msg.id, msg.sequence);
        }
      } catch (e) {
        console.error('[vector] tool_result 解析失败:', e);
      }
      return;
    }

    // ── user：任务关键词过滤，非任务型（闲聊等）跳过 ──
    if (msg.type === 'user' && msg.content) {
      if (this.isTaskLike(msg.content)) {
        await this.vectorize(msg.content, 'user', msg.id, msg.sequence);
      } else {
        console.log(`[vector] 跳过用户消息（非任务型，长度=${msg.content.length}）: ${msg.content.slice(0, 30)}`);
      }
    }
  }

  /** 判断用户消息是否像任务（含任一任务关键词） */
  private isTaskLike(text: string): boolean {
    return ContextManager.taskKeywords.some((kw) => text.includes(kw));
  }

  /** 统一向量化入口：日志 + 错误不抛出（不影响主流程） */
  private async vectorize(
    content: string,
    kind: 'user' | 'assistant_text' | 'tool_result',
    sourceMsgId: string,
    seq: number,
  ): Promise<void> {
    try {
      await this.ensureInitialized();
      const [embedding] = await this.opts.embeddingProvider.embed([content]);
      const chunk = {
        id: `${sourceMsgId}-${seq}-${kind}`,
        sessionId: this.opts.sessionId,
        sourceMessageId: sourceMsgId,
        content,
        kind,
        embedding,
        seqFrom: seq,
        seqTo: seq,
      };
      await this.vectorStore.upsert(chunk);
      await persistChunk(chunk).catch((e) => console.error('[vector persist]', e.message));
      console.log(`[vector] ${kind} 已向量化 ${content.length} 字符 (seq=${seq})`);
    } catch (e) {
      console.error('[vector embed] 失败（不影响主流程）:', e);
    }
  }

  async search(query: string, k = 5) {
    if (!this.opts.enableVector) return [];
    const [vec] = await this.opts.embeddingProvider.embed([query]);
    return this.vectorStore.search(vec, this.opts.sessionId, k);
  }

  dispose() {}
}
