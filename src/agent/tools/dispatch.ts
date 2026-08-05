import { tool } from 'ai';
import { z } from 'zod';
import type { AgentRoleName } from '@/agent/roles';

export interface DispatchBatchResult {
  reports: Array<{
    taskId: string;
    role: string;
    status: string;
    summary: string;
    gatePassed?: boolean;
    gateReason?: string;
  }>;
  gatePassed: boolean;
  gateFailures: string[];
}

/**
 * 主 Agent 的派发工具：注册子任务并同步等待完成 + 门禁。
 * dispatchFn = orchestrator.dispatchBatch（单任务 = 单元素数组）。
 * 返回聚合报告 + gateFailures（未放行原因，供主 Agent 决策打回）。
 */
export function createDispatchTool(
  dispatchFn: (
    role: AgentRoleName,
    task: string,
    dependsOn: string[],
    taskId?: string,
  ) => Promise<DispatchBatchResult>,
) {
  return tool({
    description:
      '派发子任务给指定角色的子 Agent 执行（同步等待完成）。planner 完成后才能派发 coder；' +
      'reviewer 审查 coder 产出；evaluator 是准出门禁。返回聚合报告 + 门禁结果（gateFailures 为未放行原因）。' +
      'dependsOn 可声明依赖的任务 id。',
    inputSchema: z.object({
      role: z.enum(['planner', 'coder', 'reviewer', 'evaluator']),
      task: z.string().describe('子任务详细描述'),
      dependsOn: z.array(z.string()).optional().describe('依赖的任务 id 列表'),
      taskId: z.string().optional().describe('任务 id（便于依赖引用）'),
    }),
    execute: async ({ role, task, dependsOn = [], taskId }) => {
      try {
        const result = await dispatchFn(role, task, dependsOn, taskId);
        return { ok: true, taskId, role, ...result };
      } catch (e: any) {
        return { ok: false, role, error: e.message || '派发失败' };
      }
    },
  });
}
