'use client';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import SandboxPanel from '@/components/sandbox-panel';
import SessionSidebar from '@/components/session-sidebar';
import ApiKeySettings from '@/components/api-key-settings';
import LogPanel from '@/components/log-panel';
import RightStatusBar, { PanelKey } from '@/components/right-status-bar';
import MessageCard from '@/components/chat/message-card';
import type { MessageCardItem } from '@/components/chat/message-card';
import type { ToolCallCardProps } from '@/components/chat/tool-call-card';
import AgentStatusBar, { AgentStatus } from '@/components/agent-status-bar';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle2, Loader2, Bot, ChevronDown, Activity, X } from 'lucide-react';

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
  type: 'user' | 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'tool_error' | 'step' | 'step_finish' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  stepIndex?: number;
  finishReason?: string;
  error?: string;
}

interface ChatBubble {
  role: 'user' | 'assistant';
  time: string;
  items: MessageCardItem[];
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

// ── 主组件（纯 CSR：由 page.tsx 通过 dynamic ssr:false 加载） ──

export default function AgentApp() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<string>('');
  const [summary, setSummary] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // reasoning 流式累积（reasoning_start → delta → end 拼成完整思考）
  const reasoningRef = useRef('');
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // 是否在聊天区底部（用户滚动离开底部时显示"回到底部"箭头）
  const [atBottom, setAtBottom] = useState(true);

