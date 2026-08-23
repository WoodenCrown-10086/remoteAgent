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

export interface DispatchInput {
  role: AgentRoleName;
  tasks: Array<{ id?: string; task: string }>;
  dependsOn?: string[];
}

/**
 * 主 Agent 的派发工具：批量注册同角色子任务、并行调度、同步等待全部完成 + 门禁。
 * dispatchFn = orchestrator.dispatchBatch。
 * 返回聚合报告 + gateFailures（未放行原因，供主 Agent 决策打回）。
 */
export function createDispatchTool(
  dispatchFn: (input: DispatchInput) => Promise<DispatchBatchResult>,
) {
  return tool({
    description:
      '批量并行派发子任务给指定角色的子 Agent 执行（同步等待全部完成）。' +
      '同一角色的多个任务会并行执行（受并行度限制）。' +
      'planner 完成后才能派发 coder；reviewer 审查 coder 产出；evaluator 是准出门禁。' +
      '返回聚合报告 + 门禁结果（gateFailures 为未放行原因）。dependsOn 声明这些任务共同依赖的任务 id。',
    inputSchema: z.object({
      role: z.enum(['planner', 'coder', 'reviewer', 'evaluator']),
      tasks: z
        .array(
          z.object({
            task: z
              .string()
              .describe('子任务详细描述（自包含，子 Agent 看不到其他上下文）'),
            taskId: z
              .string()
              .optional()
              .describe('任务 id（便于后续依赖引用），默认自动生成'),
          }),
        )
        .describe('并行派发的任务列表（同一角色，各自独立执行）'),
      dependsOn: z
        .array(z.string())
        .optional()
        .describe('这些任务共同依赖的任务 id 列表'),
    }),
    execute: async ({ role, tasks, dependsOn = [] }) => {
      try {
        const result = await dispatchFn({ role, tasks, dependsOn });
        // 只回传结构化精简结果给主 Agent（status/summary/门禁），
        // 不把子 Agent 的完整 report 全文暴露给主 Agent——主 Agent 只分发，不做实质决策。
        return {
          ok: true,
          role,
          gatePassed: result.gatePassed,
          gateFailures: result.gateFailures,
          reports: result.reports.map((r) => ({
            taskId: r.taskId,
            role: r.role,
            status: r.status,
            summary: r.summary,
            gatePassed: r.gatePassed,
            gateReason: r.gateReason,
          })),
        };
      } catch (e: any) {
        return { ok: false, role, error: e.message || '派发失败' };
      }
    },
  });
}
