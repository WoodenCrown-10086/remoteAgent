'use client';

import { useState } from 'react';
import {
  TerminalSquare,
  FilePenLine,
  Wrench,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react';

// ── 类型 ──

export interface FileChange {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface ToolCallCardProps {
  /** 工具类型：command=命令执行 / file=文件改动 / generic=其他工具 */
  kind: 'command' | 'file' | 'generic';
  /** 卡片标题，如 "命令已执行" / "2 个文件已更改" */
  title?: string;
  /** 执行的命令（kind=command 时显示） */
  command?: string;
  /** 文件改动列表（kind=file 时显示） */
  files?: FileChange[];
  /** 工具名（generic / 折叠区显示） */
  toolName?: string;
  /** 执行状态 */
  status?: 'success' | 'error' | 'running';
  /** 原始参数（展开区显示） */
  args?: Record<string, unknown>;
  /** 结果摘要（展开区显示） */
  resultSummary?: string;
}

// ── 图标映射 ──

const KIND_ICON = {
  command: TerminalSquare,
  file: FilePenLine,
  generic: Wrench,
};

/**
 * 工具调用卡片（统一组件，props 区分类型）
 *
 * 渲染为一行摘要（icon + 标题 + 命令/文件摘要 + 状态标记），
 * 点击展开查看完整参数与结果。
 */
export default function ToolCallCard({
  kind = 'generic',
  title,
  command,
  files = [],
  toolName,
  status = 'success',
  args,
  resultSummary,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[kind] || Wrench;

  const fileCount = kind === 'file' ? files.length : 0;
  const additions = kind === 'file' ? files.reduce((s, f) => s + (f.additions || 0), 0) : 0;
  const deletions = kind === 'file' ? files.reduce((s, f) => s + (f.deletions || 0), 0) : 0;

  // 默认标题
  const resolvedTitle =
    title ||
    (kind === 'command'
      ? '命令已执行'
      : kind === 'file'
        ? `${fileCount} 个文件已更改`
        : toolName || '工具调用');

  return (
    <div className="my-1.5 rounded-lg border border-slate-200 bg-slate-50/70 overflow-hidden">
      {/* 摘要行 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs hover:bg-slate-100/70 transition-colors text-left"
      >
        {open ? (
          <ChevronDown size={12} className="text-slate-400 shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-slate-400 shrink-0" />
        )}
        <Icon size={13} className="text-slate-500 shrink-0" />

        <span className="font-medium text-slate-700 shrink-0">{resolvedTitle}</span>

        {/* 摘要内容 */}
        {kind === 'command' && command && (
          <code className="truncate font-mono text-[11px] text-slate-500 bg-white/70 rounded px-1.5 py-0.5 border border-slate-200">
            {command}
          </code>
        )}
        {kind === 'file' && fileCount > 0 && (
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-mono text-green-600 shrink-0">+{additions}</span>
            <span className="text-[11px] font-mono text-red-500 shrink-0">-{deletions}</span>
            <span className="truncate font-mono text-[11px] text-slate-500">
              {files[0]?.path}
              {fileCount > 1 ? ` +${fileCount - 1} 个` : ''}
            </span>
          </span>
        )}
        {kind === 'generic' && toolName && (
          <span className="truncate font-mono text-[11px] text-slate-500">{toolName}</span>
        )}

        {/* 状态标记 */}
        <span className="ml-auto shrink-0">
          {status === 'running' ? (
            <Loader2 size={12} className="text-blue-500 animate-spin" />
          ) : status === 'error' ? (
            <XCircle size={12} className="text-red-500" />
          ) : (
            <CheckCircle2 size={12} className="text-green-500" />
          )}
        </span>
      </button>

      {/* 文件列表（kind=file 展开） */}
      {open && kind === 'file' && files.length > 0 && (
        <div className="px-3 pb-2 border-t border-slate-100">
          <div className="pt-1.5 space-y-0.5">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
                <span className="text-slate-400 flex-1 truncate">{f.path}</span>
                <span className="text-green-600 shrink-0">+{f.additions || 0}</span>
                <span className="text-red-500 shrink-0">-{f.deletions || 0}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 参数/结果展开 */}
      {open && (args || resultSummary) && (
        <div className="px-3 pb-2 border-t border-slate-100 space-y-1.5">
          {resultSummary && (
            <p className="pt-1.5 text-[11px] text-slate-600 leading-relaxed">{resultSummary}</p>
          )}
          {args && Object.keys(args).length > 0 && (
            <pre className="text-[11px] font-mono text-slate-500 whitespace-pre-wrap break-all bg-white/70 rounded p-1.5 border border-slate-200 max-h-40 overflow-auto">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
