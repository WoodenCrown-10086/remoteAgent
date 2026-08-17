import { tool } from 'ai';
import { z } from 'zod';

/**
 * 创建 report_artifact 工具（工厂函数）。
 *
 * 子 Agent（coder）在任务完成前必须调用它，声明本次交付/创建/修改的文件路径清单。
 * 这些声明的路径会进入 AgentReport.artifacts，供准出门禁（gateVerify）逐一校验文件真实存在，
 * 从而形成「真门禁」：coder 声称产出的文件必须真实落地，否则门禁不通过。
 *
 * @param onArtifact - 产物登记回调，收到 coder 声明的路径列表
 */
export function createReportArtifactTool(onArtifact: (paths: string[]) => void) {
  return tool({
    description:
      '任务完成前必须调用：声明本次交付/创建/修改的文件路径清单（相对路径）。' +
      '准出门禁会逐一校验这些文件真实存在，遗漏或虚报会导致门禁不通过。',
    inputSchema: z.object({
      paths: z
        .array(z.string())
        .describe('交付产物的文件相对路径列表，例如 ["src/index.ts", "src/utils.ts"]'),
    }),
    execute: async ({ paths }) => {
      onArtifact(paths);
      return {
        success: true,
        declared: paths,
        message: `已声明 ${paths.length} 个产物文件：${paths.join(', ')}`,
      };
    },
  });
}
