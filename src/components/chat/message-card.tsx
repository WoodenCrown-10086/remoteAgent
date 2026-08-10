'use client';

import { memo } from 'react';
import { User, Bot } from 'lucide-react';
import MarkdownBlock from './markdown-block';
import ReasoningBlock from './reasoning-block';
import ToolCallCard, { ToolCallCardProps } from './tool-call-card';

// ── 类型 ──

export interface MessageCardItem {
  type: 'text' | 'reasoning' | 'tool';
  content?: string;
  tool?: ToolCallCardProps;
}

export interface MessageCardProps {
  role: 'user' | 'assistant';
  items: MessageCardItem[];
  time?: string;
}

/**
 * 消息卡片（用户/助手通用容器）
 *
 * - user：右侧蓝色气泡
 * - assistant：左侧灰色气泡 + 头像
 * - 内容由 items 组合：文本（markdown）/ 思考（折叠块）/ 工具调用卡片
 *
 * 抽离为独立组件，便于后续迁移到其他前端框架。
 *
 * memo 深度比较：流式输出时 bubbles 全量重建，只有内容真正变化的
 * 消息才重渲染（markdown 重解析很贵），避免每次 text-delta 重渲染全部消息。
 */
function MessageCard({ role, items, time }: MessageCardProps) {
  return (
    <div className={`flex gap-2 ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      {role === 'assistant' && (
        <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center mt-1">
          <Bot size={14} className="text-white" />
        </div>
      )}

      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          role === 'user'
            ? 'bg-blue-600 text-white rounded-br-md'
            : 'bg-slate-100 text-slate-800 rounded-bl-md'
        }`}
      >
        {items.map((item, i) => {
          if (item.type === 'text') {
            return (
              <div key={i} className={role === 'user' ? 'whitespace-pre-wrap break-words' : ''}>
                {role === 'assistant' ? (
                  <MarkdownBlock content={item.content || ''} />
                ) : (
                  item.content
                )}
              </div>
            );
          }
          if (item.type === 'reasoning') {
            // 思考块只出现在助手消息，且使用独立浅色区块
            return (
              <div key={i} className={role === 'assistant' ? '' : 'hidden'}>
                <ReasoningBlock content={item.content || ''} />
              </div>
            );
          }
          if (item.type === 'tool' && item.tool) {
            return <ToolCallCard key={i} {...item.tool} />;
          }
          return null;
        })}

        {time && (
          <div className={`text-[10px] mt-1 ${role === 'user' ? 'text-blue-200' : 'text-slate-400'}`}>
            {time}
          </div>
        )}
      </div>

      {role === 'user' && (
        <div className="shrink-0 w-7 h-7 rounded-full bg-slate-300 flex items-center justify-center mt-1">
          <User size={14} className="text-slate-600" />
        </div>
      )}
    </div>
  );
}

// 深度比较：items 内容未变则跳过重渲染（流式更新时避免全部消息重渲染 + markdown 重解析）
export default memo(MessageCard, (prev, next) => {
  if (prev.role !== next.role || prev.time !== next.time) return false;
  if (prev.items.length !== next.items.length) return false;
  return prev.items.every((item, i) => {
    const n = next.items[i];
    if (item.type !== n.type) return false;
    if (item.content !== n.content) return false;
    if (item.type === 'tool') return item.tool === n.tool;
    return true;
  });
});
