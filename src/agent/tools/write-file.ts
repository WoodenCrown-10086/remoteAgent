import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  path: z.string().describe('文件相对路径，例如 src/hello.ts'),
  content: z.string().describe('要写入的文件内容'),
});

/**
 * 创建 write_file 工具（工厂函数）
 * @param sandbox - e2b 沙箱实例
 */
export function createWriteFileTool(sandbox: Sandbox) {
  return tool({
    description: '创建或覆盖一个文件。用于将生成的代码或文件写入指定路径。',
    inputSchema,
    execute: async (args) => {
      const { path: filePath, content } = args;
      // 统一使用 /home/user 作为工作根目录
      const fullPath = filePath.startsWith('/')
        ? filePath
        : `/home/user/${filePath}`;

      try {
        await sandbox.files.write(fullPath, content);
        console.log(`[e2b 写入] ${fullPath}`);
        return {
          success: true,
          path: filePath,
          message: `文件 ${filePath} 已成功写入沙箱。`,
        };
      } catch (error: any) {
        return {
          success: false,
          path: filePath,
          message: `文件写入失败: ${error.message}`,
        };
      }
    },
  });
}
