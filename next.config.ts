
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
    // This is the correct way to mock modules that shouldn't be bundled on the client.
    if (!isServer) {
        config.resolve.fallback = {
            ...config.resolve.fallback,
            fs: false, // This tells webpack to replace `fs` with an empty module on the client side.
            '@tensorflow/tfjs-node': false, // Exclude tfjs-node from client-side bundle.
        };
    }
    return config;
  },
};

export default nextConfig;
