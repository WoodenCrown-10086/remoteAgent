import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSE 流式响应不能被 gzip 压缩缓冲，否则流式效果消失
  compress: false,
};

export default nextConfig;
