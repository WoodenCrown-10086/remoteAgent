import { streamText, stepCountIs } from 'ai';
import { deepseek } from '@/lib/deepseek';
import { Sandbox } from '@e2b/code-interpreter';
import { createWriteFileTool } from '@/agent/tools/write-file';
import { createReadFileTool } from '@/agent/tools/read-file';
import { createEditFileTool } from '@/agent/tools/edit-file';
import { createExecuteCommandTool } from '@/agent/tools/execute-command';
import { createGrepSearchTool } from '@/agent/tools/grep-search';
import { createListFilesTool } from '@/agent/tools/list-files';
import { createWebFetchTool } from '@/agent/tools/web-fetch';
import { createWebSearchTool } from '@/agent/tools/web-search';
import { readSkill } from '@/agent/tools/read-skill';
import {
  loadSkills,
  resolveSkills,
  buildSkillPrompt,
} from '@/agent/skills';

export const dynamic = 'force-dynamic';

const BASE_SYSTEM_PROMPT = `你是一个 Coding Agent，工作在 e2b 云沙箱中（根目录 /home/user/）。

## 核心原则
- **严格聚焦用户任务**：只做用户明确要求的事，不要主动探索、分析或修改无关文件。
- **不要跑题**：沙箱中可能存在其他项目的遗留文件，忽略它们。不要因为看到其他代码就转移注意力。
- **简洁高效**：用最少的步骤完成任务，不要做多余的事。任务完成后直接总结，不要"顺便看看还有什么能做"。
- **禁止在对话中粘贴代码**：不要把你的回复当作文件内容展示区。创建/修改文件时，只需说明文件路径和用途，不要复制粘贴文件内容到对话中。文件内容通过 write_file/edit_file 工具写入即可。

## 可用工具
- write_file: 创建或覆盖文件
- read_file: 读取指定文件内容（仅读你需要看的文件）
- edit_file: 精准编辑文件中某一段（给定 old_string → new_string）
- execute_command: 执行 Shell 命令。启动 Web 服务时必须传 background=true（如 {"command": "npx serve -p 3000", "background": true}），否则会超时。不要用 python3 -m http.server（单线程易阻塞）。
- grep_search: 在代码库中搜索文本，快速定位
- list_files: 列出目录结构（仅在必要时使用，不要随意浏览）
- web_fetch: 查阅在线文档。⚠️ 只用文档站（nodejs.org、npmjs.com、mdn、github.com），不要用搜索引擎
- web_search: 搜索技术资料
- read_skill: 加载开发规范 Skill。先看下方「可用 Skills」列表，选择相关的 skill 用此工具加载详细规范。

## 工作流程
1. 理解用户任务，用一两句话说明你打算怎么做。
2. 如果任务涉及特定技术栈，用 read_skill 加载对应规范。
3. 写代码。小改动用 edit_file，新建文件用 write_file。
4. 运行验证。报错则定位修复，直到通过。
5. 总结：你创建/修改了哪些文件，运行结果，服务访问地址。然后停止。

## 可用 Skills
{SKILL_LIST}`;

