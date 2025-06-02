
import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
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
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
    ],
  },
  webpack: (config, { isServer }) => {
    // Fix for 'fs' and 'path' modules not found errors with tiff.js on the client side
    if (!isServer) {
      // Ensure resolve and fallback objects exist before modifying
      config.resolve = config.resolve || {};
      config.resolve.fallback = config.resolve.fallback || {};
      
      // Add fallbacks for fs and path
      config.resolve.fallback.fs = false;
      config.resolve.fallback.path = false;
    }
    return config;
  },
};

export default nextConfig;
