import { runAgent } from './runner';
import type { AgentRoleName } from './roles';
import { ROLE_POOL, buildRoleTools } from './roles';
import type { EmbeddingProvider } from './memory/types';
import { ContextManager } from './memory/context-manager';
import type { Sandbox } from '@e2b/code-interpreter';
import { getNextSequence } from '@/db/db';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'passed';

export interface TaskNode {
  id: string;
  role: AgentRoleName;
  task: string;
  dependsOn: string[];
  status: TaskStatus;
  result?: string;
  checkPassed?: boolean;
  retries: number;
}

/** 每个子 Agent 的结构化报告 */
export interface AgentReport {
  taskId: string;
  role: AgentRoleName;
  task: string;
  status: 'passed' | 'failed' | 'pending';   // 完成 Flag
  summary: string;
  artifacts: string[];
  report: string;
  gatePassed?: boolean;
  gateReason?: string;
}

export interface OrchestratorOpts {
  sandbox: Sandbox;
  sessionId: string;
  apiKey?: string;
  embeddingProvider?: EmbeddingProvider;
  maxParallel?: number;
  maxRetries?: number;
  /** 事件发射器（子 Agent 生命周期事件转发到 SSE） */
  emit: (data: Record<string, unknown>) => void;
  /** 门禁验证脚本：检查产物真实存在/就绪 */
  gateVerify?: (report: AgentReport) => Promise<{ ok: boolean; reason?: string }>;
}

export class Orchestrator {
  private tasks = new Map<string, TaskNode>();
  private running = 0;
  private maxParallel: number;
  private maxRetries: number;
  private seqCounter = 0;

  /** 全局状态集合：taskId → 报告（准出标记） */
  private agentStates = new Map<string, AgentReport>();

  constructor(private opts: OrchestratorOpts) {
    this.maxParallel = opts.maxParallel ?? 3;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  /** 注册并调度一个子任务（主 Agent dispatch 工具调用） */
  async dispatch(role: AgentRoleName, task: string, dependsOn: string[] = [], taskId?: string): Promise<string> {
    const id = taskId || `${role}-${++this.seqCounter}`;
    if (this.tasks.has(id)) {
      throw new Error(`任务 id 重复: ${id}`);
    }
    const node: TaskNode = { id, role, task, dependsOn, status: 'pending', retries: 0 };
    this.tasks.set(id, node);
    this.opts.emit({ type: 'agent_start', agentId: id, agentRole: role, task });

    this.tryRunReady();
    return id;
  }

  /** 等待指定任务全部到达终态（带超时） */
  private async waitFor(ids: string[], timeoutMs: number = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pending = () => ids.some((id) => {
      const t = this.tasks.get(id);
      return t && (t.status === 'pending' || t.status === 'running');
    });
    while (pending()) {
      if (Date.now() > deadline) {
        for (const id of ids) {
          const t = this.tasks.get(id);
          if (t && (t.status === 'pending' || t.status === 'running')) {
            t.status = 'failed';
            t.result = '调度超时';
          }
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
      this.tryRunReady();
    }
  }

  /** 批量派发：N 个并行子任务 → 同步等待全部完成 → 跑门禁 → 返回聚合结果 */
  async dispatchBatch(
    role: AgentRoleName,
    tasks: Array<{ id?: string; task: string }>,
    dependsOn: string[] = [],
  ): Promise<{
    reports: AgentReport[];
    gatePassed: boolean;
    gateFailures: string[];
  }> {
    const ids = await Promise.all(
      tasks.map((t) => this.dispatch(role, t.task, dependsOn, t.id)),
    );
    await this.waitFor(ids);
    const reports = ids.map((id) => {
      const existing = this.agentStates.get(id);
      if (existing) return existing;
      // 兜底：级联失败 / 超时未写报告的任务
      const t = this.tasks.get(id);
      return {
        taskId: id,
        role: (t?.role ?? 'unknown') as AgentRoleName,
        task: t?.task ?? '',
        status: 'failed' as const,
        summary: t?.result || '任务失败（未产出报告）',
        artifacts: [],
        report: t?.result || '任务失败（未产出报告）',
      };
    });
    return this.runGate(reports);
  }

  /** 门禁：子 Agent 准出标记 + 外部验证脚本 */
  private async runGate(reports: AgentReport[]): Promise<{
    reports: AgentReport[];
    gatePassed: boolean;
    gateFailures: string[];
  }> {
    const failures: string[] = [];
    for (const r of reports) {
      if (r.status !== 'passed') {
        failures.push(`${r.taskId}: Agent 未准出 (${r.status})`);
        continue;
      }
      if (this.opts.gateVerify) {
        try {
          const v = await this.opts.gateVerify(r);
          if (!v.ok) failures.push(`${r.taskId}: ${v.reason || '门禁未通过'}`);
          r.gatePassed = v.ok;
          r.gateReason = v.reason;
        } catch (e: any) {
          failures.push(`${r.taskId}: 门禁脚本异常 ${e.message}`);
          r.gatePassed = false;
        }
      } else {
        r.gatePassed = true;
      }
    }
    return { reports, gatePassed: failures.length === 0, gateFailures: failures };
  }

  /** 等待全部任务到达终态，返回汇总（带超时保护，默认 10 分钟） */
  async waitAll(timeoutMs: number = 600_000): Promise<{ passed: boolean; summary: string; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    while (this.hasActiveWork()) {
      if (Date.now() > deadline) {
        // 超时：强制标记所有 pending/running 为 failed
        for (const t of this.tasks.values()) {
          if (t.status === 'pending' || t.status === 'running') {
            t.status = 'failed';
            t.result = '调度超时';
          }
        }
        const s = this.buildSummary();
        return { ...s, timedOut: true };
      }
      await new Promise((r) => setTimeout(r, 300));
      this.tryRunReady();
    }
    const s = this.buildSummary();
    return { ...s, timedOut: false };
  }

  private hasActiveWork(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status === 'pending' || t.status === 'running') return true;
    }
    return false;
  }

  private readyTasks(): TaskNode[] {
    const result: TaskNode[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'pending') continue;
      // 依赖失败或缺失 → 本任务级联失败
      const depFailed = t.dependsOn.some((d) => {
        const dep = this.tasks.get(d);
        return !dep || dep.status === 'failed';
      });
      if (depFailed) {
        t.status = 'failed';
        t.result = `依赖任务失败或不存在，级联失败`;
        this.opts.emit({ type: 'agent_finish', agentId: t.id, agentRole: t.role, status: 'failed', error: t.result });
        continue;
      }
      if (t.dependsOn.every((d) => this.tasks.get(d)?.status === 'passed')) {
        result.push(t);
      }
    }
    return result;
  }

