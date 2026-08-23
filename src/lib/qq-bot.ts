// QQ 机器人（QQ 开放平台）主动消息发送
// 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/
// 流程：POST /app/getAppAccessToken 取 token（7200s）→ Authorization: QQBot {token} 发消息

const QQ_BOT_BASE = 'https://api.bot.qq.com';

export interface QQBotCreds {
  appId?: string;
  appSecret?: string;
}

interface CachedToken {
  token: string;
  expireAt: number;
}

// 按 appId 缓存 token（不同机器人不同凭证）
const tokenCache = new Map<string, CachedToken>();

/** 获取机器人 access_token（优先传入凭据，回退环境变量；按 appId 缓存，7200s 有效，提前 60s 刷新） */
export async function getAccessToken(creds?: QQBotCreds): Promise<string> {
  const appId = creds?.appId || process.env.QQ_BOT_APP_ID;
  const appSecret = creds?.appSecret || process.env.QQ_BOT_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('QQ_BOT_APP_ID / QQ_BOT_APP_SECRET 未配置');
  }

  const cached = tokenCache.get(appId);
  if (cached && Date.now() < cached.expireAt) {
    return cached.token;
  }

  const res = await fetch(`${QQ_BOT_BASE}/app/getAppAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    message?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(`获取 QQ access_token 失败: ${data.message || `HTTP ${res.status}`}`);
  }

  const expiresIn = data.expires_in || 7200;
  tokenCache.set(appId, {
    token: data.access_token,
    expireAt: Date.now() + (expiresIn - 60) * 1000,
  });
  return data.access_token;
}

/** QQ 文本消息长度上限（约 2000 字符，留安全余量） */
const MAX_CONTENT_LEN = 1800;

/**
 * 发送单聊文本消息（主动消息）。
 * @param openid 接收者 user_openid（与机器人建立过会话后才能拿到）
 * @param content 消息正文（超长自动截断）
 * @param creds 可选：机器人凭据，缺省时使用环境变量
 */
export async function sendC2CMessage(
  openid: string,
  content: string,
  creds?: QQBotCreds,
): Promise<void> {
  if (!content.trim()) {
    throw new Error('消息内容为空');
  }

  const token = await getAccessToken(creds);
  const text =
    content.length > MAX_CONTENT_LEN
      ? `${content.slice(0, MAX_CONTENT_LEN)}…（内容过长已截断）`
      : content;

  const res = await fetch(`${QQ_BOT_BASE}/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ content: text, msg_type: 0 }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    err_code?: number;
    message?: string;
  };

  if (!res.ok || (data.err_code !== undefined && data.err_code !== 0)) {
    throw new Error(`发送 QQ 消息失败: ${data.message || `HTTP ${res.status}`}`);
  }
}
