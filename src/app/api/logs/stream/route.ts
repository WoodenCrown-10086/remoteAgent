import { subscribeLogs } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/logs/stream → SSE 实时日志流
 * 前端用 EventSource 订阅，收到即推。
 */
export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // 连接确认
      controller.enqueue(encoder.encode(': connected\n\n'));

      let closed = false;
      const unsubscribe = subscribeLogs((entry) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
        } catch {
          closed = true;
          unsubscribe();
        }
      });

      // 心跳保活（SSE 注释行，15s 一次）
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          return;
        }
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          closed = true;
          clearInterval(timer);
          unsubscribe();
        }
      }, 15_000);

      // 连接断开（客户端关闭 / 服务端取消）时清理
      // controller.signal 在部分 TS lib 版本类型缺失，用断言访问
      (controller as unknown as { signal?: AbortSignal }).signal?.addEventListener('abort', () => {
        closed = true;
        clearInterval(timer);
        unsubscribe();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
