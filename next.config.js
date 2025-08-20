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
        config.resolve.fallback = {
            ...config.resolve.fallback,
            fs: false, 
        };
    }
    return config;
  },
  env: {
    ASTROMETRY_API_KEY: process.env.ASTROMETRY_API_KEY,
  }
};

module.exports = nextConfig;
