'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Loader2, BookOpen, User } from 'lucide-react';import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface SkillItem {
  name: string;
  description: string;
  source?: 'system' | 'user';
}

/**
 * Skills 管理面板
 * - 系统 Skill：Agent 内置开发规范（src/agent/system-skills/，只读）
 * - 用户 Skill：.agent/skills/ 下的自定义 skill（可添加/删除）
 */
export default function SkillsPanel() {
  const [user, setUser] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 添加表单
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/skills');
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      setUser(data.user || []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(), 0); // 延迟到下一帧，避免 effect 内同步 setState
    return () => clearTimeout(t);
  }, [load]);

  const handleAdd = async () => {
    if (!name.trim() || !content.trim()) {
      setError('名称和内容不能为空');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, content }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '创建失败');
      }
      setName('');
      setDescription('');
      setContent('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (skillName: string) => {
    if (!confirm(`删除用户 skill "${skillName}"？`)) return;
    try {
      const res = await fetch(`/api/skills?name=${encodeURIComponent(skillName)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '删除失败');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const SkillRow = ({ item }: { item: SkillItem }) => {
    const deletable = item.source !== 'system'; // 系统来源不可删
    return (
      <div className="group flex items-start gap-2 rounded-lg border border-gray-100 px-2.5 py-2 hover:bg-gray-50">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs font-medium text-foreground">
              {item.name}
            </span>
            {item.source === 'system' ? (
              <Badge variant="secondary" className="text-[9px]">
                系统
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[9px]">
                用户
              </Badge>
            )}
          </div>
          {item.description && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
              {item.description}
            </p>
          )}
        </div>
        {deletable && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600"
            onClick={() => handleDelete(item.name)}
            title="删除"
          >
            <Trash2 size={13} />
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="system" className="flex h-full flex-col gap-0">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <BookOpen size={14} className="text-blue-500" />
          <span className="text-sm font-medium text-foreground">Skills</span>
          <span className="text-xs text-muted-foreground">
            系统{' '}
            {user.filter((s) => s.source === 'system').length} / 用户{' '}
            {user.filter((s) => s.source === 'user').length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={load}
            title="刷新"
          >
            <Loader2
              size={13}
              className={loading ? 'animate-spin text-blue-500' : 'text-gray-400'}
            />
          </Button>
        </div>

        <TabsList
          variant="line"
          className="h-9 w-full justify-start rounded-none border-b bg-transparent px-1"
        >
          <TabsTrigger value="system">
            <BookOpen size={13} /> 系统 Skill
          </TabsTrigger>
          <TabsTrigger value="user">
            <User size={13} /> 用户 Skill
          </TabsTrigger>
        </TabsList>

        {/* 系统 Skill（Agent 内置，只读） */}
        <TabsContent value="system" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-1.5 p-3">
              <p className="text-[11px] text-muted-foreground">
                Agent 内置开发规范（src/agent/system-skills/），只读。任务匹配
                适用场景时 Agent 会自动 read_skill 加载，也可
                <code className="mx-1 rounded bg-gray-100 px-1 font-mono">@skill-name</code>
                强制指定。
              </p>
              {user.filter((s) => s.source === 'system').length === 0 &&
              !loading ? (
                <p className="py-4 text-center text-xs text-gray-400">暂无系统 skill</p>
              ) : (
                user
                  .filter((s) => s.source === 'system')
                  .map((s) => <SkillRow key={s.name} item={s} />)
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* 用户 Skill（可增删） */}
        <TabsContent value="user" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-1.5 p-3">
              <p className="text-[11px] text-muted-foreground">
                你自己的 skill，存放在
                <code className="mx-1 rounded bg-gray-100 px-1 font-mono">.agent/skills/</code>
                。Agent 可通过 read_skill 加载。
              </p>
              {user.filter((s) => s.source === 'user').length === 0 && !loading ? (
                <p className="py-4 text-center text-xs text-gray-400">
                  暂无用户 skill，在下方添加一个
                </p>
              ) : (
                user
                  .filter((s) => s.source === 'user')
                  .map((s) => <SkillRow key={s.name} item={s} />)
              )}

              <Separator className="my-3" />

              {/* 添加表单 */}
              <div className="rounded-lg border border-gray-200 p-3">
                <p className="mb-2 text-xs font-medium text-foreground">
                  添加新 Skill
                </p>
                <div className="space-y-2">
                  <Input
                    placeholder="名称（如 my-workflow）"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Input
                    placeholder="一句话描述（可选）"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Textarea
                    placeholder="Skill 内容（markdown，含使用说明）"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[90px] text-xs"
                  />
                  {error && <p className="text-xs text-red-500">{error}</p>}
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={handleAdd}
                    disabled={submitting}
                  >
                    {submitting ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Plus size={13} />
                    )}
                    保存到 .agent/skills/
                  </Button>
                </div>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
