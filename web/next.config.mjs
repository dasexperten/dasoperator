/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  // Generate fresh build IDs every deploy — sidesteps CF Pages CDN
  // glitches that pin chunk filenames at HTTP 500.
  generateBuildId: async () => `build-${Date.now()}`,
};

export default nextConfig;
