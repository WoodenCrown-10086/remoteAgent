import { loadSkills } from '@/agent/skills';

/**
 * GET /api/skills — 返回所有可用 skill 列表（不含 body，前端只展示摘要）
 */
export async function GET() {
  const skills = await loadSkills();
  return Response.json({
    skills: skills.map(({ name, description }) => ({ name, description })),
  });
}