  // 强制回到底部（进入会话/点击箭头）
  const scrollToBottom = useCallback(() => {
    // Virtuoso 支持 index: 'LAST' 定位最后一项
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      align: 'end',
      behavior: 'smooth',
    });
  }, []);

  // ── 会话状态（首渲染与 SSR 一致，挂载后从 localStorage 恢复） ──
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>([]);

  // ── API Key 状态（首渲染与 SSR 一致，挂载后恢复） ──
  const [apiKey, setApiKey] = useState('');
  const [e2bApiKey, setE2bApiKey] = useState('');

  // ── 挂载后从 localStorage 恢复 apiKey（setTimeout 保证 hydration 后执行，SSR 安全） ──
  useEffect(() => {
    const t = setTimeout(() => {
      const saved = localStorage.getItem('deepseekApiKey');
      if (saved) setApiKey(saved);
      const savedE2b = localStorage.getItem('e2bApiKey');
      if (savedE2b) setE2bApiKey(savedE2b);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // ── 右侧抽屉面板状态 ──
  const [activePanel, setActivePanel] = useState<PanelKey | null>(null);
  const handlePanelChange = useCallback((key: PanelKey) => {
    setActivePanel((prev) => (prev === key ? null : key));
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
      if (res.status === 404) {
        // 会话不存在（可能被删除/DB 重建）→ 清理失效 sessionId，友好回退
        console.warn(`[history] 会话 ${sid.slice(0, 8)} 不存在，清理本地缓存`);
        localStorage.removeItem('currentSessionId');
        setSessionId(null);
        setActivity([]);
        return;
      }
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

      // 加载历史后定位到底部（等 Virtuoso 渲染完成）
      setTimeout(() => scrollToBottom(), 80);

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
  }, [scrollToBottom]);

  // ── 会话操作 ──
  const handleSessionSelect = useCallback(
    (s: SessionItem) => {
      loadHistory(s.id);
    },
    [loadHistory],
  );

  // ── 页面加载时恢复会话（纯 CSR：组件仅在客户端渲染，可安全读 localStorage/URL） ──
  // 优先级：URL ?session=<id> > localStorage currentSessionId
  const sessionInitRef = useRef(false); // 恢复完成前禁止 URL 同步，防止误删参数
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const urlSid = params.get('session');
      const saved = urlSid || localStorage.getItem('currentSessionId');
      if (saved) {
        setSessionId(saved);
        loadHistory(saved);
      }
      sessionInitRef.current = true; // 标记初始化完成（即使无 saved）
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── sessionId 变化 → 同步 URL 参数（用户切换会话时地址栏跟着变，可分享/直达） ──
  useEffect(() => {
    if (!sessionInitRef.current) return; // 初始化完成前不动 URL，保留 ?session= 参数
    const url = new URL(window.location.href);
    if (sessionId) {
      url.searchParams.set('session', sessionId);
    } else {
      url.searchParams.delete('session');
    }
    window.history.replaceState({}, '', url.toString());
  }, [sessionId]);

  const handleSessionNew = useCallback(() => {
    setActivity([]);
    setSessionId(null);
    setSandboxId(null);
    setSandboxStatus('');
    setSummary('');
    setLogs([]);
    setTerminalLines([]);
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

  // ── 工具调用 → ToolCallCardProps 转换 ──
  const toToolCardProps = useCallback(
    (toolName: string, args?: Record<string, unknown>, result?: unknown, error?: string): ToolCallCardProps => {
      const ok = typeof result === 'object' && result !== null && (result as Record<string, unknown>)?.success === true;
      const status = error ? 'error' : result === undefined ? 'running' : ok ? 'success' : 'error';
      const resultSummary =
        error ||
        (typeof result === 'string'
          ? result.slice(0, 200)
          : typeof result === 'object' && result !== null
            ? ((result as Record<string, unknown>)?.message as string) ||
              JSON.stringify(result).slice(0, 200)
            : '');

      // 命令执行
      if (toolName === 'execute_command') {
        return {
          kind: 'command',
          toolName,
          command: (args?.command as string) || '',
          status,
          args,
          resultSummary,
        };
      }
      // 文件改动
      if (toolName === 'write_file' || toolName === 'edit_file') {
        const path = (args?.path as string) || '';
        const additions =
          toolName === 'write_file'
            ? String(args?.content || '').split('\n').length
            : String(args?.new_string || '').split('\n').length;
        const deletions =
          toolName === 'edit_file'
            ? String(args?.old_string || '').split('\n').length
            : 0;
        return {
          kind: 'file',
          toolName,
          files: [{ path, additions, deletions }],
          status,
          args,
          resultSummary,
        };
      }
      // 通用工具
      return {
        kind: 'generic',
        toolName,
        status,
        args,
        resultSummary,
      };
    },
    [],
  );

  // ── 将 activity 转换为聊天气泡 ──
  const bubbles = useMemo<ChatBubble[]>(() => {
    const result: ChatBubble[] = [];
    let currentBubble: ChatBubble | null = null;

    const pushBubble = () => {
      if (currentBubble && currentBubble.items.length > 0) {
        result.push(currentBubble);
      }
      currentBubble = null;
    };

    for (const entry of activity) {
      if (entry.type === 'user') {
        pushBubble();
        result.push({
          role: 'user',
          time: entry.time,
          items: [{ type: 'text', content: entry.content || '' }],
        });
        continue;
      }

      if (entry.type === 'step') {
        pushBubble();
        currentBubble = { role: 'assistant', time: entry.time, items: [] };
        continue;
      }

      if (entry.type === 'step_finish' || entry.type === 'done' || entry.type === 'error') {
        pushBubble();
        continue;
      }

      if (!currentBubble) continue;

      if (entry.type === 'text') {
        const lastItem = currentBubble.items[currentBubble.items.length - 1];
        if (lastItem?.type === 'text') {
          lastItem.content = (lastItem.content || '') + (entry.content || '');
        } else {
          currentBubble.items.push({ type: 'text', content: entry.content || '' });
        }
        continue;
      }

      if (entry.type === 'reasoning') {
        const lastItem = currentBubble.items[currentBubble.items.length - 1];
        if (lastItem?.type === 'reasoning') {
          lastItem.content = (lastItem.content || '') + (entry.content || '');
        } else {
          currentBubble.items.push({ type: 'reasoning', content: entry.content || '' });
        }
        continue;
      }

      if (entry.type === 'tool_call') {
        currentBubble.items.push({
          type: 'tool',
          tool: toToolCardProps(entry.toolName || 'unknown', entry.toolArgs),
        });
        continue;
      }

      if (entry.type === 'tool_result') {
        for (let i = currentBubble.items.length - 1; i >= 0; i--) {
          const item = currentBubble.items[i];
          if (item.type === 'tool' && item.tool && item.tool.status === 'running') {
            item.tool = toToolCardProps(
              item.tool.toolName || 'unknown',
              item.tool.args,
              entry.toolResult,
            );
            break;
          }
        }
        continue;
      }

      if (entry.type === 'tool_error') {
        for (let i = currentBubble.items.length - 1; i >= 0; i--) {
          const item = currentBubble.items[i];
          if (item.type === 'tool' && item.tool && item.tool.status === 'running') {
            item.tool = toToolCardProps(
              item.tool.toolName || 'unknown',
              item.tool.args,
              undefined,
              entry.error,
            );
            break;
          }
        }
        continue;
      }
    }

    pushBubble();
    return result;
  }, [activity, toToolCardProps]);

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

              case 'reasoning_start':
                reasoningRef.current = '';
                break;

              case 'reasoning_delta':
                reasoningRef.current += event.content || '';
                break;

              case 'reasoning_end': {
                const r = reasoningRef.current.trim();
                reasoningRef.current = '';
                if (r) addActivity({ type: 'reasoning', content: r });
                break;
              }

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
        <div className="px-3 py-1">
          <MessageCard role={bubble.role} items={bubble.items} time={bubble.time} />
        </div>
      );
    },
    [],
  );

  return (
    <main className="flex h-screen flex-col bg-background">
      {/* 顶部栏 */}
      <header className="flex shrink-0 items-center gap-3 border-b bg-white px-4 py-2">
        <span className="text-sm font-bold tracking-tight text-foreground">
          Coding Agent
        </span>
        {sandboxId ? (
          <Badge variant="secondary" className="gap-1.5 font-mono">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            {sandboxId.slice(0, 12)}...
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            无沙箱
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{sandboxStatus}</span>
      </header>

      {/* 主体 */}
      <div className="flex flex-1 overflow-hidden">
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

        {/* 聊天区（flex-1，右侧面板展开时被压缩） */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Chat Header — 模仿 Coze Agent Studio */}
          <div className="flex shrink-0 items-center gap-3 border-b bg-white px-4 py-3">
            <Avatar size="lg">
              <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white">
                <Bot size={18} />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  Coding Agent
                </span>
                <Badge
                  variant={sandboxId ? 'default' : 'outline'}
                  className="gap-1"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      sandboxId ? 'bg-green-400' : 'bg-gray-400'
                    }`}
                  />
                  {sandboxId ? '在线' : '离线'}
                </Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {loading ? '正在执行任务...' : sandboxStatus || '等待任务输入'}
              </p>
            </div>
            {loading && (
              <div className="ml-auto flex w-36 items-center gap-2">
                <Activity size={14} className="animate-pulse text-blue-500" />
                <Progress value={65} className="h-1.5 flex-1" />
              </div>
            )}
          </div>

          {/* 子 Agent 状态 */}
          <AgentStatusBar agents={agentStatuses} />

          {/* 聊天消息区 */}
          <div className="min-h-0 flex-1">
            {historyLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 size={24} className="animate-spin text-gray-400" />
              </div>
            ) : virtuosoData.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm italic text-gray-300">
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
              <div className="relative h-full">
                <Virtuoso
                  ref={virtuosoRef}
                  data={virtuosoData}
                  itemContent={renderVirtuosoItem}
                  followOutput="auto"
                  atBottomThreshold={120}
                  atBottomStateChange={(isAtBottom) => setAtBottom(isAtBottom)}
                  className="h-full"
                />
                {!atBottom && (
                  <Button
                    variant="default"
                    size="icon"
                    onClick={scrollToBottom}
                    className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg"
                    title="回到底部"
                  >
                    <ChevronDown size={18} />
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* 输入区 */}
          <div className="shrink-0 border-t bg-white p-3">
            <Textarea
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
              className="resize-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                onClick={() => callApi(false)}
                disabled={loading || !prompt.trim()}
              >
                {loading ? '执行中...' : '发送'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => callApi(true)}
                disabled={loading || !prompt.trim()}
              >
                发送后销毁
              </Button>
              {loading && (
                <Button variant="destructive" onClick={stopAgent}>
                  中止
                </Button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {summary}
              </span>
            </div>
          </div>

        </div>

          {/* 右侧功能面板（挤压式：压缩聊天区宽度，保留右侧状态栏） */}
          <div
            className={`overflow-hidden border-l bg-white transition-[width] duration-200 ease-in-out ${
              activePanel ? 'w-[min(42%,520px)]' : 'w-0'
            }`}
          >
            <div className="flex h-full w-full min-w-[320px] flex-col">
              {/* 面板头部 */}
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                <span className="text-sm font-medium text-foreground">
                  {activePanel === 'sandbox'
                    ? '沙箱'
                    : activePanel === 'logs'
                      ? '日志'
                      : activePanel === 'terminal'
                        ? '终端'
                        : 'API 设置'}
                </span>
                <span className="text-xs text-muted-foreground">
                  再次点击右侧按钮收起
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  onClick={() => setActivePanel(null)}
                  title="收起"
                >
                  <X size={14} />
                </Button>
              </div>

              {/* 面板内容（常驻挂载保留状态，hidden 切换） */}
              <div className="min-h-0 flex-1">
                <div className={activePanel === 'sandbox' ? 'h-full' : 'hidden'}>
                  <SandboxPanel
                    sandboxId={sandboxId}
                    terminalLines={terminalLines}
                    onSandboxExpired={() => {
                      setSandboxId(null);
                      setSandboxStatus('沙箱已过期');
                      addLog('⏳ 沙箱已过期被回收，请重新发送任务', 'error');
                    }}
                  />
                </div>
                <div className={activePanel === 'logs' ? 'h-full' : 'hidden'}>
                  <LogPanel modelLogs={logs} />
                </div>
                <div
                  className={
                    activePanel === 'terminal'
                      ? 'flex h-full flex-col bg-gray-900 text-gray-200'
                      : 'hidden'
                  }
                >
                  <div className="flex shrink-0 items-center gap-2 border-b border-gray-700 px-3 py-2 text-xs font-semibold text-gray-400">
                    <Activity size={12} />
                    终端输出
                    <span className="ml-auto font-normal">
                      {terminalLines.length} 条
                    </span>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-2 font-mono text-xs leading-relaxed">
                      {terminalLines.length === 0 ? (
                        <p className="text-gray-600">
                          Agent 执行命令的输出将显示在这里
                        </p>
                      ) : (
                        terminalLines.map((entry, i) => (
                          <div
                            key={i}
                            className={`${
                              entry.type === 'stderr'
                                ? 'text-red-400'
                                : entry.type === 'stdout'
                                  ? 'text-green-300'
                                  : 'text-gray-500'
                            }`}
                          >
                            <span className="mr-2 text-gray-600">
                              {entry.time}
                            </span>
                            {entry.text}
                          </div>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </div>
                <div className={activePanel === 'apikey' ? 'h-full p-4' : 'hidden'}>
                  <h3 className="mb-3 text-sm font-semibold text-foreground">
                    API 设置
                  </h3>
                  <ApiKeySettings
                    apiKey={apiKey}
                    e2bApiKey={e2bApiKey}
                    onSave={(k, e2bK) => {
                      setApiKey(k);
                      setE2bApiKey(e2bK);
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        {/* 右侧状态栏 */}
        <RightStatusBar
          activePanel={activePanel}
          onPanelChange={handlePanelChange}
          sandboxId={sandboxId}
          loading={loading}
          logCount={logs.length}
          terminalCount={terminalLines.length}
          onKillSandbox={killSandbox}
        />
      </div>
    </main>
  );
}
