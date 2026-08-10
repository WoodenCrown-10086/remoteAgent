'use client';

import dynamic from 'next/dynamic';

// 纯 CSR 加载器：整个 Agent 应用只在客户端渲染（服务器输出骨架）。
// - 彻底消除 hydration mismatch（localStorage/URL/时间等客户端独有数据可安全使用）
// - 挂载后加载真实应用，加载期间显示骨架屏
const AgentApp = dynamic(() => import('@/components/agent-app'), {
  ssr: false,
  loading: () => (
    <main className="flex h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" />
        <p className="text-sm">加载中...</p>
      </div>
    </main>
  ),
});

export default function AgentAppLoader() {
  return <AgentApp />;
}
