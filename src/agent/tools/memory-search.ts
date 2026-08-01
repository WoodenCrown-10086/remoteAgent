import { tool } from 'ai';
import { z } from 'zod';
import type { SearchResult } from '@/agent/memory/types';

const inputSchema = z.object({
  query: z.string().describe('检索的关键词或问题'),
  k: z.number().int().min(1).max(10).optional().describe('返回条数，默认 5'),
});

/**
 * 创建 memory_search 工具（工厂函数）
 *
 * 在历史会话记忆中按语义检索相关内容。仅当上下文被压缩、需要回忆早期信息时使用。
 */
export function createMemorySearchTool(
  searchFn: (query: string, k?: number) => Promise<SearchResult[]>,
) {
  return tool({
    description:
      '在历史会话记忆中按语义检索相关内容。仅当上下文被压缩、需要回忆早期信息时使用。',
    inputSchema,
    execute: async ({ query, k = 5 }) => {
      try {
        const results = await searchFn(query, k);
        if (results.length === 0) return { results: [], note: '未找到相关历史记录' };
        return { results };
      } catch (e: any) {
        return { results: [], note: `记忆检索失败: ${e.message}` };
      }
    },
  });
}
