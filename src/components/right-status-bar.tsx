'use client';

import { Box, ScrollText, Terminal, KeyRound, Trash2, Loader2, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export type PanelKey = 'sandbox' | 'logs' | 'terminal' | 'apikey' | 'skills';

interface Props {
  activePanel: PanelKey | null;
  onPanelChange: (key: PanelKey) => void;
  sandboxId: string | null;
  loading: boolean;
  logCount: number;
  terminalCount: number;
  onKillSandbox: () => void;
}

function StatusButton({
  label,
  icon,
  active,
  badge,
  onClick,
  sandboxAlive,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  badge?: number;
  onClick: () => void;
  sandboxAlive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" className="h-12 w-12 rounded-none" />}>
        <span
          onClick={onClick}
          className={`relative flex h-full w-full flex-col items-center justify-center gap-1 rounded-none ${
            active ? 'text-blue-600' : 'text-gray-500'
          }`}
        >
          <span className="relative">
            {icon}
            {sandboxAlive && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-green-500" />
            )}
          </span>
          <span className="text-[10px] leading-none">{label}</span>
          {badge !== undefined && badge > 0 && (
            <Badge
              variant="destructive"
              className="absolute top-1 right-1.5 h-4 min-w-4 rounded-full px-1 text-[9px]"
            >
              {badge > 99 ? '99+' : badge}
            </Badge>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 右侧垂直状态栏 — 收纳所有次要功能入口（沙箱、日志、终端、API Key、销毁），
 * 点击后从聊天区右侧展开对应抽屉面板（shadcn Sheet）。
 */
export default function RightStatusBar({
  activePanel,
  onPanelChange,
  sandboxId,
  loading,
  logCount,
  terminalCount,
  onKillSandbox,
}: Props) {
  return (
    <TooltipProvider delay={200}>
      <div className="flex w-14 shrink-0 flex-col items-stretch border-l bg-white z-30">
        <StatusButton
          label="沙箱"
          icon={<Box size={15} className={sandboxId ? 'text-green-600' : ''} />}
          active={activePanel === 'sandbox'}
          onClick={() => onPanelChange('sandbox')}
          sandboxAlive={!!sandboxId}
        />
        <StatusButton
          label="日志"
          icon={<ScrollText size={15} />}
          active={activePanel === 'logs'}
          badge={logCount}
          onClick={() => onPanelChange('logs')}
        />
        <StatusButton
          label="终端"
          icon={<Terminal size={15} />}
          active={activePanel === 'terminal'}
          badge={terminalCount}
          onClick={() => onPanelChange('terminal')}
        />
        <StatusButton
          label="API"
          icon={<KeyRound size={15} />}
          active={activePanel === 'apikey'}
          onClick={() => onPanelChange('apikey')}
        />
        <StatusButton
          label="Skills"
          icon={<BookOpen size={15} />}
          active={activePanel === 'skills'}
          onClick={() => onPanelChange('skills')}
        />

        <Separator className="mx-2 my-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="h-12 w-12 rounded-none disabled:opacity-50"
                disabled={!sandboxId || loading}
              />
            }
          >
            <span
              onClick={onKillSandbox}
              className={`flex h-full w-full flex-col items-center justify-center gap-1 rounded-none ${
                sandboxId ? 'text-red-500' : 'text-gray-300'
              }`}
            >
              {loading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Trash2 size={15} />
              )}
              <span className="text-[10px] leading-none">销毁</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">销毁沙箱</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
