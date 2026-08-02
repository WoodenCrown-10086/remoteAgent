// ── 服务端全局 Logger ──
//
// 拦截 console.log/info/warn/error，自动附加来源信息（模块/方法/位置），
// 写入环形缓冲并广播给 SSE 订阅者。前端通过 /api/logs 查看真实系统日志。
//
// 设计要点：
// - 拦截发生在模块首次加载（globalThis 标志防重复安装）
// - logger 内部用原始 console（origConsole），避免递归
// - 来源信息通过调用栈解析（跳过 logger 自身帧）
// - 关键：所有状态（buffer/listeners/seq/origConsole）挂在 globalThis 上，
//   防止 Turbopack 热重载后"拦截器指向旧实例、订阅者注册在新实例"的状态分裂

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
  module?: string;   // 来源文件（如 route.ts）
  method?: string;   // 来源函数
  location?: string; // file:line:col
}

const MAX_LOGS = 500;

// ── 全局状态（跨热重载共享） ──

interface LoggerState {
  seq: number;
  buffer: LogEntry[];
  listeners: Set<(entry: LogEntry) => void>;
  installed: boolean;
  origConsole: {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

const g = globalThis as unknown as { __reasonixLoggerState?: LoggerState };

const state: LoggerState =
  g.__reasonixLoggerState ||
  (g.__reasonixLoggerState = {
    seq: 0,
    buffer: [],
    listeners: new Set(),
    installed: false,
    origConsole: {
      // 首次加载时保存原始 console（热重载后仍指向最原始版本，避免透传递归）
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    },
  });

/** 从调用栈解析来源（跳过 logger 自身与 node_modules） */
function getCaller(): { module?: string; method?: string; location?: string } {
  try {
    const stack = new Error().stack?.split('\n').slice(2) || [];
    for (const line of stack) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('at ')) {
        // 形如: at method (file:///.../route.ts:12:34) 或 at file:///.../route.ts:12:34
        const match = trimmed.match(/at (?:(\S+) \()?(?:file:\/\/\/)?(.+?\.(?:ts|tsx|js|mjs)):(\d+):(\d+)\)?$/);
        if (!match) continue;
        const [, method, file, line, col] = match;
        // 跳过 logger 自身
        if (file.includes('logger.ts')) continue;
        const module = file.split(/[\\/]/).pop();
        return {
          module,
          method: method && method !== '<anonymous>' ? method : undefined,
          location: `${file}:${line}:${col}`,
        };
      }
    }
  } catch {
    // 栈解析失败不阻断
  }
  return {};
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function capture(level: LogLevel, args: unknown[], origFn: (...a: unknown[]) => void) {
  const message = args.map((a) => safeStringify(a)).join(' ');
  const { module, method, location } = getCaller();

  const entry: LogEntry = {
    id: state.seq++,
    timestamp: new Date().toISOString(),
    level,
    message: message.slice(0, 4000),
    module,
    method,
    location,
  };

  // 写缓冲
  state.buffer.push(entry);
  if (state.buffer.length > MAX_LOGS) state.buffer.shift();

  // 广播
  for (const listener of state.listeners) {
    try {
      listener(entry);
    } catch {
      // 单个订阅者异常不影响其他
    }
  }

  // 透传到真实 console（保持终端输出）
  origFn(...args);
}

// ── 安装拦截（幂等，状态全局化） ──

if (!state.installed) {
  state.installed = true;
  console.log = (...args) => capture('info', args, state.origConsole.log);
  console.info = (...args) => capture('info', args, state.origConsole.info);
  console.debug = (...args) => capture('debug', args, state.origConsole.debug);
  console.warn = (...args) => capture('warn', args, state.origConsole.warn);
  console.error = (...args) => capture('error', args, state.origConsole.error);
}

// ── 对外 API ──

/** 获取指定 id 之后的日志（历史拉取） */
export function getLogsSince(afterId: number): LogEntry[] {
  return state.buffer.filter((e) => e.id > afterId);
}

/** 获取最近 N 条 */
export function getRecentLogs(n: number = 100): LogEntry[] {
  return state.buffer.slice(-n);
}

/** 订阅实时日志，返回取消函数 */
export function subscribeLogs(listener: (entry: LogEntry) => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** 手动记录一条日志（也走同样的缓冲/广播，但来源指向调用处） */
export function log(level: LogLevel, message: string, data?: unknown): void {
  capture(level, data === undefined ? [message] : [message, data], state.origConsole.log);
}
