'use client';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import SandboxPanel from '@/components/sandbox-panel';
import SessionSidebar from '@/components/session-sidebar';
import ApiKeySettings from '@/components/api-key-settings';
import LogPanel from '@/components/log-panel';
import AgentStatusBar, { AgentStatus } from '@/components/agent-status-bar';
import { apiFetch } from '@/lib/api';
import { Wrench, CheckCircle2, XCircle, ChevronDown, ChevronRight, Loader2, User, Bot } from 'lucide-react';

// ── 类型 ──

interface LogEntry {
  time: string;
  text: string;
  type: 'info' | 'tool' | 'error';
}

interface TerminalLine {
  time: string;
  text: string;
  type: 'stdout' | 'stderr' | 'info';
}

interface ActivityEntry {
  time: string;
  type: 'user' | 'text' | 'tool_call' | 'tool_result' | 'tool_error' | 'step' | 'step_finish' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  stepIndex?: number;
  finishReason?: string;
  error?: string;
}

interface ToolItem {
  key: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

interface BubbleItem {
  type: 'text' | 'tool';
  content?: string;
  tool?: ToolItem;
}

interface ChatBubble {
  role: 'user' | 'assistant';
  time: string;
  items: BubbleItem[];
}

interface VirtuosoItem {
  type: 'bubble' | 'loading' | 'done';
  bubble?: ChatBubble;
  bubbleIndex?: number;
}

interface SessionItem {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

// ── 工具卡片渲染（提取为独立组件以避免重渲染）──

function ToolCard({
  tool,
  expandedTools,
  onToggle,
}: {
  tool: ToolItem;
  expandedTools: Set<string>;
  onToggle: (key: string) => void;
}) {
  const isExpanded = expandedTools.has(tool.key);
  const ok =
    typeof tool.result === 'object' &&
    tool.result !== null &&
    (tool.result as Record<string, unknown>)?.success === true;
  const hasError = !!tool.error;

  const displayArgs = tool.args ? { ...tool.args } : undefined;
  if (displayArgs && tool.name === 'write_file' && typeof displayArgs.content === 'string') {
    const c = displayArgs.content as string;
    if (c.length > 200) {
      displayArgs.content = c.slice(0, 200) + `... (共 ${c.length} 字符)`;
    }
  }

  return (
    <div className="rounded border border-blue-200 bg-blue-50/50 overflow-hidden my-1">
      <button
        onClick={() => onToggle(tool.key)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-blue-100/50 transition-colors"
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className="text-blue-500" />
        <span className="font-mono font-medium text-blue-700">{tool.name}</span>
        {hasError ? (
          <XCircle size={12} className="text-red-500 ml-auto" />
        ) : tool.result !== undefined ? (
          ok ? (
            <CheckCircle2 size={12} className="text-green-500 ml-auto" />
          ) : (
            <XCircle size={12} className="text-orange-500 ml-auto" />
          )
        ) : (
          <Loader2 size={12} className="text-blue-400 animate-spin ml-auto" />
        )}
      </button>
      {isExpanded && displayArgs && (
        <div className="px-3 pb-2">
          <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap break-all bg-white/50 rounded p-1.5 border border-blue-100">
            {JSON.stringify(displayArgs, null, 2)}
          </pre>
          {tool.result !== undefined && (
            <div
              className={`mt-1 text-xs px-1.5 py-0.5 rounded ${
                ok ? 'text-green-700 bg-green-50' : 'text-orange-700 bg-orange-50'
              }`}
            >
              {typeof tool.result === 'string'
                ? tool.result.slice(0, 500)
                : JSON.stringify(tool.result).slice(0, 500)}
            </div>
          )}
          {tool.error && (
            <div className="mt-1 text-xs px-1.5 py-0.5 rounded text-red-700 bg-red-50">
              {tool.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 主组件 ──

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<string>('');
  const [summary, setSummary] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // ── 会话状态 ──
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);

  // ── API Key 状态 ──
  const [apiKey, setApiKey] = useState('');
  const [e2bApiKey, setE2bApiKey] = useState('');

  // ── 页面加载时恢复 apiKey ──
  useEffect(() => {
    const saved = localStorage.getItem('deepseekApiKey');
    if (saved) setApiKey(saved);
    const savedE2b = localStorage.getItem('e2bApiKey');
    if (savedE2b) setE2bApiKey(savedE2b);
  }, []);

  // ── apiKey 变化时持久化 ──
  useEffect(() => {
    if (apiKey) localStorage.setItem('deepseekApiKey', apiKey);
    else localStorage.removeItem('deepseekApiKey');
  }, [apiKey]);

  // ── e2bApiKey 变化时持久化 ──
  useEffect(() => {
    if (e2bApiKey) localStorage.setItem('e2bApiKey', e2bApiKey);
    else localStorage.removeItem('e2bApiKey');
  }, [e2bApiKey]);

  // ── 页面加载时恢复 sessionId ──
  useEffect(() => {
    const saved = localStorage.getItem('currentSessionId');
    if (saved) {
      setSessionId(saved);
      loadHistory(saved);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── sessionId 变化时持久化到 localStorage ──
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem('currentSessionId', sessionId);
    } else {
      localStorage.removeItem('currentSessionId');
    }
  }, [sessionId]);

  // ── 从 DB 加载历史消息 → 转换为 activity ──
  const loadHistory = useCallback(async (sid: string) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sid}/messages`);
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      const msgs: Array<{
        type: string;
        content?: string;
        metadata?: Record<string, unknown>;
        step_index?: number;
        created_at: string;
      }> = data.messages;

      const entries: ActivityEntry[] = msgs.map((m) => ({
        time: new Date(m.created_at).toLocaleTimeString(),
        type: m.type as ActivityEntry['type'],
        content: m.content,
        toolName: m.metadata?.toolName as string | undefined,
        toolArgs: m.metadata?.toolArgs as Record<string, unknown> | undefined,
        toolResult: m.metadata?.toolResult,
        stepIndex: (m.step_index ?? m.metadata?.stepIndex) as number | undefined,
        finishReason: m.metadata?.finishReason as string | undefined,
        error: m.metadata?.error as string | undefined,
      }));

      setActivity(entries);
      setSessionId(sid);
      setExpandedTools(new Set());

      // 从会话记录恢复关联的沙箱（刷新页面后沙箱 ID 只存在 DB 里）
      // Drizzle 返回 camelCase: sandboxId（DB 列名 sandbox_id）
      // 注意：无绑定值时显式清空，避免残留上一个会话的沙箱 ID
      const sbId = data.session?.sandboxId as string | undefined;
      setSandboxId(sbId ?? null);
      setSandboxStatus(sbId ? '已恢复' : '');
    } catch (e) {
      console.error('加载历史失败', e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // ── 会话操作 ──
  const handleSessionSelect = useCallback(
    (s: SessionItem) => {
      loadHistory(s.id);
    },
    [loadHistory],
  );

  const handleSessionNew = useCallback(() => {
    setActivity([]);
    setSessionId(null);
    setSandboxId(null);
    setSandboxStatus('');
    setSummary('');
    setLogs([]);
    setTerminalLines([]);
    setExpandedTools(new Set());
  }, []);

  const handleSessionDelete = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/sessions?id=${id}`, { method: 'DELETE' });
        if (sessionId === id) handleSessionNew();
        setSidebarRefreshKey((k) => k + 1); // 触发侧栏刷新
      } catch (e) {
        console.error('删除失败', e);
      }
    },
    [sessionId, handleSessionNew],
  );

  // ── 将 activity 转换为聊天气泡 ──
  const bubbles = useMemo<ChatBubble[]>(() => {
    const result: ChatBubble[] = [];
    let currentBubble: ChatBubble | null = null;
    let toolCallIdx = 0;

    for (const entry of activity) {
      if (entry.type === 'user') {
        if (currentBubble) {
          result.push(currentBubble);
          currentBubble = null;
        }
        result.push({
          role: 'user',
          time: entry.time,
          items: [{ type: 'text', content: entry.content }],
        });
        continue;
      }

      if (entry.type === 'step') {
        if (currentBubble) result.push(currentBubble);
        currentBubble = { role: 'assistant', time: entry.time, items: [] };
        continue;
      }

      if (entry.type === 'step_finish' || entry.type === 'done' || entry.type === 'error') {
        if (currentBubble) {
          result.push(currentBubble);
          currentBubble = null;
        }
        continue;
      }

      if (!currentBubble) continue;

      if (entry.type === 'text') {
        const lastItem = currentBubble.items[currentBubble.items.length - 1];
        if (lastItem?.type === 'text') {
          lastItem.content = (lastItem.content || '') + (entry.content || '');
        } else {
          currentBubble.items.push({ type: 'text', content: entry.content });
        }
        continue;
      }

      if (entry.type === 'tool_call') {
        const key = `tool-${toolCallIdx++}`;
        currentBubble.items.push({
          type: 'tool',
          tool: { key, name: entry.toolName || '未知工具', args: entry.toolArgs },
        });
        continue;
      }

      if (entry.type === 'tool_result') {
        for (let i = currentBubble.items.length - 1; i >= 0; i--) {
          const item = currentBubble.items[i];
          if (item.type === 'tool' && item.tool && !item.tool.result && !item.tool.error) {
            item.tool.result = entry.toolResult;
            break;
          }
        }
        continue;
      }

      if (entry.type === 'tool_error') {
        for (let i = currentBubble.items.length - 1; i >= 0; i--) {
          const item = currentBubble.items[i];
          if (item.type === 'tool' && item.tool && !item.tool.result && !item.tool.error) {
            item.tool.error = entry.error;
            break;
          }
        }
        continue;
      }
    }

    if (currentBubble) result.push(currentBubble);
    return result;
  }, [activity]);

  // ── Virtuoso 数据列表 ──
  const virtuosoData = useMemo<VirtuosoItem[]>(() => {
    const items: VirtuosoItem[] = bubbles.map((b, i) => ({
      type: 'bubble' as const,
      bubble: b,
      bubbleIndex: i,
    }));
    if (loading) items.push({ type: 'loading' });
    else if (bubbles.length > 0) items.push({ type: 'done' });
    return items;
  }, [bubbles, loading]);

  const addTerminal = (text: string, type: TerminalLine['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setTerminalLines((prev) => [...prev.slice(-500), { time, text, type }]);
  };

  const addLog = (text: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-200), { time, text, type }]);
  };

  const addActivity = (entry: Omit<ActivityEntry, 'time'>) => {
    const time = new Date().toLocaleTimeString();
    setActivity((prev) => [...prev, { time, ...entry }]);
  };

  const callApi = async (killAfter: boolean) => {
    const message = prompt.trim();
    if (!message) return;

    setLoading(true);
    setSummary('');
    setLogs([]);
    setTerminalLines([]);
    setExpandedTools(new Set());
    abortRef.current = new AbortController();

    // 清空输入框
    setPrompt('');

    // 新建会话时清空历史，复用会话时保留
    if (!sessionId) {
      setActivity([]);
    }

    // 添加用户消息
    addActivity({ type: 'user', content: message });

    try {
      const body: Record<string, unknown> = {
        prompt: message,
        action: killAfter ? 'kill' : 'pause',
      };
      if (sandboxId) body.sandboxId = sandboxId;
      if (sessionId) body.sessionId = sessionId;

      const res = await apiFetch('/api/hello', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        addLog(`HTTP ${res.status}: ${err.error || '未知错误'}`, 'error');
        setLoading(false);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));

            switch (event.type) {
              case 'agent_start': {
                setAgentStatuses((prev) => [
                  ...prev.filter((a) => a.agentId !== event.agentId),
                  { agentId: event.agentId, agentRole: event.agentRole, status: 'running', task: event.task },
                ]);
                addLog(`🚀 子 Agent 启动: ${event.agentId} (${event.agentRole})`, 'info');
                break;
              }
              case 'agent_finish': {
                setAgentStatuses((prev) =>
                  prev.map((a) =>
                    a.agentId === event.agentId
                      ? { ...a, status: event.status === 'failed' ? 'failed' : 'passed' }
                      : a,
                  ),
                );
                addLog(`🏁 子 Agent 结束: ${event.agentId} → ${event.status}`, event.status === 'failed' ? 'error' : 'info');
                break;
              }

              case 'init':
                setSandboxId(event.sandboxId);
                setSandboxStatus(event.sandboxCreated ? '新创建' : '已恢复');
                if (event.sessionId) setSessionId(event.sessionId);
                addLog(
                  `🟢 沙箱 ${event.sandboxId?.slice(0, 12)}... ${event.sandboxCreated ? '已创建' : '已连接'}`,
                  'info',
                );
                break;

              case 'text':
                addActivity({ type: 'text', content: event.content });
                break;

              case 'tool_call':
                addActivity({ type: 'tool_call', toolName: event.toolName, toolArgs: event.args });
                addLog(`🔧 ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)})`, 'tool');
                if (event.toolName === 'execute_command' && event.args?.command) {
                  addTerminal(`$ ${event.args.command}`, 'info');
                }
                break;

              case 'tool_result': {
                const ok =
                  typeof event.result === 'object' && event.result?.success === true;
                addActivity({
                  type: 'tool_result',
                  toolName: event.toolName,
                  toolResult: event.result,
                });
                const resultStr =
                  typeof event.result === 'string'
                    ? event.result.slice(0, 120)
                    : JSON.stringify(event.result).slice(0, 120);
                addLog(`${ok ? '✅' : '⚠️'} ${event.toolName}: ${resultStr}`, ok ? 'info' : 'error');

                if (event.toolName === 'execute_command' && typeof event.result === 'object') {
                  if (event.result?.stdout && event.result.stdout !== '(无输出)') {
                    addTerminal(event.result.stdout, 'stdout');
                  }
                  if (event.result?.stderr && event.result.stderr !== '(无错误)') {
                    addTerminal(event.result.stderr, 'stderr');
                  }
                  const exitCode = event.result?.exitCode;
                  if (exitCode !== undefined) {
                    addTerminal(`[exit code: ${exitCode}]`, exitCode === 0 ? 'info' : 'stderr');
                  }
                }
                break;
              }

              case 'tool_error':
                addActivity({
                  type: 'tool_error',
                  toolName: event.toolName,
                  error: event.error,
                });
                addLog(`❌ ${event.toolName}: ${event.error}`, 'error');
                break;

              case 'step_start':
                addActivity({ type: 'step', stepIndex: event.index });
                addLog(`── 步骤 ${event.index} ──`, 'info');
                break;

              case 'step_finish':
                addActivity({
                  type: 'step_finish',
                  stepIndex: event.index,
                  finishReason: event.finishReason,
                });
                addLog(`步骤 ${event.index} 完成 (${event.finishReason})`, 'info');
                break;

              case 'done':
                addActivity({ type: 'done', finishReason: event.finishReason });
                addLog(`🏁 完成 (${event.finishReason})`, 'info');
                setSummary(`完成 (${event.finishReason})`);
                break;

              case 'error':
                addActivity({ type: 'error', error: event.error });
                addLog(`💥 ${event.error}`, 'error');
                break;
            }
          } catch {
            // 跳过非 JSON 行
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '未知错误';
      if (
        err &&
        typeof err === 'object' &&
        'name' in err &&
        (err as Error).name !== 'AbortError'
      ) {
        addLog(`网络错误: ${msg}`, 'error');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const killSandbox = async () => {
    if (!sandboxId) return;
    setLoading(true);
    try {
      await apiFetch('/api/hello', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'echo ok', sandboxId, action: 'kill' }),
      });
      setSandboxId(null);
      setSandboxStatus('已销毁');
      addLog('🔴 沙箱已销毁', 'info');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '未知错误';
      setSandboxStatus('销毁失败: ' + msg);
    } finally {
      setLoading(false);
    }
  };

