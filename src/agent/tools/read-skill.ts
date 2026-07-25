import { tool } from 'ai';
import { z } from 'zod';
import { loadSkills } from '@/agent/skills';

const inputSchema = z.object({
  name: z.string().describe('要加载的 skill 名称，例如 "react-tdd" 或 "typescript-strict"'),
});

/**
 * 创建 read_skill 工具（非工厂函数——不需要沙箱，直接读本地文件）
 */
export const readSkill = tool({
  description:
    '加载指定 skill 的完整规范内容。当你需要遵循某个开发规范（如 TDD、TypeScript 严格模式）时调用。先查看可用 skill 列表（在 System Prompt 末尾），选择相关 skill，用此工具获取详细规范。',
  inputSchema,
  execute: async (args) => {
    const { name } = args;
    const skills = await loadSkills();
    const skill = skills.find((s) => s.name === name);

    if (!skill) {
      return {
        success: false,
        name,
        body: '',
        message: `Skill "${name}" 不存在。可用 skills: ${skills.map((s) => s.name).join(', ')}`,
      };
    }

    console.log(`[read_skill] 加载 skill: ${name}`);
    return {
      success: true,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      message: `已加载 skill "${name}": ${skill.description}`,
    };
  },
});
