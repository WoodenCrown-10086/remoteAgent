import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * 创建 DeepSeek provider 实例。
 * 优先使用调用方传入的 apiKey（前端设置），否则回退环境变量。
 */
export function createDeepseek(apiKey?: string) {
  return createOpenAICompatible({
    baseURL: 'https://api.deepseek.com/v1',
    name: 'deepseek',
    apiKey: apiKey || process.env.DEEPSEEK_API_KEY,
  });
}

/** 默认实例（环境变量 key） */
export const deepseek = createDeepseek();
