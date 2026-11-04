import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { App } from '../app.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { registerRoutes } from './routes/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const NOT_BUILT_PAGE = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Console not built yet</title>
<style>
  body{background:#0a0d18;color:#e8ecf7;font:16px/1.6 system-ui,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  div{max-width:38rem}
  h1{font-size:22px;margin:0 0 12px}
  code{background:#161d33;border:1px solid #33406a;border-radius:6px;padding:2px 7px;
       font-family:ui-monospace,monospace;font-size:14px}
  p{color:#9aa5c4}
</style>
<div>
  <h1>The console has not been built yet</h1>
  <p>The API is running, but there is no dashboard bundle to serve. Build it once:</p>
  <p><code>npm run build</code> then <code>npm start</code></p>
  <p>Or run <code>npm run dev</code>, which builds the console and rebuilds it
     whenever you change it, all on this same port.</p>
</div>`;

export async function createServer(app: App): Promise<FastifyInstance> {
  const env = getEnv();
  const server = Fastify({ logger: false, bodyLimit: 1_048_576 });

  const origins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    // Local only by default. This API can move money; it has no business
    // being reachable from an arbitrary web page.
    : [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
  await server.register(cors, { origin: origins });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      app.logger.warn({ code: error.code, details: error.details }, error.message);
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      });
    }
    app.logger.error({ err: error }, 'unhandled request error');
    // Never echo an internal error back to the client: it can carry paths,
    // query fragments, or a provider URL with a key in it.
    return reply.status(500).send({ error: 'INTERNAL', message: 'Something went wrong.' });
  });

  await registerRoutes(server, app);

  // The landing page and the built dashboard, when they exist. Serving them
  // from the API means one command and one port for the whole thing.
  const root = resolve(here, '..', '..', '..', '..');
  const landing = resolve(root, 'site');
  const dashboard = resolve(root, 'apps', 'dashboard', 'dist');

  /**
   * Cache headers.
   *
   * The landing page's stylesheet and script have no content hash in their
   * names, so a browser will happily serve a stale copy after an update and
   * the page looks unchanged. Those get `no-cache`, which still allows a
   * revalidation round trip but never a blind reuse.
   *
   * The media is different: those filenames are stable and their contents do
   * not change, so they are cached hard. Vite already hashes the console's
   * bundle names, which makes them safe to cache hard too.
   */
  const setCacheHeaders = (res: { header(k: string, v: string): void }, path: string): void => {
    if (/\.(mp4|webm|jpg|jpeg|png|webp|woff2?)$/i.test(path)) {
      res.header('cache-control', 'public, max-age=604800, immutable');
      return;
    }
    res.header('cache-control', 'no-cache');
  };

  if (existsSync(landing)) {
    await server.register(fastifyStatic, {
      root: landing,
      prefix: '/',
      decorateReply: true,
      cacheControl: false,
      setHeaders: setCacheHeaders,
    });
  }

  const dashboardBuilt = existsSync(resolve(dashboard, 'index.html'));
  if (dashboardBuilt) {
    await server.register(fastifyStatic, {
      root: dashboard,
      prefix: '/app/',
      decorateReply: false,
      cacheControl: false,
      setHeaders: (res, path) => {
        // index.html points at the hashed bundles, so it must never be stale.
        if (path.endsWith('index.html')) {
          res.header('cache-control', 'no-cache');
          return;
        }
        setCacheHeaders(res, path);
      },
    });
  }

  // `/app` with no trailing slash would otherwise miss the static prefix and
  // fall through to the not-found handler.
  server.get('/app', async (_request, reply) => reply.redirect('/app/', 301));

  server.setNotFoundHandler((request, reply) => {
    if (!request.url.startsWith('/app')) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'No such route.' });
    }
    // The dashboard is a single-page app, so any unknown /app path is a route
    // inside it rather than a missing file.
    if (dashboardBuilt) {
      return reply.type('text/html').sendFile('index.html', dashboard);
    }
    // Nothing built yet. Say so plainly instead of a bare 404, because this is
    // the first thing someone hits when they start the server before building.
    return reply.status(503).type('text/html').send(NOT_BUILT_PAGE);
  });

  return server;
}
