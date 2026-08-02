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

export interface OrchestratorOpts {
  sandbox: Sandbox;
  sessionId: string;
  apiKey?: string;
  embeddingProvider?: EmbeddingProvider;
  maxParallel?: number;
  maxRetries?: number;
  /** 事件发射器（子 Agent 生命周期事件转发到 SSE） */
  emit: (data: Record<string, unknown>) => void;
}

export class Orchestrator {
  private tasks = new Map<string, TaskNode>();
  private running = 0;
  private maxParallel: number;
  private maxRetries: number;
  private seqCounter = 0;

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

      node.status = 'passed';
      node.result = `任务 ${node.id} 完成`;
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
