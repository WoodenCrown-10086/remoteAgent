import { runAgent } from './runner';
import type { AgentRoleName } from './roles';
import { ROLE_POOL, buildRoleTools } from './roles';
import type { EmbeddingProvider } from './memory/types';
import { ContextManager } from './memory/context-manager';
import type { Sandbox } from '@e2b/code-interpreter';
import { getNextSequence } from '@/db/db';
import { loadSkills, formatSkillList, buildSkillUsageSection } from './skills';
import { createReportArtifactTool } from './tools/report-artifact';
import { createReportSkillGapTool } from './tools/report-skill-gap';

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
  /** 子 Agent 声明缺失的 skill（能力不足，任务未完成） */
  missingSkills?: string[];
  report: string;
  gatePassed?: boolean;
  gateReason?: string;
}

/** 多 planner 交叉评分选优的结果 */
export interface PlanConsensusResult {
  /** 平均分最高的最终方案 */
  plan: string;
  /** 该方案的平均分 */
  score: number;
  /** 全部候选方案及其平均分 */
  candidates: Array<{ id: string; plan: string; score: number }>;
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

  /**
   * 首次规划：并行派 3 个 planner 独立出方案 → 交叉评分 → 选平均分最高的方案。
   * 后续 loop 里的规划不调用此方法，只派 1 个 planner（复用已选方案微调）。
   */
  async planWithConsensus(task: string): Promise<PlanConsensusResult> {
    // 1. 3 个 planner 并行独立生成候选方案
    const gen = await this.dispatchBatch(
      'planner',
      [
        { id: 'planner-1', task: buildPlannerGenTask(task) },
        { id: 'planner-2', task: buildPlannerGenTask(task) },
        { id: 'planner-3', task: buildPlannerGenTask(task) },
      ],
      [],
    );

    const candidates = gen.reports
      .map((r) => ({ id: r.taskId, plan: (r.report || r.summary || '').trim() }))
      .filter((c) => c.plan.length > 0);

    if (candidates.length === 0) {
      return { plan: '', score: 0, candidates: [] };
    }
    if (candidates.length === 1) {
      return {
        plan: candidates[0].plan,
        score: 0,
        candidates: [{ ...candidates[0], score: 0 }],
      };
    }

    // 2. 交叉评分：每个候选由「其余候选的作者视角」打分（各候选互评）
    const scoreMap = new Map<string, number[]>();
    for (const c of candidates) scoreMap.set(c.id, []);

    const scoreTasks = candidates.map((_, i) => {
      const others = candidates.filter((__, j) => j !== i);
      return { id: `score-${i}`, task: buildScoringTask(others) };
    });

    const scoreReports = await this.dispatchBatch('planner', scoreTasks, []);

    // 3. 解析评分结果
    for (const r of scoreReports.reports) {
      const text = r.report || r.summary || '';
      for (const [id, s] of parseScores(text)) {
        const list = scoreMap.get(id);
        if (list) list.push(s);
      }
    }

    // 4. 计算每个候选的平均分，选最高
    const scored = candidates.map((c) => {
      const list = scoreMap.get(c.id) || [];
      const score = list.length
        ? list.reduce((a, b) => a + b, 0) / list.length
        : 0;
      return { id: c.id, plan: c.plan, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    return { plan: best.plan, score: best.score, candidates: scored };
  }

  /** 门禁：子 Agent 准出标记 + 外部验证脚本 */
  private async runGate(reports: AgentReport[]): Promise<{
    reports: AgentReport[];
    gatePassed: boolean;
    gateFailures: string[];
  }> {
    const failures: string[] = [];
    for (const r of reports) {
      if (r.missingSkills && r.missingSkills.length > 0) {
        failures.push(`${r.taskId}: 缺少 skill（需要: ${r.missingSkills.join(', ')}），任务未完成`);
        r.gatePassed = false;
        continue;
      }
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
    const artifacts: string[] = [];
    const missingSkills: string[] = [];
    try {
      const role = ROLE_POOL[node.role];
      let systemPrompt = role.systemPrompt;
      let tools = buildRoleTools(role, this.opts.sandbox);

      // 所有子 Agent：统一注入 skill 段（列表 + 靠分发规则）+ report_skill_gap（缺能力上报）
      const skills = await loadSkills();
      systemPrompt += buildSkillUsageSection(formatSkillList(skills));
      tools = {
        ...tools,
        report_skill_gap: createReportSkillGapTool((gaps) => {
          for (const g of gaps) missingSkills.push(g);
        }),
      };

      // coder 额外：注入产物声明工具（准出门禁校验产物真实存在）
      if (role.role === 'coder') {
        tools = {
          ...tools,
          report_artifact: createReportArtifactTool((paths) => {
            for (const p of paths) artifacts.push(p);
          }),
        };
      }

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
        systemPrompt,
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
            const incomplete = missingSkills.length > 0;
            const report: AgentReport = {
              taskId: node.id,
              role: node.role,
              task: node.task,
              // 缺 skill 或外部标记 failed 时如实记录 failed，避免覆盖为 passed
              status: incomplete || node.status === 'failed' ? 'failed' : 'passed',
              summary: summary.slice(0, 200),
              artifacts: [...artifacts],
              missingSkills: [...missingSkills],
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

// ── 多 planner 选优辅助 ──

/** 独立规划任务：要求 planner 完全独立产出，不参考他人 */
function buildPlannerGenTask(task: string): string {
  return `你是独立的规划者。请针对以下需求独立给出一个完整、可执行的实施计划，不要参考或猜测他人的方案，完全基于自己的判断。\n\n需求：\n${task}\n\n按规划者输出格式给出计划（任务标题、子任务列表、执行顺序、关键决策点）。`;
}

/** 交叉评分任务：让一个「作者视角」给其余候选方案打分 */
function buildScoringTask(others: Array<{ id: string; plan: string }>): string {
  const blocks = others.map((o) => `候选 ${o.id} 的方案：\n${o.plan}`).join('\n\n');
  const fmt = others.map((o) => `${o.id}: <分数>`).join('\n');
  return `你是规划评审员。请给下面每个候选规划方案分别打分（0-10 的整数，10 为最优），从完整性、可行性、步骤合理性三个维度综合评估。\n\n${blocks}\n\n严格按以下格式输出（每个候选一行，只输出「候选id: 分数」）：\n${fmt}`;
}

/** 从评分文本解析「id: 分数」列表 */
function parseScores(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const re = /([a-zA-Z0-9_-]+)\s*[:：]\s*(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    const score = parseFloat(m[2]);
    if (!Number.isNaN(score) && score >= 0 && score <= 10) {
      out.push([id, score]);
    }
  }
  return out;
}
