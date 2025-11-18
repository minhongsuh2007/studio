
/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      }
    ],
  },
  webpack: (config, { isServer }) => {
    // This is required to make `sharp` work correctly with Next.js
    // 'fs' is a server-side module, and this prevents it from being bundled into the client.
    if (!isServer) {
        config.resolve.fallback = {
            ...config.resolve.fallback,
            fs: false
        };
    }
    // For server-side, we can tell webpack that 'fs' is an external module
    // This is often needed for libraries that have optional 'fs' dependencies.
    if (isServer) {
        config.externals.push('fs');
    }

    return config;
  },
};

module.exports = nextConfig;
