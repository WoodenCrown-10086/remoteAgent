import type { Sandbox } from '@e2b/code-interpreter';
import {
  BASE_SYSTEM_PROMPT,
  PLANNER_AGENT_PROMPT,
  REVIEW_AGENT_PROMPT,
  EVALUATOR_AGENT_PROMPT,
} from './prompts';
import { createReadSkillTool, createAllSandboxTools } from './tools';

export type AgentRoleName = 'planner' | 'coder' | 'reviewer' | 'evaluator';

export interface AgentRole {
  role: AgentRoleName;
  systemPrompt: string;
  /** 工具工厂：'all' = 全部沙箱工具 + read_skill */
  tools: 'all' | Array<() => any>;
  sandboxAccess: 'read' | 'write' | 'none';
  maxSteps: number;
  parallelLimit?: number;
}

/** 构建角色的工具集（共享沙箱实例） */
export function buildRoleTools(role: AgentRole, sandbox: Sandbox): Record<string, any> {
  if (role.tools === 'all') {
    return { ...createAllSandboxTools(sandbox), read_skill: createReadSkillTool() };
  }
  const tools: Record<string, any> = {};
  for (const factory of role.tools) {
    const t = factory();
    if (t && t.name) tools[t.name] = t;
  }
  return tools;
}

export const ROLE_POOL: Record<AgentRoleName, AgentRole> = {
  planner: {
    role: 'planner',
    systemPrompt: PLANNER_AGENT_PROMPT,
    tools: [createReadSkillTool],
    sandboxAccess: 'read',
    maxSteps: 15,
    parallelLimit: 1, // planner 串行唯一
  },
  coder: {
    role: 'coder',
    systemPrompt: BASE_SYSTEM_PROMPT,
    tools: 'all',
    sandboxAccess: 'write',
    maxSteps: 50,
    parallelLimit: 3,
  },
  reviewer: {
    role: 'reviewer',
    systemPrompt: REVIEW_AGENT_PROMPT,
    tools: 'all', // 简化：复用全部工具，权限由 prompt 约束只读
    sandboxAccess: 'read',
    maxSteps: 20,
    parallelLimit: 3,
  },
  evaluator: {
    role: 'evaluator',
    systemPrompt: EVALUATOR_AGENT_PROMPT,
    tools: 'all',
    sandboxAccess: 'write',
    maxSteps: 25,
    parallelLimit: 1, // 准出门禁串行
  },
};
