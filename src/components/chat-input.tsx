'use client';

import { memo } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

interface Props {
  value: string;
  loading: boolean;
  summary: string;
  onChange: (v: string) => void;
  onSend: (killAfter: boolean) => void;
  onStop: () => void;
}

/**
 * 底部输入区（独立 memo 组件）。
 * 打字时只重渲染本组件，避免每次按键触发整个 AgentApp 巨型组件树重渲染。
 */
function ChatInput({ value, loading, summary, onChange, onSend, onStop }: Props) {
  return (
    <div className="shrink-0 border-t bg-white p-3">
      <Textarea
        rows={3}
        placeholder="输入任务描述，Enter 发送，Shift+Enter 换行"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!loading) onSend(false);
          }
        }}
        className="resize-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={() => onSend(false)} disabled={loading || !value.trim()}>
          {loading ? '执行中...' : '发送'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => onSend(true)}
          disabled={loading || !value.trim()}
        >
          发送后销毁
        </Button>
        {loading && (
          <Button variant="destructive" onClick={onStop}>
            中止
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{summary}</span>
      </div>
    </div>
  );
}

export default memo(ChatInput);
