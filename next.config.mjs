/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['*.e2b.app'],
  serverExternalPackages: ['puppeteer', 'puppeteer-core', 'cheerio'],
  poweredByHeader: false
};
export default nextConfig;
