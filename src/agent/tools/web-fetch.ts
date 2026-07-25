import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  url: z
    .string()
    .url()
    .describe(
      '要抓取的完整 URL。注意：不要用 Google/Bing 等搜索引擎，它们需要浏览器渲染，应使用文档站或 API 端点，例如 https://nodejs.org/api/fs.html',
    ),
  maxBytes: z
    .number()
    .optional()
    .default(50_000)
    .describe('最大返回字节数，默认 50000'),
});

/**
 * 从 Node.js 错误 stderr 中提取真正的错误信息（跳过 [eval] 行和源码回显）
 */
function extractErrorMessage(stderr: string): string {
  // Node.js eval 错误格式：
  //   [eval]:1
  //   const url = ...
  //   ^
  //   TypeError: fetch failed
  //   ...
  // 我们取最后 3 行（真实错误），但过滤掉纯源码行
  const lines = stderr.split('\n');
  const meaningful: string[] = [];
  for (let i = lines.length - 1; i >= 0 && meaningful.length < 5; i--) {
    const line = lines[i].trim();
    // 跳过 [eval] 标记、纯源码行、空行
    if (
      !line ||
      line.startsWith('[eval]') ||
      line.startsWith('const ') ||
      line.startsWith('let ') ||
      line.startsWith('var ') ||
      line.startsWith('(async') ||
      line === 'try {' ||
      line === '} catch' ||
      line.startsWith('//')
    ) {
      continue;
    }
    meaningful.unshift(line);
  }
  return meaningful.join('\n') || stderr.slice(-300);
}

/**
 * 创建 web_fetch 工具（工厂函数）
 */
export function createWebFetchTool(sandbox: Sandbox) {
  return tool({
    description:
      '从沙箱内发起 HTTP GET 请求抓取网页或 API。适用于查阅在线文档、npm 包信息、GitHub README 等。不适合搜索引擎（Google/Bing 需要浏览器渲染）。',
    inputSchema,
    execute: async (args) => {
      const { url, maxBytes } = args;

      // 检测搜索引擎 URL，给出友好提示
      const isSearchEngine =
        /google\.com\/search|bing\.com\/search|duckduckgo\.com/.test(url);
      if (isSearchEngine) {
        return {
          success: false,
          url,
          content: '',
          status: 0,
          message:
            'web_fetch 不支持搜索引擎查询（Google/Bing 需要浏览器渲染）。请改用文档站 (nodejs.org, npmjs.com, developer.mozilla.org) 或 GitHub。',
        };
      }

      // Node.js 脚本：fetch → 截断 → 输出 JSON 到 stdout
      const script = `
const url = ${JSON.stringify(url)};
const maxBytes = ${maxBytes || 50000};
(async () => {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'CodingAgent/1.0' },
    });
    const text = await res.text();
    const truncated = text.length > maxBytes ? text.slice(0, maxBytes) + '\\n...(truncated)' : text;
    const result = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || '',
      size: text.length,
      truncated: text.length > maxBytes,
      body: truncated,
    };
    console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, status: 0, error: err.message }));
  }
})();
`.trim();

      try {
        const result = await sandbox.commands.run(
          `node -e ${JSON.stringify(script)}`,
          { timeoutMs: 25_000 },
        );

        // node 脚本把结果 JSON 打印到 stdout
        const raw = (result.stdout || '').trim();
        if (!raw) {
          const errDetail = extractErrorMessage(result.stderr || '');
          return {
            success: false,
            url,
            content: '',
            status: 0,
            message: `抓取失败: ${errDetail || '无响应'}`,
          };
        }

        // 提取 JSON
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return {
            success: false,
            url,
            content: raw.slice(0, 500),
            status: 0,
            message: `无法解析响应: ${raw.slice(0, 200)}`,
          };
        }

        const parsed = JSON.parse(jsonMatch[0]);

        // body 是 JSON 时美化
        let body = parsed.body || '';
        try {
          const bodyParsed = JSON.parse(body);
          body = JSON.stringify(bodyParsed, null, 2);
        } catch {
          // 不是 JSON
        }

        console.log(
          `[web_fetch] ${url} → HTTP ${parsed.status} · ${parsed.size} 字节`,
        );

        return {
          success: parsed.ok,
          url,
          content: body,
          status: parsed.status,
          statusText: parsed.statusText || '',
          contentType: parsed.contentType || '',
          size: parsed.size || 0,
          truncated: parsed.truncated || false,
          message: parsed.ok
            ? `HTTP ${parsed.status} · ${parsed.size} 字节${parsed.truncated ? ' (已截断)' : ''}`
            : `HTTP ${parsed.status} ${parsed.statusText || ''} · ${parsed.size} 字节`,
        };
      } catch (error: any) {
        const rawStderr =
          (error as any).result?.stderr ||
          (error as any).stderr ||
          error.message ||
          '未知错误';
        const detail = extractErrorMessage(rawStderr);

        console.error(`[web_fetch] 失败: ${url} — ${detail}`);

        if (detail.includes('node') && detail.includes('not found')) {
          return {
            success: false,
            url,
            content: '',
            status: 0,
            message: '沙箱中未安装 Node.js，无法使用 web_fetch',
          };
        }

        return {
          success: false,
          url,
          content: '',
          status: 0,
          message: `抓取失败: ${detail}`,
        };
      }
    },
  });
}
