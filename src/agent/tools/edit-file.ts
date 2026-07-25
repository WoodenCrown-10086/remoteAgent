import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  path: z.string().describe('要编辑的文件路径，例如 src/index.ts'),
  old_string: z
    .string()
    .describe('要被替换的原始文本片段（必须精确匹配文件中的内容）'),
  new_string: z.string().describe('替换后的新文本片段'),
});

/**
 * 创建 edit_file 工具（工厂函数）
 *
 * 先读取文件，执行精确字符串替换，再写回。
 * 相比 write_file 的全量覆盖，edit_file 只替换指定的片段，
 * 大幅减少 LLM 需要输出的 token 数量，也降低了意外覆盖其他代码的风险。
 */
export function createEditFileTool(sandbox: Sandbox) {
  return tool({
    description:
      '精准编辑文件中的一段内容。先读取文件找到 old_string，替换为 new_string 后写回。适用于修复单行 bug、修改函数体等场景。',
    inputSchema,
    execute: async (args) => {
      const { path: filePath, old_string, new_string } = args;
      const fullPath = filePath.startsWith('/')
        ? filePath
        : `/home/user/${filePath}`;

      try {
        // 1. 读取当前内容
        const currentContent = await sandbox.files.read(fullPath, {
          format: 'text',
        });

        // 2. 检查 old_string 是否存在
        if (!currentContent.includes(old_string)) {
          return {
            success: false,
            path: filePath,
            message: `编辑失败：在 ${filePath} 中未找到指定的原始文本片段。请用 read_file 确认当前内容后再试。`,
          };
        }

        // 3. 只替换第一处匹配（防止意外修改多处）
        const occurrenceCount =
          currentContent.split(old_string).length - 1;
        const newContent = currentContent.replace(old_string, new_string);

        // 4. 写回
        await sandbox.files.write(fullPath, newContent);

        console.log(
          `[edit_file] ${filePath} (替换了 ${occurrenceCount} 处中的第 1 处)`,
        );

        return {
          success: true,
          path: filePath,
          occurrences: occurrenceCount,
          replaced: 1,
          message:
            occurrenceCount > 1
              ? `文件 ${filePath} 编辑成功（old_string 在文件中出现了 ${occurrenceCount} 次，已替换第 1 处）。如需替换其他位置，请提供更精确的上下文。`
              : `文件 ${filePath} 编辑成功。`,
        };
      } catch (error: any) {
        return {
          success: false,
          path: filePath,
          message: `编辑失败: ${error.message}`,
        };
      }
    },
  });
}
