import { promises as fs } from 'fs';
import path from 'path';

export interface Skill {
  /** skill 标识，如 react-tdd */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 注入到 System Prompt 的正文 */
  body: string;
  /** 适用场景（触发规则），如“任务涉及页面/UI 设计时” */
  triggers?: string;
  /** 来源：system = 内置（src/agent/system-skills/），user = 用户（.agent/skills/） */
  source: 'system' | 'user';
}

const USER_SKILLS_DIR = path.join(process.cwd(), '.agent', 'skills');
const SYSTEM_SKILLS_DIR = path.join(process.cwd(), 'src', 'agent', 'system-skills');

/**
 * 解析 markdown frontmatter（简单的 --- 分隔）
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      frontmatter[kv[1]] = kv[2].trim();
    }
  }

  return { frontmatter, body: match[2].trim() };
}

/**
 * 加载指定目录下所有 skill（markdown + frontmatter）
 */
async function loadFromDir(dir: string, source: Skill['source']): Promise<Skill[]> {
  try {
    await fs.access(dir);
  } catch {
    return []; // 目录不存在
  }

  const entries = await fs.readdir(dir);
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const filePath = path.join(dir, entry);
    const raw = await fs.readFile(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const name = frontmatter.name || entry.replace('.md', '');
    const description = frontmatter.description || '';
    const triggers = frontmatter.triggers || '';

    if (body.trim()) {
      skills.push({ name, description, body, source, triggers });
    }
  }

  return skills;
}

/**
 * 加载全部可用 skill：
 * - 系统内置（src/agent/system-skills/，只读）
 * - 用户自定义（.agent/skills/，可增删）
 */
export async function loadSkills(): Promise<Skill[]> {
  const [system, user] = await Promise.all([
    loadFromDir(SYSTEM_SKILLS_DIR, 'system'),
    loadFromDir(USER_SKILLS_DIR, 'user'),
  ]);
  return [...system, ...user];
}

/**
 * 从 @skill-name 引用和 skills 数组中解析要启用的 skill
 * @param prompt - 用户输入（可能含 @skill-name）
 * @param requestedSkills - API 参数中明确指定的 skill 列表
 * @param availableSkills - 所有可用 skill
 */
export function resolveSkills(
  prompt: string,
  requestedSkills: string[] | undefined,
  availableSkills: Skill[],
): Skill[] {
  const result: Skill[] = [];
  const added = new Set<string>();

  // 1. 从 prompt 中解析 @skill-name
  const atRefs = prompt.match(/@([\w-]+)/g);
  if (atRefs) {
    for (const ref of atRefs) {
      const name = ref.slice(1); // 去掉 @
      const skill = availableSkills.find((s) => s.name === name);
      if (skill && !added.has(skill.name)) {
        result.push(skill);
        added.add(skill.name);
      }
    }
  }

  // 2. 从 API 参数添加
  if (requestedSkills) {
    for (const name of requestedSkills) {
      if (!added.has(name)) {
        const skill = availableSkills.find((s) => s.name === name);
        if (skill) {
          result.push(skill);
          added.add(name);
        }
      }
    }
  }

  return result;
}

/**
 * 将启用的 skills 拼接到 System Prompt
 */
export function buildSkillPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const sections = skills.map(
    (s) => `### ${s.name}\n${s.description}\n\n${s.body}`,
  );
  return `\n\n## 启用的 Skills\n${sections.join('\n\n')}`;
}
