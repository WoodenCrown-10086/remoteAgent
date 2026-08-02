import { tool } from 'ai';
import { z } from 'zod';
import type { AgentRoleName } from '@/agent/roles';

/**
 * 主 Agent 的派发工具：注册一个子任务到调度器。
 * orchestrator.dispatch 返回子任务执行结论（tool_result 回传主 Agent）。
 */
export function createDispatchTool(
  dispatchFn: (role: AgentRoleName, task: string, dependsOn: string[]) => Promise<string>,
) {
  return tool({
    description:
      '派发子任务给指定角色的子 Agent 执行。planner 完成后才能派发 coder；' +
      'reviewer 审查 coder 产出；evaluator 是准出门禁（必须全部 PASS）。' +
      'dependsOn 可声明依赖的任务 id（不声明则尽量并行）。',
    inputSchema: z.object({
      role: z.enum(['planner', 'coder', 'reviewer', 'evaluator']),
      task: z.string().describe('子任务详细描述'),
      dependsOn: z.array(z.string()).optional().describe('依赖的任务 id 列表'),
      taskId: z.string().optional().describe('自定义任务 id（便于后续依赖引用），默认自动生成'),
    }),
    execute: async ({ role, task, dependsOn = [], taskId }) => {
      try {
        const result = await dispatchFn(role, task, dependsOn);
        return { ok: true, taskId, role, result };
      } catch (e: any) {
        return { ok: false, role, error: e.message || '派发失败' };
      }
    },
  });
}
