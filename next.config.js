// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // mantenlo si te sirve para Docker/self-host
  swcMinify: true       // (predeterminado, pero lo dejamos explícito)
};

module.exports = nextConfig;
