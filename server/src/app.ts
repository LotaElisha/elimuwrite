import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { pool, withDb, type Db } from './db.js';
import { config } from './config.js';
import { HttpError } from './lib/misc.js';
import { sha256 } from './lib/text.js';
import { publicRoutes } from './routes/public.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/documents.js';
import { analysisRoutes } from './routes/analysis.js';
import { refRoutes } from './routes/refs.js';
import { orgRoutes } from './routes/orgs.js';
import { teachingRoutes } from './routes/teaching.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';

export type User = { id: string; email: string; name: string; locale: string; english_variant: string; is_platform_admin: boolean; is_demo: boolean };

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    db<T>(fn: (db: Db) => Promise<T>): Promise<T>;
    me(): User;
  }
}

export const SESSION_COOKIE = 'ew_session';

export async function buildApp(opts: { logger?: boolean } = {}) {
  // Logger never records bodies, so raw document content stays out of routine logs.
  const app = Fastify({ logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.decorateRequest('db', function (this: FastifyRequest, fn: any) {
    return withDb({ userId: this.user?.id ?? null }, fn);
  } as any);
  app.decorateRequest('me', function (this: FastifyRequest) {
    if (!this.user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
    return this.user;
  });

  app.addHook('onRequest', async (req) => {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const token = bearer ?? req.cookies[SESSION_COOKIE];
    if (!token) return;
    const r = await pool.query(
      `select u.id, u.email, u.name, u.locale, u.english_variant, u.is_platform_admin, u.is_demo
       from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at > now()`, [sha256(token)]);
    req.user = r.rows[0] ?? null;
  });

  app.setErrorHandler((err: any, _req, reply: FastifyReply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, detail: err.detail });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', message: 'Some fields are invalid.', detail: err.issues });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Too many requests. Please wait a minute.' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'file_too_large', message: `Files must be under ${config.maxUploadBytes / 1048576} MB.` });
    if (err.code === 'P0001') return reply.status(409).send({ error: 'immutable', message: err.message });
    if (err.code === '22P02') return reply.status(404).send({ error: 'not_found', message: 'Not found' }); // malformed uuid
    if (err.code === '42501') return reply.status(404).send({ error: 'not_found', message: 'Not found' }); // RLS denial
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error({ code: err.code, msg: err.message }, 'unhandled');
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong. Your work has not been lost.' });
  });

  await app.register(async (api) => {
    await publicRoutes(api);
    await authRoutes(api);
    await documentRoutes(api);
    await analysisRoutes(api);
    await refRoutes(api);
    await orgRoutes(api);
    await teachingRoutes(api);
    await billingRoutes(api);
    await adminRoutes(api);
  }, { prefix: '/api' });

  const webDist = new URL('../../web/dist', import.meta.url).pathname;
  if (existsSync(webDist)) {
    await app.register(fstatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
