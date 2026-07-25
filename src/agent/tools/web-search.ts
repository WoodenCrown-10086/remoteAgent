import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '@e2b/code-interpreter';

const inputSchema = z.object({
  query: z.string().describe('搜索关键词，例如 "Node.js fs module writeFile example"'),
  maxResults: z
    .number()
    .optional()
    .default(10)
    .describe('最大返回结果数，默认 10'),
});

/**
 * 从 Node.js 错误 stderr 中提取真正的错误信息
 * Node.js eval 报错格式: [eval]:1 + 全部源码 + 最终错误行
 * 我们取最后几行，跳过源码回显
 */
function extractErrorMessage(stderr: string): string {
  const lines = stderr.split('\n');
  const meaningful: string[] = [];
  for (let i = lines.length - 1; i >= 0 && meaningful.length < 5; i--) {
    const line = lines[i].trim();
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
  return meaningful.join('\n') || stderr.slice(-500);
}

/**
 * 创建 web_search 工具（工厂函数）
 *
 * 使用 DuckDuckGo Lite 搜索（无需 API Key），
 * Node.js fetch + 简单正则解析 HTML 提取标题/URL/摘要。
 */
export function createWebSearchTool(sandbox: Sandbox) {
  return tool({
    description:
      '在 DuckDuckGo 上搜索网页，返回标题、URL 和摘要。用于查资料、找解决方案、了解最新技术信息。适合代替 Google/Bing 搜索。',
    inputSchema,
    execute: async (args) => {
      const { query, maxResults } = args;

      // Node.js 脚本：fetch DuckDuckGo Lite → 正则提取结果 → 输出 JSON
      const script = `
const query = ${JSON.stringify(query)};
const maxResults = ${maxResults || 10};
const url = 'https://lite.duckduckgo.com/lite/?' + new URLSearchParams({ q: query });

(async () => {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CodingAgent/1.0)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) {
      console.log(JSON.stringify({ error: 'HTTP ' + res.status + ' ' + res.statusText }));
      return;
    }

    const html = await res.text();
    const results = [];

    // DuckDuckGo Lite 结果格式:
    // <tr class="result-snippet">
    //   <td><a rel="nofollow" href="URL" class="result-link">Title</a></td>
    //   <td class="result-snippet">Snippet...</td>
    // </tr>

    // 用正则匹配每个结果块
    const blockRegex = /<tr[^>]*class="result-snippet"[^>]*>[\\s\\S]*?<\\/tr>/gi;
    const blocks = html.match(blockRegex) || [];

    for (const block of blocks) {
      if (results.length >= maxResults) break;

      // 提取链接和标题
      const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*class="result-link"[^>]*>([\\s\\S]*?)<\\/a>/i);
      // 提取摘要
      const snippetMatch = block.match(/<td[^>]*class="result-snippet"[^>]*>([\\s\\S]*?)<\\/td>/i);

      if (linkMatch) {
        // DuckDuckGo lite 的链接是相对路径重定向
        let rawUrl = linkMatch[1].replace(/&amp;/g, '&');
        // 去掉前导的 // 或 /l/? 前缀
        if (rawUrl.startsWith('//')) rawUrl = 'https:' + rawUrl;
        // 从 uddg= 参数提取真实 URL
        const realUrlMatch = rawUrl.match(/uddg=([^&]*)/);
        const realUrl = realUrlMatch
          ? decodeURIComponent(realUrlMatch[1])
          : rawUrl;

        const title = (linkMatch[2] || '').replace(/<[^>]*>/g, '').trim();
        const snippet = snippetMatch
          ? snippetMatch[1].replace(/<[^>]*>/g, '').trim()
          : '';

        if (title) {
          results.push({ title, url: realUrl, snippet });
        }
      }
    }

    console.log(JSON.stringify({ results, count: results.length }));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message, results: [] }));
  }
})();
`.trim();

      try {
        const result = await sandbox.commands.run(
          `node -e ${JSON.stringify(script)}`,
          { timeoutMs: 20_000 },
        );

        const raw = (result.stdout || '').trim();

        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return {
            success: false,
            query,
            results: [],
            count: 0,
            message: '搜索失败：无法解析响应',
          };
        }

        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.error) {
          return {
            success: false,
            query,
            results: [],
            count: 0,
            message: `搜索失败: ${parsed.error}`,
          };
        }

        console.log(
          `[web_search] "${query}" → ${parsed.count} 条结果`,
        );

        return {
          success: true,
          query,
          results: parsed.results || [],
          count: parsed.count || 0,
          message:
            parsed.count > 0
              ? `搜索 "${query}" 返回 ${parsed.count} 条结果`
              : `搜索 "${query}" 未找到结果`,
        };
      } catch (error: any) {
        const rawStderr =
          (error as any).result?.stderr ||
          (error as any).stderr ||
          error.message ||
          '未知错误';
        const detail = extractErrorMessage(rawStderr);

        console.error(`[web_search] 失败: "${query}" — ${detail}`);

        return {
          success: false,
          query,
          results: [],
          count: 0,
          message: `搜索失败: ${detail}`,
        };
      }
    },
  });
}
