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
// ── 进程内缓存 ──
// skill 文件本身很小，但 loadSkills 会被多条路径高频调用（主 Agent 构建 prompt、
// 每个子 Agent 组装 prompt、read_skill 工具），故做进程内缓存避免重复读盘。
// 用户通过 /api/skills 增删 skill 时调用 invalidateSkillCache() 失效。
let _skillsCache: Skill[] | null = null;

export async function loadSkills(): Promise<Skill[]> {
  if (_skillsCache) return _skillsCache;
  const [system, user] = await Promise.all([
    loadFromDir(SYSTEM_SKILLS_DIR, 'system'),
    loadFromDir(USER_SKILLS_DIR, 'user'),
  ]);
  _skillsCache = [...system, ...user];
  return _skillsCache;
}

/** 用户增删 skill 后调用，清空缓存使下次 loadSkills 重新读盘 */
export function invalidateSkillCache(): void {
  _skillsCache = null;
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

/**
 * 生成中性的 skill 清单文本（名字 + 触发场景 + 描述），供注入 System Prompt 展示。
 * 「何时 read_skill / 如何派发」等动作指引由各 System Prompt 正文负责，这里只给清单本身。
 */
export function formatSkillList(skills: Skill[]): string {
  return (
    skills
      .map(
        (s) =>
          `- **${s.name}**${s.triggers ? `：适用于 ${s.triggers}` : ''}。${s.description}。`,
      )
      .join('\n') ||
    '（暂无可用 Skill。在 .agent/skills/ 目录下创建 .md 文件即可添加。）'
  );
}

/**
 * 生成统一注入子 Agent 的 skill 使用说明段：
 * - 列出可用 skills（名字 + 触发 + 描述）
 * - 声明「靠主 Agent 分发、不主动读取」的规则
 * - 声明「缺 skill 用 report_skill_gap 上报」的规则
 */
export function buildSkillUsageSection(skillList: string): string {
  return `\n\n## 可用 Skills（由主 Agent 分发，勿主动读取）
${skillList}

使用规则：
- 仅当派发的任务里明确要求「使用某 skill」时，才用 read_skill 加载它；不要主动 read_skill。
- 若完成当前任务需要某个 skill / 能力，但任务未指明、上面列表里也没有，调用 report_skill_gap 声明缺失并停止——任务会被标记为未完成，主 Agent 会在下一轮补上能力后重新派发，不要强行产出劣质结果。`;
}
