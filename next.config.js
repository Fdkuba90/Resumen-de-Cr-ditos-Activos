// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // importante: NO usar output: 'export'
  output: 'standalone'
};

module.exports = nextConfig;