  const stopAgent = () => {
    abortRef.current?.abort();
    setLoading(false);
    addLog('⏹ 用户中止', 'info');
  };

  // ── Virtuoso item 渲染 ──
  const renderVirtuosoItem = useCallback(
    (_index: number, item: VirtuosoItem) => {
      if (item.type === 'loading') {
        return (
          <div className="flex gap-2 justify-start px-3 py-2">
            <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center">
              <Bot size={14} className="text-white" />
            </div>
            <div className="bg-gray-100 rounded-2xl rounded-bl-md px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-blue-500">
                <Loader2 size={12} className="animate-spin" />
                执行中...
              </div>
            </div>
          </div>
        );
      }

      if (item.type === 'done') {
        return (
          <div className="flex items-center gap-2 pt-1 pb-2 px-3">
            <div className="flex-1 h-px bg-green-200" />
            <span className="text-xs text-green-600 font-medium flex items-center gap-1">
              <CheckCircle2 size={12} />
              完成
            </span>
            <div className="flex-1 h-px bg-green-200" />
          </div>
        );
      }

      // type === 'bubble'
      const bubble = item.bubble!;
      return (
        <div
          className={`flex gap-2 px-3 py-1 ${
            bubble.role === 'user' ? 'justify-end' : 'justify-start'
          }`}
        >
          {bubble.role === 'assistant' && (
            <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center mt-0.5">
              <Bot size={14} className="text-white" />
            </div>
          )}
          <div
            className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
              bubble.role === 'user'
                ? 'bg-blue-500 text-white rounded-br-md'
                : 'bg-gray-100 text-gray-800 rounded-bl-md'
            }`}
          >
            {bubble.items.map((bi, ii) => {
              if (bi.type === 'text') {
                return (
                  <div key={ii} className="whitespace-pre-wrap break-words">
                    {bi.content}
                  </div>
                );
              }
              if (bi.type === 'tool' && bi.tool) {
                return (
                  <ToolCard
                    key={bi.tool.key}
                    tool={bi.tool}
                    expandedTools={expandedTools}
                    onToggle={(key) => {
                      const next = new Set(expandedTools);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      setExpandedTools(next);
                    }}
                  />
                );
              }
              return null;
            })}
          </div>
          {bubble.role === 'user' && (
            <div className="shrink-0 w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center mt-0.5">
              <User size={14} className="text-gray-600" />
            </div>
          )}
        </div>
      );
    },
    [expandedTools],
  );

  return (
    <main className="h-screen flex flex-col">
      {/* 顶部状态栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b text-sm bg-white shrink-0">
        <span className="font-bold text-gray-700">Coding Agent</span>
        <span className="text-gray-300">|</span>
        <span className="text-gray-500">沙箱:</span>
        {sandboxId ? (
          <>
            <code className="bg-green-100 text-green-800 px-1.5 py-0.5 rounded text-xs">
              {sandboxId.slice(0, 12)}...
            </code>
            <span className="text-gray-400 text-xs">{sandboxStatus}</span>
          </>
        ) : (
          <span className="text-gray-400 text-xs">无活跃沙箱</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {sandboxId && (
            <button
              onClick={killSandbox}
              disabled={loading}
              className="px-2 py-0.5 bg-red-100 text-red-600 rounded text-xs hover:bg-red-200 disabled:opacity-50"
            >
              销毁
            </button>
          )}
          <ApiKeySettings
            apiKey={apiKey}
            e2bApiKey={e2bApiKey}
            onSave={(k, e2bK) => {
              setApiKey(k);
              setE2bApiKey(e2bK);
            }}
          />
        </span>
      </div>

      {/* 子 Agent 状态栏 */}
      <AgentStatusBar agents={agentStatuses} />

      {/* 主体：会话侧栏 + 聊天区 + 面板 + 日志 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 会话侧栏 */}
        <SessionSidebar
          currentSessionId={sessionId}
          onSelect={handleSessionSelect}
          onNew={handleSessionNew}
          onDelete={handleSessionDelete}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          refreshKey={sidebarRefreshKey}
        />

        {/* 聊天区 — 使用 Virtuoso 虚拟滚动 */}
        <div className="w-1/3 flex flex-col min-w-0 border-r">
          <div className="flex-1">
            {historyLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={24} className="animate-spin text-gray-400" />
              </div>
            ) : virtuosoData.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-gray-300 text-sm italic">
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 size={16} className="animate-spin" />
                      Agent 思考中...
                    </span>
                  ) : (
                    '输入任务后点击发送'
                  )}
                </p>
              </div>
            ) : (
              <Virtuoso
                ref={virtuosoRef}
                data={virtuosoData}
                itemContent={renderVirtuosoItem}
                followOutput="auto"
                atBottomThreshold={120}
                className="h-full"
              />
            )}
          </div>

          {/* 底部输入区 */}
          <div className="border-t p-3 bg-gray-50 shrink-0">
            <textarea
              className="w-full border rounded p-2 text-sm resize-none"
              rows={3}
              placeholder="输入任务描述，Enter 发送，Shift+Enter 换行"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!loading) callApi(false);
                }
              }}
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => callApi(false)}
                disabled={loading || !prompt.trim()}
                className="px-4 py-1.5 bg-blue-500 text-white rounded text-sm disabled:opacity-50 hover:bg-blue-600"
              >
                {loading ? '执行中...' : '发送'}
              </button>
              <button
                onClick={() => callApi(true)}
                disabled={loading || !prompt.trim()}
                className="px-4 py-1.5 bg-orange-500 text-white rounded text-sm disabled:opacity-50 hover:bg-orange-600"
              >
                发送后销毁
              </button>
              {loading && (
                <button
                  onClick={stopAgent}
                  className="px-4 py-1.5 bg-red-500 text-white rounded text-sm hover:bg-red-600"
                >
                  中止
                </button>
              )}
              <span className="text-xs text-gray-400 ml-auto">{summary}</span>
            </div>
          </div>
        </div>

        {/* 可视化面板 */}
        <div className="w-1/3 border-r">
          <SandboxPanel sandboxId={sandboxId} terminalLines={terminalLines} />
        </div>

        {/* 日志看板（模型执行日志 + 系统日志） */}
        <LogPanel modelLogs={logs} />
      </div>
    </main>
  );
}