export async function POST(req: Request) {
  const body = await req.json();
  const { prompt, sandboxId, skills: requestedSkills } = body;
  const shouldKill: boolean = body.action === 'kill';

  // ── 0. 加载 Skills ──
  const availableSkills = await loadSkills();
  const skillList = availableSkills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join('\n') ||
    '（暂无可用 Skill。在 .agent/skills/ 目录下创建 .md 文件即可添加。）';
  const explicitSkills = resolveSkills(prompt, requestedSkills, availableSkills);
  const injectedSkillPrompt = buildSkillPrompt(explicitSkills);
  const systemPrompt =
    BASE_SYSTEM_PROMPT.replace('{SKILL_LIST}', skillList) + injectedSkillPrompt;

  // ── 1. 沙箱 ──
  let sandbox: Sandbox | null = null;
  let sandboxCreated = false;
  if (sandboxId) {
    try {
      sandbox = (await Sandbox.connect(sandboxId, {
        timeoutMs: 300_000,
      })) as Sandbox;
    } catch (err: any) {
      sandbox = await Sandbox.create({ timeoutMs: 300_000 });
      sandboxCreated = true;
    }
  } else {
    sandbox = await Sandbox.create({ timeoutMs: 300_000 });
    sandboxCreated = true;
  }

  // ── 2. 工具 ──
  const tools = {
    write_file: createWriteFileTool(sandbox),
    read_file: createReadFileTool(sandbox),
    edit_file: createEditFileTool(sandbox),
    execute_command: createExecuteCommandTool(sandbox),
    grep_search: createGrepSearchTool(sandbox),
    list_files: createListFilesTool(sandbox),
    web_fetch: createWebFetchTool(sandbox),
    web_search: createWebSearchTool(sandbox),
    read_skill: readSkill,
  };

  // ── 3. SSE 流 ──
  const encoder = new TextEncoder();
  let stepIndex = 0;

  const sseStream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // 立即发送注释行，刷新 HTTP 头 + 通知前端连接成功
        controller.enqueue(encoder.encode(': connected\n\n'));

        // 初始元信息
        send({
          type: 'init',
          sandboxId: sandbox!.sandboxId,
          sandboxCreated,
        });

        // AI SDK v7 streamText — maxSteps 运行时可用，但 TS 类型未收录，as any 绕过
        const result = streamText({
          model: deepseek('deepseek-v4-flash'),
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
          tools,
          stopWhen: stepCountIs(100),
        });

        for await (const part of result.stream) {
          console.log('[stream]', part.type);
          switch (part.type) {
            case 'text-start':
              // 文本段开始，不做特殊处理
              break;

            case 'text-delta':
              send({ type: 'text', content: (part as any).text });
              break;

            case 'text-end':
              // 文本段结束
              break;

            case 'reasoning-start':
              send({ type: 'text', content: '🧠 ' });
              break;

            case 'reasoning-delta':
              // DeepSeek 等模型可能把思考过程放在 reasoning 里，当作文本输出
              send({ type: 'text', content: (part as any).text });
              break;

            case 'reasoning-end':
              send({ type: 'text', content: '\n' });
              break;

            case 'tool-input-start':
              // 工具参数流式构建开始
              break;

            case 'tool-input-delta':
              // 工具参数的流式增量，可忽略（完整参数在 tool-call 中）
              break;

            case 'tool-input-end':
              break;

            case 'tool-call': {
              const tc = part as any;
              send({
                type: 'tool_call',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.input,
              });
              break;
            }

            case 'tool-result': {
              const tr = part as any;
              send({
                type: 'tool_result',
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                result: tr.output,
              });
              break;
            }

            case 'tool-error': {
              const te = part as any;
              send({
                type: 'tool_error',
                toolCallId: te.toolCallId,
                toolName: te.toolName,
                error: String(te.error),
              });
              break;
            }

            case 'start-step':
              stepIndex++;
              send({ type: 'step_start', index: stepIndex });
              break;

            case 'finish-step': {
              const fs = part as any;
              send({
                type: 'step_finish',
                index: stepIndex,
                finishReason: fs.finishReason,
              });
              break;
            }

            case 'finish': {
              const f = part as any;
              send({
                type: 'done',
                finishReason: f.finishReason,
                usage: f.totalUsage,
              });
              break;
            }

            case 'error':
              send({
                type: 'error',
                error: String((part as any).error),
              });
              break;

            case 'source':
              // 引用来源，暂不处理
              break;

            case 'file':
              // 生成的文件，暂不处理
              break;

            case 'start':
            case 'abort':
            case 'raw':
              break;

            default:
              // 未知事件类型，打印日志以便排查
              console.log('[stream] 未知事件:', part.type, JSON.stringify(part).slice(0, 200));
              break;
          }
        }

        controller.close();
      } catch (err: any) {
        send({ type: 'error', error: err.message || 'Stream error' });
        controller.close();
      } finally {
        // 沙箱生命周期
        if (sandbox) {
          try {
            if (shouldKill) {
              await sandbox.kill();
            } else {
              await sandbox.pause();
            }
          } catch (e: any) {
            console.error('[e2b cleanup]', e.message);
          }
        }
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
