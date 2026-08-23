'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Check, KeyRound, Box, MessageCircle, Loader2 } from 'lucide-react';

export interface QQBotConfig {
  appId: string;
  appSecret: string;
  openid: string;
}

interface Props {
  apiKey: string;
  e2bApiKey: string;
  qqBot: QQBotConfig;
  onSave: (apiKey: string, e2bApiKey: string, qqBot: QQBotConfig) => void;
}

export default function ApiKeySettings({ apiKey, e2bApiKey, qqBot, onSave }: Props) {
  const [inputDeepseek, setInputDeepseek] = useState(apiKey);
  const [inputE2b, setInputE2b] = useState(e2bApiKey);
  const [inputQQAppId, setInputQQAppId] = useState(qqBot.appId);
  const [inputQQSecret, setInputQQSecret] = useState(qqBot.appSecret);
  const [inputQQOpenid, setInputQQOpenid] = useState(qqBot.openid);
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  // QQ 机器人绑定（WebSocket 拿 openid）
  const [binding, setBinding] = useState(false);
  const [bindStatus, setBindStatus] = useState<string>('');
  const [bindError, setBindError] = useState('');

  const hasAnyKey = !!(apiKey || e2bApiKey || qqBot.appId || qqBot.appSecret);

  // props 变化时同步输入框（如从 localStorage 恢复后）
  useEffect(() => {
    setInputDeepseek(apiKey);
    setInputE2b(e2bApiKey);
    setInputQQAppId(qqBot.appId);
    setInputQQSecret(qqBot.appSecret);
    setInputQQOpenid(qqBot.openid);
  }, [apiKey, e2bApiKey, qqBot]);

  const handleSave = () => {
    onSave(inputDeepseek.trim(), inputE2b.trim(), {
      appId: inputQQAppId.trim(),
      appSecret: inputQQSecret.trim(),
      openid: inputQQOpenid.trim(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const handleClear = () => {
    setInputDeepseek('');
    setInputE2b('');
    setInputQQAppId('');
    setInputQQSecret('');
    setInputQQOpenid('');
    onSave('', '', { appId: '', appSecret: '', openid: '' });
  };

  // 绑定机器人：POST 请求内服务端建立 WebSocket 同步等待，直接返回 openid（适配 Railway 多实例）
  const handleBind = async () => {
    if (binding) return;
    setBinding(true);
    setBindError('');
    setBindStatus('正在连接 QQ 网关，请用 QQ 私聊机器人发一条消息…');

    const appId = inputQQAppId.trim();
    const appSecret = inputQQSecret.trim();

    try {
      const res = await fetch('/api/qqbot/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appId && appSecret ? { appId, appSecret } : {}),
      });
      const data = await res.json();
      if (res.ok && data.status === 'done' && data.openid) {
        setInputQQOpenid(data.openid);
        setBindStatus('✅ 已获取 openid，点击「保存」生效');
      } else {
        setBindError(data.error || '绑定失败');
        setBindStatus('');
      }
    } catch {
      setBindError('绑定请求失败（可能超时，请重试）');
      setBindStatus('');
    } finally {
      setBinding(false);
    }
  };

  return (
    <div>
      {/* 说明 */}
      <p className="text-xs text-gray-500 mb-4 leading-relaxed">
        填写你自己的 API Keys。仅保存在当前浏览器 (localStorage)，
        不会上传服务器或提交到 Git。留空则使用服务端环境变量。
      </p>

      {/* DeepSeek API Key */}
      <label className="block text-xs font-medium text-gray-600 mb-1">
        DeepSeek API Key
        <span className="text-gray-400 font-normal">
          （环境变量: <code className="bg-gray-100 px-1 rounded">DEEPSEEK_API_KEY</code>）
        </span>
      </label>
      <div className="flex items-center gap-2 border rounded-lg px-3 py-2 mb-4 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
        <KeyRound size={14} className="text-gray-400 shrink-0" />
        <input
          type={show ? 'text' : 'password'}
          className="flex-1 text-sm outline-none bg-transparent"
          placeholder="sk-..."
          value={inputDeepseek}
          onChange={(e) => setInputDeepseek(e.target.value)}
        />
        <button
          onClick={() => setShow((v) => !v)}
          className="text-gray-400 hover:text-gray-600 shrink-0"
          title={show ? '隐藏' : '显示'}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {/* E2B API Key */}
      <label className="block text-xs font-medium text-gray-600 mb-1">
        E2B 沙箱 API Key
        <span className="text-gray-400 font-normal">
          （环境变量: <code className="bg-gray-100 px-1 rounded">E2B_API_KEY</code>）
        </span>
      </label>
      <div className="flex items-center gap-2 border rounded-lg px-3 py-2 mb-4 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
        <Box size={14} className="text-gray-400 shrink-0" />
        <input
          type={show ? 'text' : 'password'}
          className="flex-1 text-sm outline-none bg-transparent"
          placeholder="e2b_..."
          value={inputE2b}
          onChange={(e) => setInputE2b(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
        />
        <button
          onClick={() => setShow((v) => !v)}
          className="text-gray-400 hover:text-gray-600 shrink-0"
          title={show ? '隐藏' : '显示'}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {/* QQ 机器人（任务完成通知） */}
      <div className="border-t border-gray-100 pt-3">
        <div className="flex items-center gap-2 mb-2">
          <MessageCircle size={14} className="text-gray-500" />
          <span className="text-xs font-medium text-gray-600">
            QQ 机器人通知（任务完成后推送）
          </span>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">
          QQ Bot AppID
        </label>
        <div className="flex items-center gap-2 border rounded-lg px-3 py-2 mb-3 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
          <KeyRound size={14} className="text-gray-400 shrink-0" />
          <input
            className="flex-1 text-sm outline-none bg-transparent"
            placeholder="1905478960"
            value={inputQQAppId}
            onChange={(e) => setInputQQAppId(e.target.value)}
          />
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">
          QQ Bot AppSecret
        </label>
        <div className="flex items-center gap-2 border rounded-lg px-3 py-2 mb-3 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
          <KeyRound size={14} className="text-gray-400 shrink-0" />
          <input
            type={show ? 'text' : 'password'}
            className="flex-1 text-sm outline-none bg-transparent"
            placeholder="留空则用环境变量 QQ_BOT_APP_SECRET"
            value={inputQQSecret}
            onChange={(e) => setInputQQSecret(e.target.value)}
          />
          <button
            onClick={() => setShow((v) => !v)}
            className="text-gray-400 hover:text-gray-600 shrink-0"
            title={show ? '隐藏' : '显示'}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">
          接收者（user_openid）
        </label>
        <div className="flex items-center gap-2 border rounded-lg px-3 py-2 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
          <MessageCircle size={14} className="text-gray-400 shrink-0" />
          <input
            className="flex-1 text-sm outline-none bg-transparent"
            placeholder="绑定后自动填入（或留空用环境变量）"
            value={inputQQOpenid}
            onChange={(e) => setInputQQOpenid(e.target.value)}
          />
        </div>

        {/* 绑定机器人：一键通过 WebSocket 获取 openid */}
        <button
          onClick={handleBind}
          disabled={binding}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-blue-200 text-blue-600 rounded-lg text-xs hover:bg-blue-50 disabled:opacity-50"
        >
          {binding ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              绑定中…
            </>
          ) : (
            '绑定机器人（自动获取 openid）'
          )}
        </button>
        {bindStatus && (
          <p className="text-[11px] text-blue-600 mt-1 leading-relaxed">{bindStatus}</p>
        )}
        {bindError && (
          <p className="text-[11px] text-red-500 mt-1 leading-relaxed">{bindError}</p>
        )}
        <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
          点「绑定」后会自动连接 QQ 网关，然后用 QQ 私聊机器人发一条消息，即可自动回填 openid。
        </p>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={handleSave}
          className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600 disabled:opacity-50"
          disabled={saved}
        >
          {saved ? (
            <>
              <Check size={14} /> 已保存
            </>
          ) : (
            '保存'
          )}
        </button>
        {hasAnyKey && (
          <button
            onClick={handleClear}
            className="px-3 py-2 border border-red-200 text-red-500 rounded-lg text-sm hover:bg-red-50"
          >
            清除
          </button>
        )}
      </div>
    </div>
  );
}
