import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships WebAssembly that must be loaded from node_modules, not bundled.
  serverExternalPackages: ['@electric-sql/pglite'],
  // The product-profile PDF emails carry is read from disk at send time, so it has to ship with the server code.
  outputFileTracingIncludes: { '/*': ['./assets/*.pdf'] },
};

export default nextConfig;
