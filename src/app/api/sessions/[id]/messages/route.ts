import { initDb, getSession, getSessionMessages } from '@/db/db';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await initDb();
  const { id } = await params;

  const session = await getSession(id);
  if (!session) {
    return Response.json({ error: '会话不存在' }, { status: 404 });
  }

  const messages = await getSessionMessages(id);

  return Response.json({
    session,
    messages: messages.map((m) => ({
      ...m,
      metadata: m.metadata ? JSON.parse(m.metadata) : null,
    })),
  });
}
