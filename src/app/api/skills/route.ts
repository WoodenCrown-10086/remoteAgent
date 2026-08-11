import { promises as fs } from 'fs';
import path from 'path';
import { loadSkills } from '@/agent/skills';

/**
 * Skill 管理 API
 *
 * GET    /api/skills            → { user: [{ name, description, source }] }
 * POST   /api/skills            → 创建用户 skill（body: { name, description, content }）
 * DELETE /api/skills?name=xxx   → 删除用户 skill（系统内置 skill 不可删除）
 */

const SKILLS_DIR = path.join(process.cwd(), '.agent', 'skills');
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i; // 防止路径穿越

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, '-');
}

/** 系统内置 skill 名（src/agent/system-skills/），不可覆盖/删除 */
async function getSystemSkillNames(): Promise<Set<string>> {
  const skills = await loadSkills();
  return new Set(
    skills.filter((s) => s.source === 'system').map((s) => s.name),
  );
}

export async function GET() {
  const skills = await loadSkills();
  return Response.json({
    user: skills.map(({ name, description, source }) => ({
      name,
      description,
      source,
    })),
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: string;
      description?: string;
      content?: string;
    };
    const name = sanitizeName(body.name || '');
    const description = (body.description || '').trim();
    const content = (body.content || '').trim();

    if (!name || !NAME_RE.test(name)) {
      return Response.json(
        { error: 'skill 名称只能包含字母、数字、连字符（用于文件安全）' },
        { status: 400 },
      );
    }
    if (!content) {
      return Response.json({ error: 'skill 内容不能为空' }, { status: 400 });
    }

    // 系统内置 skill 不允许覆盖
    const systemNames = await getSystemSkillNames();
    if (systemNames.has(name)) {
      return Response.json(
        { error: `"${name}" 是系统内置 skill，不能覆盖` },
        { status: 400 },
      );
    }

    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const filePath = path.join(SKILLS_DIR, `${name}.md`);
    const md = `---\nname: ${name}\ndescription: ${description || name}\n---\n\n${content}\n`;
    await fs.writeFile(filePath, md, 'utf-8');

    return Response.json({ ok: true, name });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '创建失败';
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get('name') || '';

  if (!NAME_RE.test(name)) {
    return Response.json({ error: '无效的 skill 名称' }, { status: 400 });
  }
  // 系统内置 skill 不可删除
  const systemNames = await getSystemSkillNames();
  if (systemNames.has(name)) {
    return Response.json(
      { error: `"${name}" 是系统内置 skill，不能删除` },
      { status: 400 },
    );
  }

  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  try {
    await fs.access(filePath);
  } catch {
    return Response.json({ error: `skill "${name}" 不存在` }, { status: 404 });
  }

  await fs.unlink(filePath);
  return Response.json({ ok: true, name });
}
