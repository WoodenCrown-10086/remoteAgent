import { updateSession } from '@/db/db';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * 后台任务状态管理器。
 * - 内存 Map 提供实时状态（无需查库）
 * - DB session.task_status 持久化（进程重启/多实例后仍可读取）
 *
 * 注意：多实例部署时内存状态不同步，但 DB 是权威来源（重启后从 DB 恢复）。
 */
const memStatus = new Map<string, TaskStatus>();

export const taskManager = {
  async start(sessionId: string) {
    memStatus.set(sessionId, 'running');
    await updateSession(sessionId, { taskStatus: 'running' }).catch((e) =>
      console.error('[task] 状态写入失败(running)', e.message),
    );
  },

  async finish(sessionId: string, status: Exclude<TaskStatus, 'running'>) {
    memStatus.set(sessionId, status);
    await updateSession(sessionId, { taskStatus: status }).catch((e) =>
      console.error('[task] 状态写入失败', e.message),
    );
  },

  /** 内存中的实时状态（无则 null） */
  get(sessionId: string): TaskStatus | null {
    return memStatus.get(sessionId) ?? null;
  },
};
