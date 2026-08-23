import { signCallbackValidation, verifyEventSignature } from '@/lib/qq-bot-sign';

export const dynamic = 'force-dynamic';

/** 递归查找事件里的 user_openid（QQ 事件结构层级不固定，做健壮提取） */
function findUserOpenid(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findUserOpenid(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === 'user_openid' && typeof value === 'string') return value;
    const found = findUserOpenid(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * QQ 机器人 Webhook 回调（POST）
 * - op=13：回调地址验证 → 返回 { plain_token, signature }
 * - op=0 ：事件推送（C2C_MESSAGE_CREATE 等）→ 验签 + 提取 user_openid 打到日志
 */
export async function POST(req: Request) {
  // 回调验签用的密钥是「签名密钥 / Bot Secret」，与换 token 的 AppSecret 是两个不同值。
  // 优先读 QQ_BOT_SIGN_SECRET（签名密钥），未配置时回退 QQ_BOT_APP_SECRET。
  const secret = process.env.QQ_BOT_SIGN_SECRET || process.env.QQ_BOT_APP_SECRET;
  if (!secret) {
    return Response.json(
      { error: 'QQ_BOT_SIGN_SECRET / QQ_BOT_APP_SECRET 未配置' },
      { status: 500 },
    );
  }

  const rawBody = await req.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: '无效 JSON' }, { status: 400 });
  }

  const p = payload as {
    op?: number;
    d?: { plain_token?: unknown; event_ts?: unknown };
  };

  // ── 回调地址验证 ──
  if (p?.op === 13) {
    const plainToken = p?.d?.plain_token;
    const eventTs = p?.d?.event_ts;
    console.log('[qqbot] 回调验证请求:', {
      plain_token: plainToken,
      event_ts: eventTs,
      secretLength: secret.length,
      secretPrefix: `${secret.slice(0, 4)}****`,
    });
    if (!plainToken || !eventTs) {
      return Response.json({ error: '缺少 plain_token / event_ts' }, { status: 400 });
    }
    const signature = signCallbackValidation(secret, String(eventTs), String(plainToken));
    console.log('[qqbot] 生成签名:', signature);
    return Response.json({ plain_token: String(plainToken), signature });
  }

  // ── 事件推送 ──
  if (p?.op === 0) {
    const signature = req.headers.get('x-signature-ed25519') || '';
    const timestamp = req.headers.get('x-signature-timestamp') || '';

    if (signature && timestamp) {
      const ok = verifyEventSignature(secret, timestamp, rawBody, signature);
      if (!ok) {
        console.warn('[qqbot] ⚠️ 事件签名验证失败（请检查 QQ_BOT_APP_SECRET 是否正确）');
      }
    }

    const userOpenid = findUserOpenid(payload);
    if (userOpenid) {
      console.log('════════════════════════════════════════');
      console.log('[qqbot] ✅ 收到事件，user_openid 如下：');
      console.log(`[qqbot] user_openid = ${userOpenid}`);
      console.log('[qqbot] 请复制到「API 设置 → QQ 机器人 → 接收者」字段：');
      console.log(`[qqbot] ${userOpenid}`);
      console.log('════════════════════════════════════════');
    } else {
      console.log('[qqbot] 收到事件（未找到 user_openid）:', rawBody.slice(0, 800));
    }

    return Response.json({ ok: true });
  }

  return Response.json({ ok: true });
}
