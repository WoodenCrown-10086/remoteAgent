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

/** 创建所有沙箱工具 */
export function createAllSandboxTools(sandbox: Sandbox) {
  return {
    write_file: createWriteFileTool(sandbox),
    read_file: createReadFileTool(sandbox),
    edit_file: createEditFileTool(sandbox),
    execute_command: createExecuteCommandTool(sandbox),
    grep_search: createGrepSearchTool(sandbox),
    list_files: createListFilesTool(sandbox),
    web_fetch: createWebFetchTool(sandbox),
    web_search: createWebSearchTool(sandbox),
  };
}

/** read_skill 是本地工具，不需要沙箱 */
export function createReadSkillTool() {
  return readSkill;
}
