
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
  devIndicators: {
    allowedDevOrigins: [
      '9000-firebase-studio-1748835848084.cluster-zkm2jrwbnbd4awuedc2alqxrpk.cloudworkstations.dev',
      '6000-firebase-studio-1748835848084.cluster-zkm2jrwbnbd4awuedc2alqxrpk.cloudworkstations.dev',
    ],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // For client-side bundle, provide a fallback for 'fs' and 'path'
      // This prevents errors when libraries like tiff.js try to use them
      config.resolve = {
        ...config.resolve,
        fallback: {
          ...(config.resolve?.fallback || {}), // Spread existing fallbacks if any
          fs: false,
          path: false,
        },
      };
    }
    // Important: return the modified config
    return config;
  },
};

export default nextConfig;
