import { tool } from 'ai';
import { z } from 'zod';
import type { PlanConsensusResult } from '@/agent/orchestrator';

/**
 * 主 Agent 的「规划」工具：首次规划时调用。
 * 内部并行派 3 个 planner 独立产出候选方案 → 交叉评分 → 返回平均分最高的方案。
 * 后续 loop 里的规划调整不调用此工具，而是用 dispatch 派单个 planner（复用已选方案微调）。
 */
export function createPlanTool(
  planFn: (task: string) => Promise<PlanConsensusResult>,
) {
  return tool({
    description:
      '首次规划：并行派 3 个 planner 独立产出候选方案，交叉评分后返回平均分最高的方案（含该方案与各候选分数）。' +
      '仅在任务的第一轮规划时使用；后续 loop 里的规划调整请用 dispatch 派单个 planner。',
    inputSchema: z.object({
      task: z
        .string()
        .describe('需要规划的需求描述（自包含，planner 看不到你的其他上下文）'),
    }),
    execute: async ({ task }) => {
      try {
        const result = await planFn(task);
        return {
          ok: true,
          plan: result.plan,
          score: result.score,
          candidates: result.candidates.map((c) => ({ id: c.id, score: c.score })),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '规划失败' };
      }
    },
  });
}
