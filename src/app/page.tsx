import AgentAppLoader from '@/components/agent-app-loader';

// 纯 CSR 入口：真实应用由客户端组件 agent-app-loader（dynamic ssr:false）加载，
// 服务器只输出骨架，彻底避免 hydration mismatch。
export default function Page() {
  return <AgentAppLoader />;
}
