import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL?.trim() ||
      "https://alhan-dj-deck-1.onrender.com";
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl.replace(/\/$/, "")}/api/:path*`,
      },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
