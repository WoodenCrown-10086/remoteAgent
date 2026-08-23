import { bindAndWait } from '@/lib/qqbot-bind';

export const dynamic = 'force-dynamic';

/**
 * QQ 机器人「绑定」：单次请求内建立 WebSocket 等待用户私聊，同步返回 user_openid。
 * - 成功：{ status: 'done', openid }
 * - 超时/失败：{ status: 'error', error }（HTTP 408）
 */
export async function POST(req: Request) {
  let body: { appId?: string; appSecret?: string } = {};
  try {
    body = (await req.json()) as { appId?: string; appSecret?: string };
  } catch {
    /* 忽略空 body */
  }

  const creds =
    body.appId && body.appSecret
      ? { appId: body.appId, appSecret: body.appSecret }
      : undefined;

  try {
    const openid = await bindAndWait(creds);
    return Response.json({ status: 'done', openid });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ status: 'error', error: message }, { status: 408 });
  }
}
