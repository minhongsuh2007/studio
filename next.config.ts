
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
  // Webpack configuration for 'fs' and 'path' fallbacks removed as tiff.js is removed
};

export default nextConfig;
