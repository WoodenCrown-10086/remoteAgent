'use client';

import type { ReactNode } from 'react';
import { Bot, ClipboardList, Code2, Search, BadgeCheck, Loader2 } from 'lucide-react';

export interface AgentStatus {
  agentId: string;
  agentRole: string;
  status: 'running' | 'passed' | 'failed';
  task?: string;
}

const ROLE_ICON: Record<string, ReactNode> = {
  main: <Bot size={12} />,
  planner: <ClipboardList size={12} />,
  coder: <Code2 size={12} />,
  reviewer: <Search size={12} />,
  evaluator: <BadgeCheck size={12} />,
};

const ROLE_LABEL: Record<string, string> = {
  main: '主',
  planner: '规划',
  coder: '编码',
  reviewer: '审查',
  evaluator: '评估',
};

export default function AgentStatusBar({ agents }: { agents: AgentStatus[] }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 border-b bg-gray-50 shrink-0 flex-wrap">
      <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Agents</span>
      {agents.length === 0 && <span className="text-[10px] text-gray-300">（无子 Agent）</span>}
      {agents.map((a) => (
        <span
          key={a.agentId}
          title={a.task}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${
            a.status === 'running'
              ? 'bg-blue-50 text-blue-600 border-blue-200'
              : a.status === 'failed'
                ? 'bg-red-50 text-red-600 border-red-200'
                : 'bg-green-50 text-green-600 border-green-100'
          }`}
        >
          {ROLE_ICON[a.agentRole] || <Bot size={12} />}
          {ROLE_LABEL[a.agentRole] || a.agentRole}
          {a.agentId !== 'main' && <span className="text-gray-400">{a.agentId.split('-')[1] ?? ''}</span>}
          {a.status === 'running' && <Loader2 size={10} className="animate-spin" />}
        </span>
      ))}
    </div>
  );
}
