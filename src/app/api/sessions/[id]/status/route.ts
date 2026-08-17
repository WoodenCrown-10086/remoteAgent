import { initDb, getSession, getLatestStep, updateSession } from '@/db/db';
import { taskManager } from '@/lib/task-manager';

/**
 * GET /api/sessions/:id/status — 查询后台任务状态
 * 返回：taskStatus（running/completed/failed/aborted/null）、当前步骤、是否运行中
 * 前端轮询此接口即可展示"执行中/第 N 步/已完成"。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await initDb();
  const { id } = await params;

  const session = await getSession(id);
  if (!session) {
    return Response.json({ error: '会话不存在' }, { status: 404 });
  }

  // 内存实时状态优先；进程重启后内存清空，回退到 DB 持久化状态
  const mem = taskManager.get(id);
  let taskStatus = mem || session.taskStatus || null;

  // 孤儿判定：DB 仍标记 running、但内存中已无运行状态 → 进程崩溃/重启后的残留。
  // 惰性标记为 aborted（不会误伤当前进程正在跑的任务——正在跑的任务内存里必有 running）。
  if (session.taskStatus === 'running' && !mem) {
    taskStatus = 'aborted';
    await updateSession(id, { taskStatus: 'aborted' }).catch((e) =>
      console.error('[status] 孤儿标记失败', e.message),
    );
  }

  const currentStep = await getLatestStep(id);

  return Response.json({
    sessionId: id,
    taskStatus,
    currentStep,
    running: taskStatus === 'running',
    finishedAt: taskStatus && taskStatus !== 'running' ? session.updatedAt : null,
  });
}
