import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';

interface UiRoutesOptions {
  /** Directory containing index.html, styles.css and app.js. */
  staticRoot?: string;
}

interface StaticAsset {
  route: string;
  file: string;
  contentType: string;
  cacheControl: string;
}

const ASSETS: StaticAsset[] = [
  {
    route: '/',
    file: 'index.html',
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-store',
  },
  {
    route: '/styles.css',
    file: 'styles.css',
    contentType: 'text/css; charset=utf-8',
    cacheControl: 'no-cache',
  },
  {
    route: '/app.js',
    file: 'app.js',
    contentType: 'text/javascript; charset=utf-8',
    cacheControl: 'no-cache',
  },
];

const uiRoutes: FastifyPluginAsync<UiRoutesOptions> = async (fastify, opts) => {
  const staticRoot = path.resolve(
    opts.staticRoot ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'public',
    ),
  );

  for (const asset of ASSETS) {
    fastify.get(asset.route, async (_request, reply) => {
      try {
        const body = await readFile(path.join(staticRoot, asset.file));
        return reply
          .header('Content-Type', asset.contentType)
          .header('Cache-Control', asset.cacheControl)
          .header('X-Content-Type-Options', 'nosniff')
          .header('X-Frame-Options', 'DENY')
          .header('Referrer-Policy', 'no-referrer')
          .header(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; " +
            "connect-src 'self'; img-src 'self' data:; base-uri 'none'; " +
            "form-action 'self'; frame-ancestors 'none'",
          )
          .send(body);
      } catch (err) {
        fastify.log.error(
          { err, file: asset.file },
          'Failed to serve UI asset',
        );
        return reply.code(500).send({ error: 'UI asset unavailable' });
      }
    });
  }
};

export default uiRoutes;
