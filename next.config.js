
/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverActions: {
    bodySizeLimit: '4.5mb',
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
    // 'fs' module not found error in tiff.js and other libraries.
    // This fallback prevents the error by telling webpack to ignore 'fs' resolution.
    config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false
    };

    return config;
  },
};

module.exports = nextConfig;
