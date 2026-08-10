'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { X, Folder, FolderOpen, File, RefreshCw, Globe, Terminal, ChevronRight, ChevronDown, Loader2, ExternalLink } from 'lucide-react';

// ── 类型 ──

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

interface TerminalEntry {
  time: string;
  text: string;
  type: 'stdout' | 'stderr' | 'info';
}

// ── 文件树节点 ──

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
  onToggle,
  expanded,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  expanded: boolean;
}) {
  const isSelected = selectedPath === node.path;
  const padLeft = depth * 16;

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer text-xs hover:bg-gray-100 rounded ${
          isSelected ? 'bg-blue-100 text-blue-700' : 'text-gray-700'
        }`}
        style={{ paddingLeft: 8 + padLeft }}
        onClick={() => {
          if (node.isDir) {
            onToggle(node.path);
          } else {
            onSelect(node.path);
          }
        }}
      >
        {node.isDir ? (
          <>
            <span className="shrink-0">
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </span>
            {expanded ? (
              <FolderOpen size={14} className="text-yellow-500 shrink-0" />
            ) : (
              <Folder size={14} className="text-yellow-600 shrink-0" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <File size={14} className="text-gray-400 shrink-0" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {node.isDir && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
              expanded={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 主组件 ──

export default function SandboxPanel({
  sandboxId,
  terminalLines = [],
  onSandboxExpired,
}: {
  sandboxId: string | null;
  terminalLines?: TerminalEntry[];
  onSandboxExpired?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'files' | 'preview' | 'terminal'>('files');
  const [sandboxExpired, setSandboxExpired] = useState(false);
  // 用 ref 保存过期回调，避免流式更新时父组件内联函数变化导致 effect 重跑
  const expiredRef = useRef(onSandboxExpired);
  useEffect(() => {
    expiredRef.current = onSandboxExpired;
  }, [onSandboxExpired]);

  // 文件浏览状态
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // 端口预览状态
  const [previewPort, setPreviewPort] = useState('3000');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hostLoading, setHostLoading] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [portListening, setPortListening] = useState<boolean | null>(null);
  const [portProcess, setPortProcess] = useState<string>('');
  const [iframeKey, setIframeKey] = useState(0);

  // 终端输出由父组件传入

  // ── 文件树加载 ──
  useEffect(() => {
    if (!sandboxId || activeTab !== 'files') return;

    let cancelled = false;

    (async () => {
      setFileLoading(true);
      try {
        const res = await apiFetch(
          `/api/sandbox?action=files&sandboxId=${sandboxId}&dir=/home/user`,
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (body.expired || res.status === 410) {
            if (!cancelled) {
              setSandboxExpired(true);
              expiredRef.current?.();
            }
            return;
          }
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        if (!cancelled) setFileTree(body.tree || []);
      } catch (err: unknown) {
        if (!cancelled) console.error('加载文件树失败:', err);
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sandboxId, activeTab]);

  // ── 文件内容加载 ──
  const loadFileContent = useCallback(
    async (path: string) => {
      if (!sandboxId) return;
      setFileContentLoading(true);
      setSelectedPath(path);
      try {
        const res = await apiFetch(
          `/api/sandbox?action=read&sandboxId=${sandboxId}&path=${encodeURIComponent(path)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setFileContent(data.content ?? '(空文件)');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '未知错误';
        setFileContent(`读取失败: ${msg}`);
      } finally {
        setFileContentLoading(false);
      }
    },
    [sandboxId],
  );

  // ── 端口预览 ──
  const loadHost = useCallback(async () => {
    if (!sandboxId) return;
    setHostLoading(true);
    setHostError(null);
    try {
      const port = parseInt(previewPort, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        setHostError('无效端口号');
        setHostLoading(false);
        return;
      }
      const res = await apiFetch(
        `/api/sandbox?action=host&sandboxId=${sandboxId}&port=${port}`,
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const rawHost: string = data.host || '';
      const url = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
      setPreviewUrl(url);
      setPortListening(data.listening);
      setPortProcess(data.processInfo || '');
      setIframeKey((k) => k + 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '未知错误';
      setHostError(msg);
      setPreviewUrl(null);
    } finally {
      setHostLoading(false);
    }
  }, [sandboxId, previewPort]);

  // ── 目录展开/折叠 ──
  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // ── 沙箱已过期（被 e2b 回收） ──
  if (sandboxExpired) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        <div className="text-center px-6">
          <X size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-gray-500 font-medium mb-1">沙箱已过期</p>
          <p className="text-xs text-gray-400">
            该沙箱因长时间未使用已被回收。
            <br />
            请重新发送任务以创建新沙箱。
          </p>
        </div>
      </div>
    );
  }

  // ── 无沙箱状态 ──
  if (!sandboxId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        <div className="text-center">
          <Terminal size={32} className="mx-auto mb-2 opacity-30" />
          <p>等待 Agent 启动沙箱...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Tab 栏（shadcn Tabs） */}
      <Tabs
        value={activeTab}
        onValueChange={(v) =>
          setActiveTab((v as 'files' | 'preview' | 'terminal') || 'files')
        }
        className="flex h-full flex-col gap-0"
      >
        <TabsList
          variant="line"
          className="h-9 w-full justify-start rounded-none border-b bg-transparent px-1"
        >
          <TabsTrigger value="files">
            <Folder size={14} /> 文件
          </TabsTrigger>
          <TabsTrigger value="preview">
            <Globe size={14} /> 预览
          </TabsTrigger>
          <TabsTrigger value="terminal">
            <Terminal size={14} /> 终端
          </TabsTrigger>
        </TabsList>

        {/* ═══ 文件浏览器 ═══ */}
        <TabsContent value="files" className="min-h-0 flex-1">
          <div className="h-full flex flex-col">
            {/* 工具栏 */}
            <div className="flex items-center gap-2 px-2 py-1.5 border-b bg-gray-50 shrink-0">
              <span className="text-xs text-gray-500 font-mono">/home/user</span>
              <button
                onClick={() => {
                  // 强制重新加载：通过切换 tab 再切回来
                  setFileTree([]);
                  setFileLoading(true);
                  apiFetch(`/api/sandbox?action=files&sandboxId=${sandboxId}&dir=/home/user`)
                    .then((r) => r.json())
                    .then((d) => setFileTree(d.tree || []))
                    .catch(console.error)
                    .finally(() => setFileLoading(false));
                }}
                disabled={fileLoading}
                className="ml-auto p-1 hover:bg-gray-200 rounded"
                title="刷新"
              >
                <RefreshCw
                  size={12}
                  className={fileLoading ? 'animate-spin text-blue-500' : 'text-gray-500'}
                />
              </button>
            </div>

            {/* 主体：文件树 + 内容预览 */}
            <div className="flex-1 flex overflow-hidden">
              {/* 文件树 */}
              <div className="w-1/2 border-r overflow-auto">
                {fileLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 size={16} className="animate-spin text-gray-400" />
                  </div>
                ) : fileTree.length === 0 ? (
                  <p className="text-gray-400 text-xs p-4">沙箱中暂无文件</p>
                ) : (
                  fileTree.map((node) => (
                    <TreeNode
                      key={node.path}
                      node={node}
                      depth={0}
                      selectedPath={selectedPath}
                      onSelect={loadFileContent}
                      onToggle={toggleDir}
                      expanded={expandedDirs.has(node.path)}
                    />
                  ))
                )}
              </div>

              {/* 文件内容预览 */}
              <div className="w-1/2 flex flex-col overflow-hidden">
                <div className="flex items-center gap-1 px-2 py-1 border-b bg-gray-50 shrink-0">
                  {selectedPath ? (
                    <>
                      <span className="text-xs text-gray-600 font-mono truncate flex-1">
                        {selectedPath}
                      </span>
                      <button
                        onClick={() => {
                          setSelectedPath(null);
                          setFileContent(null);
                        }}
                        className="p-0.5 hover:bg-gray-200 rounded"
                      >
                        <X size={12} className="text-gray-400" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-gray-400">点击左侧文件查看</span>
                  )}
                </div>
                <div className="flex-1 overflow-auto p-2">
                  {fileContentLoading ? (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 size={16} className="animate-spin text-gray-400" />
                    </div>
                  ) : fileContent !== null ? (
                    <pre className="text-xs font-mono text-gray-800 whitespace-pre-wrap break-all leading-relaxed">
                      {fileContent}
                    </pre>
                  ) : (
                    <p className="text-gray-300 text-xs text-center mt-8">
                      选择文件以预览内容
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ═══ 端口预览 ═══ */}
        <TabsContent value="preview" className="min-h-0 flex-1">
          <div className="h-full flex flex-col">
            {/* 端口输入 */}
            <div className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50 shrink-0">
              <span className="text-xs text-gray-500">端口</span>
              <input
                type="number"
                value={previewPort}
                onChange={(e) => setPreviewPort(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadHost()}
                className="w-20 px-2 py-1 text-xs border rounded font-mono"
                placeholder="3000"
                min={1}
                max={65535}
              />
              <button
                onClick={loadHost}
                disabled={hostLoading}
                className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1"
              >
                {hostLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Globe size={12} />
                )}
                连接
              </button>
              {portListening !== null && (
                <span className={`text-xs flex items-center gap-1 ${
                  portListening ? 'text-green-600' : 'text-orange-500'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    portListening ? 'bg-green-500' : 'bg-orange-400'
                  }`} />
                  {portListening ? `端口 ${previewPort} 已监听` : `端口 ${previewPort} 未监听`}
                </span>
              )}
              {previewUrl && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600"
                >
                  <ExternalLink size={12} />
                  新窗口打开
                </a>
              )}
            </div>

            {/* 预览区 */}
            <div className="flex-1 relative">
              {hostError && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                  <div className="text-center max-w-xs">
                    <p className="text-red-500 text-sm mb-1">连接失败</p>
                    <p className="text-gray-500 text-xs">{hostError}</p>
                  </div>
                </div>
              )}
              {portListening === false && !hostError && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                  <div className="text-center max-w-xs">
                    <p className="text-orange-500 text-sm mb-1">端口 {previewPort} 没有服务在监听</p>
                    <p className="text-gray-400 text-xs">
                      请确认 Agent 已在该端口启动了服务。{'\n'}
                      可在终端 Tab 查看 Agent 的命令输出。
                    </p>
                    {portProcess && (
                      <p className="text-gray-500 text-xs mt-2 font-mono">{portProcess}</p>
                    )}
                  </div>
                </div>
              )}
              {previewUrl ? (
                <iframe
                  key={iframeKey}
                  src={previewUrl}
                  className="w-full h-full border-0"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  title="沙箱预览"
                />
              ) : !hostError ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center text-gray-400">
                    <Globe size={40} className="mx-auto mb-2 opacity-20" />
                    <p className="text-sm">输入端口号并点击&ldquo;连接&rdquo;</p>
                    <p className="text-xs mt-1 text-gray-300">
                      沙箱内运行的服务可通过 e2b 公网 URL 访问
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </TabsContent>

        {/* ═══ 终端输出 ═══ */}
        <TabsContent value="terminal" className="min-h-0 flex-1">
          <div className="h-full flex flex-col bg-gray-900">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700 shrink-0">
              <Terminal size={12} className="text-green-400" />
              <span className="text-xs text-gray-400 font-mono">命令执行输出</span>
              <span className="text-xs text-gray-600 ml-auto">
                {terminalLines.length} 条
              </span>
              <button
                onClick={() => {}}
                className="p-0.5 hover:bg-gray-700 rounded"
                title="终端由父组件管理"
              >
                <X size={12} className="text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed">
              {terminalLines.length === 0 ? (
                <p className="text-gray-600 text-center mt-8">
                  Agent 执行命令的输出将显示在这里
                </p>
              ) : (
                terminalLines.map((entry, i) => (
                  <div
                    key={i}
                    className={`py-0.5 ${
                      entry.type === 'stderr'
                        ? 'text-red-400'
                        : entry.type === 'stdout'
                          ? 'text-green-300'
                          : 'text-gray-500'
                    }`}
                  >
                    <span className="text-gray-600 mr-2">{entry.time}</span>
                    {entry.text}
                  </div>
                ))
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// 导出 addTerminalEntry 的类型，供外部通过 ref 调用
export type { TerminalEntry };
