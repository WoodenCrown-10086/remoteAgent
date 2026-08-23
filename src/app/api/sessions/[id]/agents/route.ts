import { initDb, getAgentTasks } from '@/db/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sessions/:id/agents — 查询某 session 的子 Agent 状态列表（刷新页面后恢复用）
 * 返回：{ agents: [{ agentId, agentRole, status, task }] }，按启动顺序排列
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await initDb();
  const { id } = await params;

  const agents = await getAgentTasks(id);
  return Response.json({
    agents: agents.map((a) => ({
      agentId: a.agentId,
      agentRole: a.agentRole,
      status: a.status,
      task: a.task,
    })),
  });
}
