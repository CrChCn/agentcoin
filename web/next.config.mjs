/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  outputFileTracingRoot: new URL('.', import.meta.url).pathname,
  distDir: 'out',
  images: { unoptimized: true },
  trailingSlash: false,
};
export default nextConfig;
