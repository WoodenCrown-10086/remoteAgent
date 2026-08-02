'use client';

import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * 思考结果独立区块（reasoning）
 *
 * 模型的思考过程不直接铺开显示（避免 "The user just said..." 这类噪音），
 * 而是折叠成一个独立卡片，点击展开查看思考结果摘要。
 */
export default function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  if (!content || content.trim().length === 0) return null;

  return (
    <div className="my-1.5 rounded-lg border border-amber-200 bg-amber-50/60 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-amber-700 hover:bg-amber-100/50 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span className="font-medium">思考过程</span>
        <span className="text-amber-400 ml-auto font-normal">
          {content.length} 字
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 text-xs text-amber-800/80 italic leading-relaxed whitespace-pre-wrap border-t border-amber-100 pt-2">
          {content}
        </div>
      )}
    </div>
  );
}
