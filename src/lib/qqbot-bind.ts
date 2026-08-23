// QQ 机器人「绑定」：单次请求内建立 WebSocket、同步等待 C2C_MESSAGE_CREATE、返回 user_openid
// 无跨请求状态，适配 Railway 等 serverless 环境与多用户并发。
// 用法：前端 POST /api/qqbot/bind，服务端阻塞等待（最长 timeoutMs），拿到 openid 或超时。

import { getAccessToken, type QQBotCreds } from './qq-bot';

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

async function connectGateway(token: string): Promise<WebSocket> {
  let gwUrl = 'wss://api.bot.qq.com/websocket';
  try {
    const gwRes = await fetch('https://api.bot.qq.com/gateway', {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (gwRes.ok) {
      const gw = (await gwRes.json()) as { url?: string };
      if (gw.url) gwUrl = gw.url;
    }
  } catch {
    /* 用默认地址 */
  }
  return new WebSocket(gwUrl);
}

/**
 * 绑定机器人：建立 WebSocket → Identify → 等待 C2C_MESSAGE_CREATE → 返回 user_openid。
 * 超时（默认 45s，低于 Railway 60s 网关超时）未拿到则抛错。
 */
export async function bindAndWait(
  creds?: QQBotCreds,
  timeoutMs = 45_000,
): Promise<string> {
  const token = await getAccessToken(creds);
  const socket = await connectGateway(token);

  return new Promise<string>((resolve, reject) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('绑定超时，请确认已用 QQ 私聊机器人后重试')));
    }, timeoutMs);

    socket.onmessage = (event) => {
      let data: { op?: number; t?: string; d?: unknown };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (data.op === 10) {
        const interval =
          (data.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ??
          45000;
        socket.send(
          JSON.stringify({
            op: 2,
            d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] },
          }),
        );
        heartbeat = setInterval(() => {
          try {
            socket.send(JSON.stringify({ op: 1, d: null }));
          } catch {
            /* 已关闭 */
          }
        }, interval);
      } else if (data.op === 0 && data.t === 'C2C_MESSAGE_CREATE') {
        const openid = findUserOpenid(data.d);
        if (openid) {
          clearTimeout(timer);
          finish(() => resolve(openid));
        }
      } else if (data.op === 9) {
        clearTimeout(timer);
        finish(() => reject(new Error('鉴权失败（请检查 AppSecret / intents 权限）')));
      }
    };

    socket.onerror = () => {
      clearTimeout(timer);
      finish(() => reject(new Error('WebSocket 连接错误')));
    };
  });
}
