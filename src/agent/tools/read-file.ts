import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  path: z.string().describe('要读取的文件相对路径，例如 src/sum.js'),
});

/**
 * 创建 read_file 工具（工厂函数）
 * @param sandbox - e2b 沙箱实例
 */
export function createReadFileTool(sandbox: Sandbox) {
  return tool({
    description: '读取指定文件的内容。用于查看代码或排查错误。',
    inputSchema,
    execute: async (args) => {
      const { path: filePath } = args;
      const fullPath = filePath.startsWith('/')
        ? filePath
        : `/home/user/${filePath}`;

      try {
        const content = await sandbox.files.read(fullPath, { format: 'text' });
        console.log(`[e2b 读取] ${filePath}`);
        return {
          success: true,
          path: filePath,
          content,
          message: `文件 ${filePath} 读取成功。`,
        };
      } catch (error: any) {
        return {
          success: false,
          path: filePath,
          content: '',
          message: `文件读取失败: ${error.message}`,
        };
      }
    },
  });
}
