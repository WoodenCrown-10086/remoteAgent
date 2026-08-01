import { NextRequest } from 'next/server';
import { initDb, createSession, listSessions, deleteSession, updateSession } from '@/db/db';

export async function GET() {
  await initDb();
  const sessions = await listSessions(50);
  return Response.json(sessions);
}

export async function POST(req: NextRequest) {
  await initDb();
  const body = await req.json();
  const { title, sandboxId } = body || {};
  const session = await createSession({ title, sandboxId });
  return Response.json(session, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  await initDb();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: '缺少 id' }, { status: 400 });
  await deleteSession(id);
  return Response.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  await initDb();
  const body = await req.json();
  const { id, title, sandboxId, status } = body || {};
  if (!id) return Response.json({ error: '缺少 id' }, { status: 400 });
  await updateSession(id, { title, sandboxId, status });
  return Response.json({ ok: true });
}
