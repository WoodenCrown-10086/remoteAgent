'use client';
import { useState, useRef } from 'react';
import SandboxPanel from '@/components/sandbox-panel';
import { Wrench, CheckCircle2, XCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

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
  type: 'text' | 'tool_call' | 'tool_result' | 'tool_error' | 'step' | 'step_finish' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  stepIndex?: number;
  finishReason?: string;
  error?: string;
}

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
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());

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
    setLoading(true);
    setSummary('');
    setLogs([]);
    setActivity([]);
    setTerminalLines([]);
    setExpandedTools(new Set());
    abortRef.current = new AbortController();

    try {
      const body: Record<string, unknown> = { prompt, action: killAfter ? 'kill' : 'pause' };
      if (sandboxId) body.sandboxId = sandboxId;

      const res = await fetch('/api/hello', {
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
              case 'init':
                setSandboxId(event.sandboxId);
                setSandboxStatus(event.sandboxCreated ? '新创建' : '已恢复');
                addLog(`🟢 沙箱 ${event.sandboxId?.slice(0, 12)}... ${event.sandboxCreated ? '已创建' : '已连接'}`, 'info');
                break;

              case 'text':
                addActivity({ type: 'text', content: event.content });
                break;

              case 'tool_call':
                addActivity({
                  type: 'tool_call',
                  toolName: event.toolName,
                  toolArgs: event.args,
                });
                addLog(`🔧 ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)})`, 'tool');
                if (event.toolName === 'execute_command' && event.args?.command) {
                  addTerminal(`$ ${event.args.command}`, 'info');
                }
                break;

              case 'tool_result': {
                const ok = typeof event.result === 'object' && event.result?.success === true;
                addActivity({
                  type: 'tool_result',
                  toolName: event.toolName,
                  toolResult: event.result,
                });
                const resultStr = typeof event.result === 'string'
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
                    addTerminal(
                      `[exit code: ${exitCode}]`,
                      exitCode === 0 ? 'info' : 'stderr',
                    );
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
                addActivity({ type: 'step_finish', stepIndex: event.index, finishReason: event.finishReason });
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
      if (err && typeof err === 'object' && 'name' in err && (err as Error).name !== 'AbortError') {
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
      await fetch('/api/hello', {
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
            <button
              onClick={killSandbox}
              disabled={loading}
              className="ml-auto px-2 py-0.5 bg-red-100 text-red-600 rounded text-xs hover:bg-red-200 disabled:opacity-50"
            >
              销毁
            </button>
          </>
        ) : (
          <span className="text-gray-400 text-xs">无活跃沙箱</span>
        )}
      </div>

      {/* 主体：左输出区 + 中面板 + 右日志面板 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧 — Agent 活动时间线 */}
        <div className="w-1/3 flex flex-col min-w-0 border-r">
          <div className="flex-1 overflow-auto">
            {activity.length === 0 ? (
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
              <div className="p-3 space-y-1.5">
                {(() => {
                  const merged: Array<ActivityEntry & { mergedText?: string }> = [];
                  for (const entry of activity) {
                    if (entry.type === 'text' && merged.length > 0 && merged[merged.length - 1].type === 'text') {
                      const prev = merged[merged.length - 1];
                      prev.mergedText = (prev.mergedText || prev.content || '') + (entry.content || '');
                    } else {
                      merged.push({ ...entry });
                    }
                  }
                  return merged.map((entry, i) => {
                    if (entry.type === 'text') {
                      return (
                        <div key={i} className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                          {entry.mergedText || entry.content}
                        </div>
                      );
                    }
                    if (entry.type === 'tool_call') {
                      const isExpanded = expandedTools.has(i);
                      const displayArgs = entry.toolArgs ? { ...entry.toolArgs } : undefined;
                      if (displayArgs && entry.toolName === 'write_file' && typeof displayArgs.content === 'string') {
                        const c = displayArgs.content as string;
                        if (c.length > 200) {
                          displayArgs.content = c.slice(0, 200) + `... (共 ${c.length} 字符)`;
                        }
                      }
                      return (
                        <div key={i} className="rounded border border-blue-200 bg-blue-50/50 overflow-hidden">
                          <button
                            onClick={() => {
                              const next = new Set(expandedTools);
                              if (isExpanded) next.delete(i); else next.add(i);
                              setExpandedTools(next);
                            }}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-blue-100/50 transition-colors"
                          >
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <Wrench size={12} className="text-blue-500" />
                            <span className="font-mono font-medium text-blue-700">{entry.toolName}</span>
                            <span className="text-gray-400 ml-auto">{entry.time}</span>
                          </button>
                          {isExpanded && displayArgs && (
                            <div className="px-3 pb-2">
                              <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap break-all bg-white/50 rounded p-1.5 border border-blue-100">
                                {JSON.stringify(displayArgs, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    }
                    if (entry.type === 'tool_result') {
                      const result = entry.toolResult as Record<string, unknown> | null;
                      const ok = typeof entry.toolResult === 'object' && entry.toolResult !== null && result?.success === true;
                      const s = typeof entry.toolResult === 'object' && entry.toolResult !== null && typeof result?.message === 'string'
                        ? result.message
                        : typeof entry.toolResult === 'string' ? entry.toolResult.slice(0, 80) : '';
                      return (
                        <div key={i} className={`flex items-center gap-1.5 text-xs pl-6 ${ok ? 'text-green-600' : 'text-orange-600'}`}>
                          {ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                          <span className="truncate">{s}</span>
                        </div>
                      );
                    }
                    if (entry.type === 'tool_error') {
                      return (
                        <div key={i} className="flex items-center gap-1.5 text-xs text-red-600 pl-6">
                          <XCircle size={12} />
                          <span className="font-mono">{entry.toolName}</span>
                          <span className="truncate">{entry.error}</span>
                        </div>
                      );
                    }
                    if (entry.type === 'step') {
                      return (
                        <div key={i} className="flex items-center gap-2 pt-2 pb-0.5">
                          <div className="flex-1 h-px bg-gray-200" />
                          <span className="text-xs text-gray-400 font-mono shrink-0">步骤 {entry.stepIndex}</span>
                          <div className="flex-1 h-px bg-gray-200" />
                        </div>
                      );
                    }
                    if (entry.type === 'step_finish') {
                      return (
                        <div key={i} className="text-xs text-gray-400 pl-2 pb-1">
                          ↳ 步骤 {entry.stepIndex} 完成 ({entry.finishReason})
                        </div>
                      );
                    }
                    if (entry.type === 'done') {
                      return (
                        <div key={i} className="flex items-center gap-2 pt-2">
                          <div className="flex-1 h-px bg-green-200" />
                          <span className="text-xs text-green-600 font-medium shrink-0 flex items-center gap-1">
                            <CheckCircle2 size={12} />完成 ({entry.finishReason})
                          </span>
                          <div className="flex-1 h-px bg-green-200" />
                        </div>
                      );
                    }
                    if (entry.type === 'error') {
                      return (
                        <div key={i} className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
                          💥 {entry.error}
                        </div>
                      );
                    }
                    return null;
                  });
                })()}
                {loading && (
                  <div className="flex items-center gap-2 text-xs text-blue-500 pt-2 pl-2 animate-pulse">
                    <Loader2 size={12} className="animate-spin" />
                    {activity.length > 0 && activity[activity.length - 1]?.type === 'tool_call'
                      ? `正在执行 ${activity[activity.length - 1].toolName}...`
                      : '执行中...'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部输入区 */}
          <div className="border-t p-3 bg-gray-50 shrink-0">
            <textarea
              className="w-full border rounded p-2 text-sm resize-none"
              rows={3}
              placeholder="输入任务描述..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  callApi(false);
                }
              }}
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => callApi(false)}
                disabled={loading || !prompt}
                className="px-4 py-1.5 bg-blue-500 text-white rounded text-sm disabled:opacity-50 hover:bg-blue-600"
              >
                {loading ? '执行中...' : '发送 (复用)'}
              </button>
              <button
                onClick={() => callApi(true)}
                disabled={loading || !prompt}
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
              <span className="text-xs text-gray-400 ml-auto">
                {summary}
              </span>
            </div>
          </div>
        </div>

        {/* 中间 — 可视化面板 */}
        <div className="w-1/3 border-r">
          <SandboxPanel sandboxId={sandboxId} terminalLines={terminalLines} />
        </div>

        {/* 右侧 — 日志面板 */}
        <div className="w-1/3 bg-gray-900 text-gray-200 flex flex-col shrink-0">
          <div className="px-3 py-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            系统日志
          </div>
          <div className="flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-gray-600 italic">等待事件...</p>
            ) : (
              logs.map((entry, i) => (
                <div
                  key={i}
                  className={`leading-relaxed ${
                    entry.type === 'error'
                      ? 'text-red-400'
                      : entry.type === 'tool'
                        ? 'text-yellow-300'
                        : 'text-gray-300'
                  }`}
                >
                  <span className="text-gray-600">{entry.time}</span>{' '}
                  {entry.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
