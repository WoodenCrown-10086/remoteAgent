import { Sandbox } from '@e2b/code-interpreter';

/**
 * GET /api/sandbox?action=list&sandboxId=xxx           — 扁平文件列表（find 命令）
 * GET /api/sandbox?action=files&sandboxId=xxx&dir=/     — 结构化文件树（e2b files API）
 * GET /api/sandbox?action=read&sandboxId=xxx&path=...   — 读取文件内容
 * GET /api/sandbox?action=host&sandboxId=xxx&port=3000  — 获取端口公网 URL
 */

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

async function buildFileTree(
  sandbox: Sandbox,
  dir: string,
  depth: number = 0,
): Promise<FileNode[]> {
  if (depth > 4) return [];
  const maxItems = 200;

  console.log(`[files] list dir=${dir} depth=${depth}`);
  const entries = await sandbox.files.list(dir);
  const nodes: FileNode[] = [];

  for (const entry of entries.slice(0, maxItems)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const node: FileNode = {
      name: entry.name,
      path: entry.path,
      isDir: entry.type === 'dir',
    };

    if (node.isDir && depth < 3) {
      try {
        node.children = await buildFileTree(sandbox, entry.path, depth + 1);
      } catch (err) {
        console.error(`[files] 跳过目录 ${entry.path}:`, err instanceof Error ? err.message : err);
        node.children = [];
      }
    }

    nodes.push(node);
  }

  return nodes;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const sandboxId = searchParams.get('sandboxId');
  const filePath = searchParams.get('path');
  const portStr = searchParams.get('port');

  // e2b API key（前端设置优先，回退环境变量）
  const e2bApiKey = req.headers.get('x-e2b-api-key') || undefined;

  if (!sandboxId) {
    return Response.json({ error: '缺少 sandboxId' }, { status: 400 });
  }

  let sandbox: Sandbox | null = null;
  try {
    sandbox = (await Sandbox.connect(sandboxId, {
      timeoutMs: 30_000,
      apiKey: e2bApiKey,
    })) as Sandbox;
    // ── 扁平文件列表（find 命令，兼容旧版） ──
    if (action === 'list') {
      const result = await sandbox.commands.run(
        `find /home/user -maxdepth 5 -not -path '*/\\.*' -not -path '*/node_modules/*' | sort | head -n 100`,
        { timeoutMs: 5_000 },
      );

      const files = result.stdout.trim().split('\n').filter(Boolean);
      return Response.json({ files, count: files.length });
    }

    // ── 结构化文件树（e2b files API，失败时回退到 find 命令） ──
    if (action === 'files') {
      const dir = filePath || '/home/user';
      try {
        const tree = await buildFileTree(sandbox, dir);
        return Response.json({ tree, root: dir });
      } catch (filesErr) {
        console.error(`[files] buildFileTree 失败，回退到 find:`, filesErr);
        // 回退：用 find 命令获取扁平列表
        const result = await sandbox.commands.run(
          `find ${dir} -maxdepth 5 -not -path '*/\\.*' -not -path '*/node_modules/*' | sort | head -n 200`,
          { timeoutMs: 5_000 },
        );
        const entries = result.stdout.trim().split('\n').filter(Boolean);
        const tree: FileNode[] = entries.map((p) => ({
          name: p.split('/').pop() || p,
          path: p,
          isDir: false,
        }));
        return Response.json({ tree, root: dir, fallback: true });
      }
    }

    // ── 读取文件内容 ──
    if (action === 'read') {
      if (!filePath) {
        return Response.json({ error: '缺少 path 参数' }, { status: 400 });
      }
      const fullPath = filePath.startsWith('/')
        ? filePath
        : `/home/user/${filePath}`;

      const content = await sandbox.files.read(fullPath, { format: 'text' });
      return Response.json({ path: filePath, content });
    }

    // ── 获取端口公网 URL ──
    if (action === 'host') {
      const port = parseInt(portStr || '3000', 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return Response.json({ error: '无效端口号' }, { status: 400 });
      }
      const host = sandbox.getHost(port);

      // 诊断：检查端口是否真的在监听
      let listening = false;
      let processInfo = '';
      try {
        const check = await sandbox.commands.run(
          `ss -tlnp 2>/dev/null | grep ':${port} ' || echo 'NOT_LISTENING'`,
          { timeoutMs: 3_000 },
        );
        if (!check.stdout.includes('NOT_LISTENING')) {
          listening = true;
          processInfo = check.stdout.trim();
        }
      } catch {
        // 诊断失败不影响主流程
      }

      return Response.json({ port, host, listening, processInfo });
    }

    return Response.json(
      { error: `无效 action: ${action}，支持 list / files / read / host` },
      { status: 400 },
    );
  } catch (error: unknown) {
    console.error(`[sandbox] action=${action} sandboxId=${sandboxId} 失败:`, error);
    const msg = error instanceof Error ? error.message : '操作失败';
    // 识别沙箱过期/被回收：e2b 对暂停超时的沙箱会报 not found
    const expired =
      /not found|does not exist|expired|not exist/i.test(msg) &&
      /sandbox|paused|terminated/i.test(msg);
    return Response.json(
      { error: msg, action, expired: expired || undefined },
      { status: expired ? 410 : 500 },
    );
  }
}
