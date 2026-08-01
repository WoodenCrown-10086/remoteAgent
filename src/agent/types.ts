import type { Sandbox } from '@e2b/code-interpreter';

// ── SSE 事件类型（前后端共享）──

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

// ── Agent 配置 ──

export interface AgentConfig {
  /** Agent 角色名称，用于日志 */
  name: string;
  /** System Prompt */
  systemPrompt: string;
  /** AI SDK 工具集 */
  tools: Record<string, any>;
  /** 最大步数 */
  maxSteps?: number;
  /** 模型标识 */
  modelId?: string;
}

// ── Agent 运行输入 ──

export interface AgentRunInput {
  /** 沙箱实例 */
  sandbox: Sandbox;
  /** 会话 ID */
  sessionId: string;
  /** 全局消息序列起始值 */
  startSequence: number;
  /** 沙箱是否本次新建 */
  sandboxCreated: boolean;
  /** 初始元信息（注入到 init 事件） */
  meta?: Record<string, unknown>;
}

// ── 流上下文（回调钩子）──

export interface StreamContext {
  /** 每条 SSE 事件持久化回调 */
  onPersist: (data: SSEEvent, sequence: number) => void | Promise<void>;
  /** Agent 完成回调 */
  onFinish?: (status: 'done' | 'error', sandboxId: string | undefined) => void | Promise<void>;
}

// ── 持久化消息输入 ──

export interface PersistMessageInput {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  type: string;
  content?: string;
  metadata?: Record<string, unknown>;
  stepIndex?: number;
  sequence: number;
  sandboxId?: string;
}

// ── 消息类型映射（SSE 事件 → 统一消息类型）──

export const EVENT_TYPE_MAP: Record<string, string> = {
  step_start: 'step',
  step_finish: 'step_finish',
  text: 'text',
  tool_call: 'tool_call',
  tool_result: 'tool_result',
  tool_error: 'tool_error',
  done: 'done',
  error: 'error',
};

// ── 工县工厂类型 ──

export type ToolFactory = (sandbox: Sandbox) => any;
