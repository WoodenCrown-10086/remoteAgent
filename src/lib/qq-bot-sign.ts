// QQ 机器人 Webhook 签名/验签（Ed25519）
// 官方算法：seed = botSecret（repeat 到 >=32 字节再截断）→ 派生 ed25519 私钥/公钥
// - 回调地址验证：sign(event_ts + plain_token)
// - 事件推送验签：verify(sign(timestamp + body))

import { ed25519 } from '@noble/curves/ed25519.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** 从 botSecret 派生 32 字节 seed（官方：长度不足 32 则 repeat 加倍，再截断到 32） */
function deriveSeed(secret: string): Uint8Array {
  let seed = secret;
  while (seed.length < 32) seed = seed + seed;
  return enc(seed.slice(0, 32));
}

/** 回调地址验证：对 event_ts + plain_token 签名，返回 hex signature */
export function signCallbackValidation(
  secret: string,
  eventTs: string,
  plainToken: string,
): string {
  const seed = deriveSeed(secret);
  const sig = ed25519.sign(enc(eventTs + plainToken), seed);
  return Buffer.from(sig).toString('hex');
}

/** 事件推送验签：验证 signature 是否等于 sign(timestamp + body) */
export function verifyEventSignature(
  secret: string,
  timestamp: string,
  body: string,
  signatureHex: string,
): boolean {
  try {
    const seed = deriveSeed(secret);
    const publicKey = ed25519.getPublicKey(seed);
    const sig = Buffer.from(signatureHex, 'hex');
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, enc(timestamp + body), publicKey);
  } catch {
    return false;
  }
}