  private tryRunReady() {
    while (this.running < this.maxParallel) {
      const ready = this.readyTasks();
      if (ready.length === 0) break;
      const next = ready.find((t) => {
        const limit = ROLE_POOL[t.role].parallelLimit;
        if (limit === undefined) return true;
        const sameRoleRunning = [...this.tasks.values()].filter(
          (x) => x.role === t.role && x.status === 'running',
        ).length;
        return sameRoleRunning < limit;
      });
      if (!next) break;
      this.runTask(next);
    }
  }

  private async runTask(node: TaskNode) {
    node.status = 'running';
    this.running++;
    try {
      const role = ROLE_POOL[node.role];
      const tools = buildRoleTools(role, this.opts.sandbox);
      const nsSessionId = `${this.opts.sessionId}:${node.id}`;

      const ctxManager = this.opts.embeddingProvider
        ? new ContextManager({
            sessionId: nsSessionId,
            embeddingProvider: this.opts.embeddingProvider,
            apiKey: this.opts.apiKey,
            enableVector: false,
          })
        : null;
      // 预留：子任务上下文管理器（后续接入向量检索时启用）
      void ctxManager;

      const sequence = await getNextSequence(nsSessionId);
      const stream = runAgent({
        input: {
          sandbox: this.opts.sandbox,
          sessionId: nsSessionId,
          startSequence: sequence,
          sandboxCreated: false,
          meta: {},
        },
        messages: [{ role: 'user', content: node.task }],
        systemPrompt: role.systemPrompt,
        tools,
        context: {
          onPersist: () => {},
          onFinish: () => {},
        },
        apiKey: this.opts.apiKey,
        agentId: node.id,
        agentRole: node.role,
        // 子 Agent 生命周期 hooks：onComplete 记录验收结果供门禁判定
        hooks: {
          onComplete: async ({ summary }) => {
            const report: AgentReport = {
              taskId: node.id,
              role: node.role,
              task: node.task,
              // 成功路径恒 passed：onComplete 仅在成功流结束时调用（异常走 catch 兜底）；
              // 若任务已被外部标记 failed（如 waitFor 超时），则如实记录 failed，避免覆盖为 passed
              status: node.status === 'failed' ? 'failed' : 'passed',
              summary: summary.slice(0, 200),
              artifacts: [],
              report: summary,
            };
            this.agentStates.set(node.id, report);
            node.result = `任务 ${node.id} 完成: ${summary.slice(0, 200)}`;
          },
          onError: ({ error }) => {
            console.error(`[orchestrator] ${node.id} 出错:`, error.message);
          },
        },
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            this.opts.emit(data);
          } catch {
            // 注释行/非 JSON 忽略
          }
        }
      }

      // 若已被 waitFor 超时标记为 failed，则不翻转（防止超时后后台完成写 passed）
      if ((node as { status: TaskStatus }).status === 'failed') {
        this.opts.emit({ type: 'agent_finish', agentId: node.id, agentRole: node.role, status: 'failed', error: node.result || '调度超时' });
        return;
      }
      node.status = 'passed';
      // 若 hooks.onComplete 已写入验收结果则保留，否则给默认值
      node.result = node.result || `任务 ${node.id} 完成`;
      this.opts.emit({ type: 'agent_finish', agentId: node.id, agentRole: node.role, status: 'passed' });
    } catch (e: any) {
      if (node.retries < this.maxRetries) {
        node.retries++;
        node.status = 'pending';
        console.warn(`[orchestrator] ${node.id} 第 ${node.retries} 次重试: ${e.message}`);
        // 重新调度
        this.tryRunReady();
      } else {
        node.status = 'failed';
        node.result = e.message || '执行失败';
        // 兜底：异常路径也写报告（避免 dispatchBatch 拿不到）
        if (!this.agentStates.has(node.id)) {
          this.agentStates.set(node.id, {
            taskId: node.id,
            role: node.role,
            task: node.task,
            status: 'failed',
            summary: node.result || '执行失败',
            artifacts: [],
            report: node.result || '执行失败',
          });
        }
        this.opts.emit({ type: 'agent_finish', agentId: node.id, agentRole: node.role, status: 'failed', error: node.result });
      }
    } finally {
      this.running--;
      this.tryRunReady();
    }
  }

  private buildSummary() {
    const all = [...this.tasks.values()];
    const failed = all.filter((t) => t.status === 'failed');
    return {
      passed: failed.length === 0 && all.length > 0,
      summary: all
        .map((t) => `${t.id} [${t.role}] ${t.status}${t.result ? `: ${t.result.slice(0, 120)}` : ''}`)
        .join('\n'),
    };
  }
}
