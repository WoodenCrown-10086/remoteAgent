import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  command: z
    .string()
    .describe(
      '要在沙箱中执行的 Shell 命令，例如 "node src/hello.ts" 或 "npm install"',
    ),
  background: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      '设为 true 时命令在后台运行，立即返回（用于启动 Web 服务等长期运行的进程）',
    ),
});

/**
 * 创建 execute_command 工具（工厂函数）
 * @param sandbox - e2b 沙箱实例
 */
export function createExecuteCommandTool(sandbox: Sandbox) {
  return tool({
    description:
      '在 e2b 云沙箱内执行 Shell 命令。用于运行代码、安装依赖或执行测试。启动 Web 服务等长期运行的命令时，必须设置 background=true，避免超时。',
    inputSchema,
    execute: async (args) => {
      const { command, background } = args;

      try {
        if (background) {
          // 后台运行：不等待，立即返回
          const handle = await sandbox.commands.run(command, {
            background: true,
            onStdout: (data) => console.log(`[e2b stdout] ${data}`),
            onStderr: (data) => console.log(`[e2b stderr] ${data}`),
          });
          console.log(`[e2b 后台命令] ${command} (pid=${handle.pid})`);
          return {
            success: true,
            stdout: `后台进程已启动 (pid=${handle.pid})`,
            stderr: '(无错误)',
            exitCode: 0,
            message: `后台命令已启动 (pid=${handle.pid}): ${command}`,
          };
        }

        // 同步执行：等待完成
        const result = await sandbox.commands.run(command, {
          timeoutMs: 30_000,
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
