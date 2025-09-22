/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [
      {
        source: '/proxy',
        destination: '/api/proxy',
      },
    ];
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
    config.externals.push({
      '@tensorflow/tfjs-node': 'commonjs @tensorflow/tfjs-node',
    });
    return config;
  }
};

module.exports = nextConfig;
