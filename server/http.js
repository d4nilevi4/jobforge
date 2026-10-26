import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { authenticate, hasScope, SCOPES } from './auth.js';
import { APP_ROOT } from './config.js';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from './errors.js';

const BODY_LIMIT = 2 * 1024 * 1024;
const UI_DIR = resolve(APP_ROOT, 'ui');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const tooLarge = () => {
      req.resume(); // keep draining (and discarding) so the client can read the 413 instead of hitting EPIPE
      fail(new ApiError(413, 'payload_too_large', 'Request body exceeds 2 MB. Reduce the JSON body to at most 2097152 bytes.'));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) return tooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      if (!size) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('Request body is not valid JSON. Send a complete JSON value with double-quoted keys and strings.'));
      }
    };
    const onError = () => fail(badRequest('Request body could not be read. Retry with a complete JSON body.'));
    const onAborted = () => fail(badRequest('Request body was interrupted. Retry with a complete JSON body.'));
    if (Number(req.headers['content-length']) > BODY_LIMIT) return tooLarge();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function sendResult(res, result, done) {
  let status = 200;
  let body = result;
  if (result && Object.hasOwn(result, 'status') && Object.hasOwn(result, 'raw')) {
    res.writeHead(result.status, result.headers || {});
    res.end(result.raw, done);
    return;
  }
  if (result && Object.hasOwn(result, 'status') && Object.hasOwn(result, 'body')) {
    status = result.status;
    body = result.body;
  }
  const json = JSON.stringify(body);
  res.writeHead(status);
  res.end(json, done);
}

function insideUi(path) {
  return path.startsWith(`${UI_DIR}${sep}`);
}

async function serveStatic(req, res, pathname) {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = '';
  }
  const path = resolve(UI_DIR, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (req.method !== 'GET' || !decoded || decoded.includes('\0') || !insideUi(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
    return;
  }
  try {
    const actualPath = await realpath(path);
    if (!insideUi(actualPath) || !(await stat(actualPath)).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
      return;
    }
    const content = await readFile(actualPath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] || 'application/octet-stream' });
    res.end(content);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    if (path === resolve(UI_DIR, 'index.html') && error.code === 'ENOENT') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>JobForge</title><body><h1>JobForge</h1><p>The UI is not built yet.</p></body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
  }
}

export function createRouter() {
  const routes = [];
  return {
    get routes() {
      return routes.map(({ method, segments, scope }) => ({ method, pattern: segments.join('/'), scope }));
    },
    add(method, pattern, handler, { scope = null } = {}) {
      if (scope !== null && !SCOPES.includes(scope)) {
        throw new Error(`Unknown route scope ${scope} for ${pattern}. Use a scope exported by auth.js.`);
      }
      routes.push({ method: method.toUpperCase(), segments: pattern.split('/'), handler, scope });
    },
    async handle(req, res, ctx) {
      const { db, config, log = console } = ctx;
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
          await serveStatic(req, res, url.pathname);
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        let segments;
        try {
          segments = url.pathname.split('/').map((segment) => decodeURIComponent(segment));
        } catch {
          throw badRequest('Request URL contains invalid URI encoding. Percent-encode each path segment correctly.');
        }
        const matches = routes.filter((route) => route.segments.length === segments.length
          && route.segments.every((segment, index) => (
            segment.startsWith(':') ? segments[index] !== '' : segment === segments[index]
          )));
        const route = matches.find((candidate) => candidate.method === req.method);
        if (!matches.length) throw notFound(`API path ${url.pathname} was not found. Use an endpoint under /api/v1.`);
        if (!route) {
          res.setHeader('Allow', [...new Set(matches.map((match) => match.method))].join(', '));
          throw new ApiError(405, 'method_not_allowed', `Method ${req.method} is not allowed for ${url.pathname}. Use ${res.getHeader('Allow')}.`);
        }
        const token = authenticate(db, req);
        if (route.scope && !token) {
          throw unauthorized('Missing or invalid Authorization header. Send Authorization: Bearer <active token>.');
        }
        if (route.scope && !hasScope(token, route.scope)) {
          throw forbidden(`Token lacks scope ${route.scope} for ${req.method} ${url.pathname}. Use a token with that scope.`);
        }
        const params = Object.fromEntries(route.segments.flatMap((segment, index) => (
          segment.startsWith(':') ? [[segment.slice(1), segments[index]]] : []
        )));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const query = Object.fromEntries(url.searchParams);
        const result = await route.handler({ req, res, params, query, body, token, db, config, log });
        if (result !== undefined && !res.writableEnded) sendResult(res, result);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          if (typeof log === 'function') log(error?.stack || String(error));
          else (log.error || log.log).call(log, error?.stack || String(error));
        }
        if (res.headersSent) {
          if (!res.writableEnded) res.destroy();
          return;
        }
        const apiError = error instanceof ApiError ? error
          : new ApiError(500, 'internal', 'An internal server error occurred. Check the server log and retry.');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const oversized = apiError.status === 413;
        if (oversized) {
          res.setHeader('Connection', 'close');
          // Let the client finish uploading (we discard it) so it can read the 413 instead of hitting EPIPE.
          if (!req.readableEnded) {
            await new Promise((done) => {
              req.once('end', done);
              req.once('close', done);
              setTimeout(done, 10_000).unref();
            });
          }
        }
        sendResult(res, { status: apiError.status, body: apiError.toJSON() }, oversized ? () => req.destroy() : undefined);
      }
    },
  };
}
