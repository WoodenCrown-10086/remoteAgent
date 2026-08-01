'use client';

import { useEffect, useState } from 'react';
import { Settings, X, Eye, EyeOff, Check, KeyRound, Box } from 'lucide-react';

interface Props {
  apiKey: string;
  e2bApiKey: string;
  onSave: (apiKey: string, e2bApiKey: string) => void;
}

export default function ApiKeySettings({ apiKey, e2bApiKey, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [inputDeepseek, setInputDeepseek] = useState('');
  const [inputE2b, setInputE2b] = useState('');
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  const hasAnyKey = !!(apiKey || e2bApiKey);

  // 打开弹窗时同步当前 key
  useEffect(() => {
    if (open) {
      setInputDeepseek(apiKey);
      setInputE2b(e2bApiKey);
    }
  }, [open, apiKey, e2bApiKey]);

  const handleSave = () => {
    onSave(inputDeepseek.trim(), inputE2b.trim());
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      setOpen(false);
    }, 800);
  };

  const handleClear = () => {
    setInputDeepseek('');
    setInputE2b('');
    onSave('', '');
  };

  return (
    <>
      {/* 设置按钮 */}
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
          hasAnyKey ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'
        }`}
        title={hasAnyKey ? 'API Keys 已配置' : '未配置 API Keys，点击设置'}
      >
        <KeyRound size={14} className={hasAnyKey ? 'text-green-500' : ''} />
        {hasAnyKey ? 'Keys 已配置' : '设置 API Keys'}
      </button>

      {/* 弹窗 */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-[440px] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Settings size={16} className="text-gray-600" />
                <span className="font-medium text-gray-800">API Keys 配置</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-1 hover:bg-gray-100 rounded text-gray-400"
              >
                <X size={16} />
              </button>
            </div>

            {/* 说明 */}
            <p className="text-xs text-gray-500 mb-3 leading-relaxed">
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
            <div className="flex items-center gap-2 border rounded-lg px-3 py-2 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
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
        </div>
      )}
    </>
  );
}
