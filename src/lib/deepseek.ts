import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const deepseek = createOpenAICompatible({
  baseURL: 'https://api.deepseek.com/v1',
  name: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY,
});