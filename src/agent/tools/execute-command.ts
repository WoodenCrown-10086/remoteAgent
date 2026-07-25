import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  command: z
    .string()
    .describe(
      '要在沙箱中执行的 Shell 命令，例如 "node src/hello.ts" 或 "npm install"',
    ),
});

/**
 * 创建 execute_command 工具（工厂函数）
 * @param sandbox - e2b 沙箱实例
 */
export function createExecuteCommandTool(sandbox: Sandbox) {
  return tool({
    description:
      '在 e2b 云沙箱内执行 Shell 命令。用于运行代码、安装依赖或执行测试。',
    inputSchema,
    execute: async (args) => {
      const { command } = args;

      try {
        // 使用 sandbox.commands.run() 在沙箱中安全执行
        const result = await sandbox.commands.run(command, {
          timeoutMs: 30_000, // 30 秒超时
          onStdout: (data) => {
            console.log(`[e2b stdout] ${data}`);
          },
          onStderr: (data) => {
            console.log(`[e2b stderr] ${data}`);
          },
        });

        console.log(`[e2b 命令] ${command} (exit=${result.exitCode})`);

        const success = result.exitCode === 0;
        return {
          success,
          stdout: result.stdout || '(无输出)',
          stderr: result.stderr || '(无错误)',
          exitCode: result.exitCode,
          message: success
            ? `命令执行完成 (exit=0): ${command}`
            : `命令执行失败 (exit=${result.exitCode}): ${command}`,
        };
      } catch (error: any) {
        console.error(`[e2b 命令失败] ${command}`, error.message);
        return {
          success: false,
          stdout: '',
          stderr: error.message || '(未知错误)',
          exitCode: -1,
          message: `命令执行异常: ${error.message}`,
        };
      }
    },
  });
}
