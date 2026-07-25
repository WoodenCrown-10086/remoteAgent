import { Sandbox } from '@e2b/code-interpreter';

/**
 * GET /api/sandbox?action=list&sandboxId=xxx
 * GET /api/sandbox?action=read&sandboxId=xxx&path=src/hello.js
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const sandboxId = searchParams.get('sandboxId');
  const filePath = searchParams.get('path');

  if (!sandboxId) {
    return Response.json({ error: '缺少 sandboxId' }, { status: 400 });
  }

  let sandbox: Sandbox | null = null;
  try {
    sandbox = (await Sandbox.connect(sandboxId, {
      timeoutMs: 30_000,
    })) as Sandbox;

    if (action === 'list') {
      // 列出 /home/user 下的文件树
      const result = await sandbox.commands.run(
        `find /home/user -maxdepth 5 -not -path '*/\\.*' -not -path '*/node_modules/*' | sort | head -n 100`,
        { timeoutMs: 5_000 },
      );

      const files = result.stdout.trim().split('\n').filter(Boolean);
      return Response.json({ files, count: files.length });
    }

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

    return Response.json(
      { error: `无效 action: ${action}，支持 list / read` },
      { status: 400 },
    );
  } catch (error: any) {
    return Response.json(
      { error: error.message || '操作失败' },
      { status: 500 },
    );
  } finally {
    // 不改变沙箱状态：connect 不会自动 pause，直接断开即可
    // sandbox 本身没有 disconnect，不需要操作
  }
}
