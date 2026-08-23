import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSE 流式响应不能被 gzip 压缩缓冲，否则流式效果消失
  compress: false,
  // 允许通过 127.0.0.1 访问 dev 资源（HMR 等），否则用 127.0.0.1 打开会被跨域阻止
  // 追加内网穿透公网域名（cpolar/ngrok），否则通过穿透地址访问会一直转圈
  allowedDevOrigins: [
    '127.0.0.1',
    'localhost',
    '*.cpolar.cn',
    '*.vip.cpolar.cn',
    '*.ngrok-free.app',
    '*.ngrok.app',
  ],
};

export default nextConfig;
