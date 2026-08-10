'use client';

import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, Server, Trash2, Bug } from 'lucide-react';

// ── 类型 ──

interface ModelLog {
  time: string;
  text: string;
  type: 'info' | 'tool' | 'error';
}

interface ServerLog {
  id: number;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  module?: string;
  method?: string;
  location?: string;
}

// ── 级别颜色 ──

const levelColor: Record<ServerLog['level'], string> = {
  debug: 'text-gray-500',
  info: 'text-gray-300',
  warn: 'text-yellow-300',
  error: 'text-red-400',
};

// ── 日志合并（按 id 去重，兼容历史拉取与 SSE 推送的竞态重叠） ──

function mergeLogs(prev: ServerLog[], incoming: ServerLog[]): ServerLog[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((e) => e.id));
  const merged = [...prev];
  for (const entry of incoming) {
    if (!seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  return merged.slice(-500);
}

// ── 主组件：右侧日志看板 ──

export default function LogPanel({ modelLogs }: { modelLogs: ModelLog[] }) {
  // 模型执行日志（父组件传入的 SSE 事件摘要）
  // 系统日志（服务端 logger 推送）
  const [serverLogs, setServerLogs] = useState<ServerLog[]>([]);
  const [sysConnected, setSysConnected] = useState(false);
  const sysRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  // ── 订阅服务端日志 ──
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    // 1. 拉取历史（合并去重，避免与 SSE 推送重叠）
    fetch('/api/logs')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          const history = (d.logs || []) as ServerLog[];
          setServerLogs((prev) => mergeLogs(prev, history));
        }
      })
      .catch(() => {});

    // 2. 连接 SSE 实时流
    es = new EventSource('/api/logs/stream');
    es.onopen = () => setSysConnected(true);
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as ServerLog;
        setServerLogs((prev) => mergeLogs(prev, [entry]));
      } catch {
        // 忽略非 JSON（心跳注释行）
      }
    };
    es.onerror = () => {
      setSysConnected(false);
      // EventSource 自动重连
    };

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    sysRef.current?.scrollTo(0, sysRef.current.scrollHeight);
  }, [serverLogs]);
  useEffect(() => {
    modelRef.current?.scrollTo(0, modelRef.current.scrollHeight);
  }, [modelLogs]);

  const clearSys = () => setServerLogs([]);

  return (
    <div className="h-full w-full bg-gray-900 text-gray-200 flex flex-col shrink-0 min-w-0 overflow-hidden">
      {/* ── 上半：模型执行日志（高度减半） ── */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1.5 shrink-0">
          <TerminalSquare size={12} />
          模型执行日志
          <span className="text-gray-600 font-normal normal-case ml-auto">
            {modelLogs.length} 条
          </span>
        </div>
        <div ref={modelRef} className="flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed min-h-0">
          {modelLogs.length === 0 ? (
            <p className="text-gray-600 italic">等待事件...</p>
          ) : (
            modelLogs.map((entry, i) => (
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
                <span className="text-gray-600">{entry.time}</span> {entry.text}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 分隔线 */}
      <div className="border-t border-gray-700/50 shrink-0" />

      {/* ── 下半：系统日志（服务端 logger） ── */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1.5 shrink-0">
          <Server size={12} />
          系统日志
          <span
            className={`ml-auto font-normal normal-case flex items-center gap-1 ${
              sysConnected ? 'text-green-500' : 'text-red-400'
            }`}
            title={sysConnected ? '实时连接中' : '连接断开（自动重连）'}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                sysConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'
              }`}
            />
            {sysConnected ? '实时' : '离线'}
          </span>
          <button
            onClick={clearSys}
            className="p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300"
            title="清空"
          >
            <Trash2 size={11} />
          </button>
        </div>
        <div ref={sysRef} className="flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed min-h-0">
          {serverLogs.length === 0 ? (
            <p className="text-gray-600 italic">等待系统日志...</p>
          ) : (
            serverLogs.map((entry) => (
              <div key={entry.id} className={`leading-relaxed ${levelColor[entry.level] || 'text-gray-300'}`}>
                <span className="text-gray-600">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>{' '}
                <span className="text-gray-500 uppercase text-[10px]">{entry.level}</span>{' '}
                {entry.message}
                {(entry.module || entry.location) && (
                  <div className="text-gray-600 text-[10px] pl-4 flex items-center gap-1">
                    <Bug size={9} />
                    {entry.module}
                    {entry.method ? ` → ${entry.method}` : ''}
                    {entry.location ? `  @ ${entry.location}` : ''}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
