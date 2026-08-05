import type { Sandbox } from '@e2b/code-interpreter';
import { createWriteFileTool } from './write-file';
import { createReadFileTool } from './read-file';
import { createEditFileTool } from './edit-file';
import { createExecuteCommandTool } from './execute-command';
import { createGrepSearchTool } from './grep-search';
import { createListFilesTool } from './list-files';
import { createWebFetchTool } from './web-fetch';
import { createWebSearchTool } from './web-search';
import { readSkill } from './read-skill';

// 沙箱续期 TTL：每次工具执行后续期，避免长任务中超时被 e2b 回收（绝对 TTL，普通调用不续期）
const KEEPALIVE_MS = 3_600_000;

/**
 * 包装工具：执行成功后重置沙箱 TTL（续期失败不影响工具结果）
 */
function withSandboxKeepAlive<T extends Record<string, any>>(
  toolObj: T,
  sandbox: Sandbox,
): T {
  const origExecute = toolObj.execute;
  if (typeof origExecute !== 'function') return toolObj;
  return {
    ...toolObj,
    execute: async (args: any, options: any) => {
      const result = await origExecute(args, options);
      try {
        await sandbox.setTimeout(KEEPALIVE_MS);
      } catch (e: any) {
        console.error('[keepalive] 沙箱续期失败:', e.message);
      }
      return result;
    },
  };
}

/** 创建所有沙箱工具（带活动续期） */
export function createAllSandboxTools(sandbox: Sandbox) {
  return {
    write_file: withSandboxKeepAlive(createWriteFileTool(sandbox), sandbox),
    read_file: withSandboxKeepAlive(createReadFileTool(sandbox), sandbox),
    edit_file: withSandboxKeepAlive(createEditFileTool(sandbox), sandbox),
    execute_command: withSandboxKeepAlive(createExecuteCommandTool(sandbox), sandbox),
    grep_search: withSandboxKeepAlive(createGrepSearchTool(sandbox), sandbox),
    list_files: withSandboxKeepAlive(createListFilesTool(sandbox), sandbox),
    web_fetch: withSandboxKeepAlive(createWebFetchTool(sandbox), sandbox),
    web_search: withSandboxKeepAlive(createWebSearchTool(sandbox), sandbox),
  };
}

/** read_skill 是本地工具，不需要沙箱 */
export function createReadSkillTool() {
  return readSkill;
}
