// ── 统一 API 请求工具 ──
//
// 集中管理 API keys 注入：所有请求自动附加
//   x-api-key       → DeepSeek（localStorage: deepseekApiKey）
//   x-e2b-api-key   → E2B 沙箱（localStorage: e2bApiKey）
//
// 组件不再需要手动构造 headers。

const KEY_STORAGE = {
  deepseek: 'deepseekApiKey',
  e2b: 'e2bApiKey',
} as const;

/** 从 localStorage 读取所有已配置的 API keys，构造统一请求头 */
export function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof window === 'undefined') return headers;

  const deepseekKey = localStorage.getItem(KEY_STORAGE.deepseek);
  const e2bKey = localStorage.getItem(KEY_STORAGE.e2b);

  if (deepseekKey) headers['x-api-key'] = deepseekKey;
  if (e2bKey) headers['x-e2b-api-key'] = e2bKey;

  return headers;
}

/** 统一 fetch：自动附加 API key headers，保留调用方自定义 headers */
export async function apiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    ...getApiHeaders(),
  };
  return fetch(url, { ...init, headers });
}
