'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, Plus, Trash2, ChevronLeft, Loader2 } from 'lucide-react';

interface SessionItem {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface Props {
  currentSessionId: string | null;
  onSelect: (session: SessionItem) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  refreshKey: number;
}

export default function SessionSidebar({
  currentSessionId,
  onSelect,
  onNew,
  onDelete,
  collapsed,
  onToggle,
  refreshKey,
}: Props) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.error('加载会话列表失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, [refreshKey]); // refreshKey 变化时重新加载

  // 每次 refreshKey 或 sessionId 变化时刷新列表
  useEffect(() => {
    if (currentSessionId || refreshKey > 0) loadSessions();
  }, [currentSessionId, refreshKey]);

  if (collapsed) {
    return (
      <div className="shrink-0 border-r bg-gray-50 flex flex-col items-center py-3 gap-3 w-10">
        <button
          onClick={onToggle}
          className="p-1 hover:bg-gray-200 rounded text-gray-500"
          title="展开会话列表"
        >
          <ChevronLeft size={16} className="rotate-180" />
        </button>
        <button
          onClick={onNew}
          className="p-1 hover:bg-blue-100 rounded text-blue-500"
          title="新建会话"
        >
          <Plus size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-r bg-gray-50 flex flex-col w-52">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <MessageSquare size={16} className="text-gray-500" />
        <span className="text-sm font-medium text-gray-700 flex-1">会话列表</span>
        <button
          onClick={onToggle}
          className="p-0.5 hover:bg-gray-200 rounded text-gray-400"
          title="收起"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* 新建按钮 */}
      <button
        onClick={onNew}
        className="mx-2 mt-2 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-blue-600 hover:bg-blue-50 rounded border border-dashed border-blue-300"
      >
        <Plus size={12} /> 新建会话
      </button>

      {/* 会话列表 */}
      <div className="flex-1 overflow-auto mt-1">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 size={16} className="animate-spin text-gray-400" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-6 px-3">暂无会话</p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s)}
              className={`group flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors ${
                s.id === currentSessionId
                  ? 'bg-blue-100 text-blue-700'
                  : 'hover:bg-gray-100 text-gray-700'
              }`}
            >
              <MessageSquare size={14} className="shrink-0" />
              <span className="truncate flex-1 text-xs">{s.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('删除此会话？')) onDelete(s.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-red-100 rounded text-red-400 transition-opacity"
                title="删除"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
