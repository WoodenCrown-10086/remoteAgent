import { initDb, getSession, getSessionMessages } from '@/db/db';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await initDb();
  const { id } = await params;

  const session = await getSession(id);
  if (!session) {
    return Response.json({ error: '会话不存在' }, { status: 404 });
  }

  // 分页参数：?limit=N&before=<sequence>&after=<sequence>
  // - 省略 limit → 全量加载（兼容旧行为）
  // - before 为游标（已加载最早消息的 sequence），取比它更早的一页
  // - after 为增量游标（已加载最新消息的 sequence），取比它更新的消息
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const beforeRaw = url.searchParams.get('before');
  const afterRaw = url.searchParams.get('after');
  const limit = limitRaw ? parseInt(limitRaw, 10) : 0;
  const beforeSeq = beforeRaw ? parseInt(beforeRaw, 10) : undefined;
  const afterSeq = afterRaw ? parseInt(afterRaw, 10) : undefined;

  const { messages, hasMore } = await getSessionMessages(id, {
    limit: limit > 0 ? limit : undefined,
    beforeSeq:
      beforeSeq !== undefined && !Number.isNaN(beforeSeq) ? beforeSeq : undefined,
    afterSeq:
      afterSeq !== undefined && !Number.isNaN(afterSeq) ? afterSeq : undefined,
  });

  return Response.json({
    session,
    hasMore,
    messages: messages.map((m) => ({
      ...m,
      metadata: m.metadata ? JSON.parse(m.metadata) : null,
    })),
  });
}
