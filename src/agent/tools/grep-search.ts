import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  pattern: z.string().describe('搜索模式，支持正则表达式，例如 "function sum" 或 "import.*from"'),
  path: z
    .string()
    .optional()
    .describe('搜索目录，默认 /home/user，例如 src/ 只搜索 src 目录'),
  include: z
    .string()
    .optional()
    .describe('文件名过滤 glob，例如 "*.ts" 只搜索 TypeScript 文件'),
  maxResults: z
    .number()
    .optional()
    .default(50)
    .describe('最大返回结果数，默认 50'),
});

/**
 * 创建 grep_search 工具（工厂函数）
 */
export function createGrepSearchTool(sandbox: Sandbox) {
  return tool({
    description:
      '在沙箱代码库中搜索匹配的文本行。用于快速定位函数、类、导入语句等。支持正则表达式。',
    inputSchema,
    execute: async (args) => {
      const { pattern, path: searchPath, include, maxResults } = args;

      // 转义 pattern 中的单引号
      const escaped = pattern.replace(/'/g, "'\\''");

      let cmd = `grep -rn --color=never '${escaped}'`;
      cmd += ` /home/user/${searchPath || ''}`;

      if (include) {
        cmd += ` --include='${include}'`;
      }

      cmd += ` | head -n ${maxResults || 50}`;

      try {
        const result = await sandbox.commands.run(cmd, {
          timeoutMs: 10_000,
        });

        const lines = result.stdout
          .trim()
          .split('\n')
          .filter(Boolean);

        if (result.exitCode === 0 || lines.length > 0) {
          console.log(`[grep] 找到 ${lines.length} 条匹配: ${pattern}`);
          return {
            success: true,
            matches: lines,
            count: lines.length,
            message: `找到 ${lines.length} 条匹配 "${pattern}"`,
          };
        }

        // exitCode 1 = no matches (grep 的正常行为)
        return {
          success: true,
          matches: [],
          count: 0,
          message: `未找到匹配 "${pattern}"`,
        };
      } catch (error: any) {
        return {
          success: false,
          matches: [],
          count: 0,
          message: `搜索失败: ${error.message}`,
        };
      }
    },
  });
}
