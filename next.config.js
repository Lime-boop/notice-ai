/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@ohah/hwpjs'],
  },
};

module.exports = nextConfig;
