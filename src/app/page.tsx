'use client';
import { useState, useRef } from 'react';

interface LogEntry {
  time: string;
  text: string;
  type: 'info' | 'tool' | 'error';
}

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<string>('');
  const [agentOutput, setAgentOutput] = useState('');
  const [summary, setSummary] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const addLog = (text: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-200), { time, text, type }]);
  };

  const callApi = async (killAfter: boolean) => {
    setLoading(true);
    setAgentOutput('');
    setSummary('');
    setLogs([]);
    abortRef.current = new AbortController();

    try {
      const body: any = { prompt, action: killAfter ? 'kill' : 'pause' };
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
                setAgentOutput((prev) => prev + event.content);
                break;

              case 'tool_call':
                addLog(`🔧 ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)})`, 'tool');
                break;

              case 'tool_result': {
                const resultStr = typeof event.result === 'string'
                  ? event.result.slice(0, 120)
                  : JSON.stringify(event.result).slice(0, 120);
                const ok = typeof event.result === 'object' && event.result?.success === true;
                addLog(`${ok ? '✅' : '⚠️'} ${event.toolName}: ${resultStr}`, ok ? 'info' : 'error');
                break;
              }

              case 'tool_error':
                addLog(`❌ ${event.toolName}: ${event.error}`, 'error');
                break;

              case 'step_start':
                addLog(`── 步骤 ${event.index} ──`, 'info');
                break;

              case 'step_finish':
                addLog(`步骤 ${event.index} 完成 (${event.finishReason})`, 'info');
                break;

              case 'done':
                addLog(`🏁 完成 (${event.finishReason})`, 'info');
                setSummary(`完成 (${event.finishReason})`);
                break;

              case 'error':
                addLog(`💥 ${event.error}`, 'error');
                break;
            }
          } catch {
            // 跳过非 JSON 行
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        addLog(`网络错误: ${err.message}`, 'error');
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
    } catch (err: any) {
      setSandboxStatus('销毁失败: ' + err.message);
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

      {/* 主体：左输出区 + 右日志面板 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧 — 输出 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-auto p-4">
            {agentOutput ? (
              <pre className="whitespace-pre-wrap text-sm text-gray-800 font-mono leading-relaxed">
                {agentOutput}
              </pre>
            ) : (
              <p className="text-gray-300 text-sm italic">
                {loading ? 'Agent 思考中...' : '输入任务后点击发送'}
              </p>
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

        {/* 右侧 — 日志面板 */}
        <div className="w-80 border-l bg-gray-900 text-gray-200 flex flex-col shrink-0">
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
                  className={`py-0.5 ${
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
