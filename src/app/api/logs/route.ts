import { getLogsSince, getRecentLogs } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/logs?after=<id>  → 历史日志（JSON）
 * GET /api/logs             → 最近 100 条
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const after = parseInt(searchParams.get('after') || '0', 10);

  const logs = Number.isFinite(after) && after > 0 ? getLogsSince(after) : getRecentLogs(100);
  return Response.json({ logs });
}
