import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('要列出的目录路径，默认 /home/user，例如 "src/" 或 "/home/user/project"'),
  depth: z
    .number()
    .optional()
    .default(3)
    .describe('递归深度，1 表示只列当前目录，默认 3'),
});

/**
 * 创建 list_files 工具（工厂函数）
 */
export function createListFilesTool(sandbox: Sandbox) {
  return tool({
    description:
      '列出沙箱中指定目录的文件和子目录结构。用于了解项目结构、查看有哪些文件。',
    inputSchema,
    execute: async (args) => {
      const dirPath = args.path
        ? args.path.startsWith('/')
          ? args.path
          : `/home/user/${args.path}`
        : '/home/user';
      const depth = args.depth || 3;

      // 使用 find 而非 tree（tree 可能未预装）
      const cmd = `find '${dirPath}' -maxdepth ${depth} -not -path '*/\\.*' | sort | head -n 200`;

      try {
        const result = await sandbox.commands.run(cmd, { timeoutMs: 5_000 });

        const entries = result.stdout.trim().split('\n').filter(Boolean);

        // 同时获取顶层目录的详细信息
        let detailCmd: string;
        if (depth === 1) {
          detailCmd = `ls -lh '${dirPath}'`;
        } else {
          // 只对第一层做详细列表
          detailCmd = `ls -lh '${dirPath}'`;
        }

        const detailResult = await sandbox.commands.run(detailCmd, {
          timeoutMs: 3_000,
        });

        console.log(`[list_files] ${dirPath} → ${entries.length} 个条目`);

        return {
          success: true,
          path: args.path || '/home/user',
          entries,
          count: entries.length,
          detail: detailResult.stdout || '',
          message: `目录 ${args.path || '/home/user'} 下有 ${entries.length} 个条目`,
        };
      } catch (error: any) {
        return {
          success: false,
          entries: [],
          count: 0,
          message: `列出目录失败: ${error.message}`,
        };
      }
    },
  });
}
