import { tool } from 'ai';
import { z } from 'zod';

/**
 * 创建 report_skill_gap 工具（工厂函数）。
 *
 * 子 Agent 在完成任务时，若缺少某个 skill / 能力（任务未指定、可用 Skills 列表也没有），
 * 调用此工具声明缺失并停止，而不是强行产出劣质结果。声明的缺失会进入
 * AgentReport.missingSkills，使任务被标记未完成；主 Agent 在下一轮 loop 中补上能力后重新派发。
 *
 * @param onGap - 缺失 skill 登记回调，收到声明的 skill 名称列表
 */
export function createReportSkillGapTool(onGap: (skills: string[]) => void) {
  return tool({
    description:
      '当你缺少完成当前任务所需的 skill / 能力（任务里未指定、可用 Skills 列表也没有）时调用，' +
      '声明缺失并停止。任务会被标记为未完成，主 Agent 会在下一轮补上能力后重新派发。不要强行产出劣质结果。',
    inputSchema: z.object({
      skills: z
        .array(z.string())
        .describe('缺少的 skill 名称列表，例如 ["react-tdd"]'),
      reason: z.string().optional().describe('为什么需要这些 skill'),
    }),
    execute: async ({ skills }) => {
      onGap(skills);
      return {
        success: true,
        missing: skills,
        message: `已标记缺少 skill，任务未完成：${skills.join(', ')}`,
      };
    },
  });
}
