/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Workspace packages ship TypeScript source rather than a build artifact,
  // so Next compiles them as part of the app. This keeps the monorepo free of
  // eight separate build configs and makes cross-package edits instant in dev.
  transpilePackages: [
    '@job-intel/contracts',
    '@job-intel/config',
    '@job-intel/core',
    '@job-intel/connectors',
    '@job-intel/discovery',
    '@job-intel/enrichment',
    '@job-intel/candidate',
    '@job-intel/matching',
    '@job-intel/recommendation',
    '@job-intel/ops',
    '@job-intel/queue',
    '@job-intel/db',
    '@job-intel/observability',
    '@job-intel/resume',
    '@job-intel/scheduler',
  ],

  /*
   * Packages Next must NOT bundle.
   *
   * Each of these resolves something at run time that a bundler destroys.
   * `pg` and PGlite load native or WASM assets by path. `ws` is subtler: it
   * optionally uses the `bufferutil` native addon to mask WebSocket frames, and
   * once bundled that resolution fails silently — leaving `bufferUtil.mask`
   * undefined and every Neon query dying with `TypeError: bufferUtil.mask is
   * not a function`, which names neither WebSockets nor the database.
   *
   * The worker never hits this because it is not bundled at all.
   */
  serverExternalPackages: [
    'pg',
    '@electric-sql/pglite',
    '@neondatabase/serverless',
    'ws',
    'bufferutil',
    'utf-8-validate',
  ],

  /*
   * `ws` optionally accelerates frame masking with two native addons,
   * `bufferutil` and `utf-8-validate`, and guards each in a try/catch so a pure
   * JavaScript fallback runs when they are absent. Neither is installed here.
   *
   * Webpack breaks that guard. It cannot resolve the optional require, so
   * rather than letting it throw it substitutes an empty module — the catch
   * never fires, `ws` believes the addon loaded, and the first Neon query dies
   * with `TypeError: bufferUtil.mask is not a function`. The message names
   * neither WebSockets nor the database, which is what makes it expensive to
   * diagnose.
   *
   * `IgnorePlugin` restores the throw, so the fallback engages as designed.
   */
  webpack: (config, { webpack }) => {
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^(bufferutil|utf-8-validate)$/ }),
    );
    return config;
  },

  // Fail the production build on a type error rather than shipping it.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true }, // linting is a separate CI step

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
