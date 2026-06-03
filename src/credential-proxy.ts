/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import fs from 'fs';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth' | 'openrouter';

export interface ProxyConfig {
  authMode: AuthMode;
}

// OpenRouter mode (2026-06-03 multi-model swap, Phase 3):
//
// When NANOCLAW_USE_OPENROUTER=1 and OPENROUTER_API_KEY is set, the proxy
// forwards container traffic to OpenRouter's Anthropic-compat endpoint
// (/v1/messages) instead of api.anthropic.com. This moves Aria entirely
// off Pro/Max OAuth quota — confirmed in the swap plan at
// /Users/aria/.claude/plans/memoized-dreaming-duckling.md.
//
// • Headers: strip x-api-key + Authorization, inject `Authorization: Bearer
//   <OPENROUTER_API_KEY>`. OpenRouter accepts both header styles; Bearer is
//   the documented default.
// • Model rewrite: if OPENROUTER_MODEL_OVERRIDE is set (default
//   `claude-haiku-4-5` when openrouter mode is on), the JSON request body's
//   `"model"` field is rewritten before forwarding. OpenRouter normalizes
//   most Anthropic dash-form slugs (`claude-haiku-4-5`,
//   `claude-haiku-4-5-20251001`, etc.) to its canonical id automatically.
// • Pro-lane / 429 spillover logic is bypassed in openrouter mode — there is
//   no Anthropic quota to fall back from. The probe + rate state remain
//   untouched (still used by agent-team Engineer + sub-agents on Max).
const OPENROUTER_DEFAULT_MODEL = 'claude-haiku-4-5';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function rewriteModelInBody(
  body: Buffer,
  contentType: string | undefined,
  newModel: string,
): Buffer {
  if (body.length === 0) return body;
  const ct = (contentType || '').toLowerCase();
  if (!ct.includes('application/json')) return body;
  let parsed: any;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || !('model' in parsed)) {
    return body;
  }
  parsed.model = newModel;
  return Buffer.from(JSON.stringify(parsed), 'utf-8') as Buffer;
}

// Two-lane (Max/Pro) coordination: nanoclaw containers run the Aria persona,
// which the agent-team rate plan pins to the Pro account. The Pro OAuth token
// is read from CLAUDE_CODE_RESPONDER_OAUTH_TOKEN (same env var the agent-team
// CC responder uses, kept consistent here). The Max token stays as a fallback
// for single-account installs. When ANTHROPIC_API_KEY is also configured and
// the agent-team rate-state file reports the Pro lane throttled, the proxy
// spills this request to the API key — mirrors src/spawn/rate_guard.py.
const RATE_STATE_CACHE_MS = 30_000;
let _rateStateCachedAt = 0;
let _rateStateCached: any = null;

function readProThrottled(rateStatePath: string | undefined): boolean {
  if (!rateStatePath) return false;
  const now = Date.now();
  if (_rateStateCached && now - _rateStateCachedAt < RATE_STATE_CACHE_MS) {
    return _rateStateCached?.lanes?.pro?.status === 'throttled';
  }
  try {
    _rateStateCached = JSON.parse(fs.readFileSync(rateStatePath, 'utf-8'));
    _rateStateCachedAt = now;
    return _rateStateCached?.lanes?.pro?.status === 'throttled';
  } catch {
    return false;
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_RESPONDER_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'NANOCLAW_RATE_STATE_PATH',
    'NANOCLAW_USE_OPENROUTER',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL_OVERRIDE',
  ]);

  // Prefer the Pro token for nanoclaw containers (Aria lane). Fall back to
  // the Max token for single-account installs.
  const oauthToken =
    secrets.CLAUDE_CODE_RESPONDER_OAUTH_TOKEN ||
    secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    secrets.ANTHROPIC_AUTH_TOKEN;

  // OpenRouter takes precedence when explicitly enabled AND an OR key exists.
  const openrouterEnabled =
    secrets.NANOCLAW_USE_OPENROUTER === '1' &&
    !!secrets.OPENROUTER_API_KEY;
  const openrouterModelOverride =
    secrets.OPENROUTER_MODEL_OVERRIDE || OPENROUTER_DEFAULT_MODEL;

  // Default mode: OAuth when token present, else API key. API key takes over
  // per-request when the Pro lane is throttled (spillover, optional).
  const defaultAuthMode: AuthMode = openrouterEnabled
    ? 'openrouter'
    : secrets.ANTHROPIC_API_KEY && !oauthToken
      ? 'api-key'
      : 'oauth';
  const authMode: AuthMode = defaultAuthMode;
  const rateStatePath = secrets.NANOCLAW_RATE_STATE_PATH;

  // Anthropic upstream is host-only (paths from req.url forward as-is).
  // OpenRouter mode forwards to https://openrouter.ai (host-only) and the
  // request handler prefixes /api before /v1 path segments.
  const upstreamUrl = new URL(
    openrouterEnabled
      ? OPENROUTER_BASE_URL.replace(/\/api\/v1\/?$/, '')
      : secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: Buffer = Buffer.concat(chunks) as Buffer;
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Spillover: if Pro lane is throttled and an API key is available,
        // use it for THIS request even when default mode is oauth.
        // Disabled in openrouter mode — no Anthropic quota to fall back from.
        const proThrottled =
          authMode === 'oauth' &&
          secrets.ANTHROPIC_API_KEY &&
          readProThrottled(rateStatePath);
        const requestMode: AuthMode = proThrottled ? 'api-key' : authMode;
        logger.debug(
          {
            url: req.url,
            method: req.method,
            requestMode,
            proThrottled,
            openrouterEnabled,
            hasAuth: !!headers['authorization'],
            hasXApiKey: !!headers['x-api-key'],
          },
          'cred-proxy request',
        );

        // Forward path; in openrouter mode the upstream lives under /api so
        // a client path of /v1/messages routes to /api/v1/messages upstream.
        let forwardPath = req.url || '/';
        if (
          requestMode === 'openrouter' &&
          forwardPath.startsWith('/v1/')
        ) {
          forwardPath = '/api' + forwardPath;
        }

        if (requestMode === 'openrouter') {
          // OpenRouter mode: strip Anthropic auth, inject Bearer token,
          // rewrite model field in JSON body to the override if present.
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${secrets.OPENROUTER_API_KEY}`;
          if (openrouterModelOverride) {
            body = rewriteModelInBody(
              body,
              headers['content-type'] as string | undefined,
              openrouterModelOverride,
            );
            headers['content-length'] = body.length;
          }
        } else if (requestMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // On-the-fly OAuth→API-key spillover on 429. The rate-state probe
        // runs every 5min, so there is a window in which the OAuth lane is
        // really 429ing but the state file still says "ok" (or just
        // flipped back after a single lucky probe). Without this retry the
        // 429 propagates to the container and the SDK renders it as
        // "Invalid API key · Fix external API key" to the user — even
        // though the credentials are fine. When the request used OAuth and
        // ANTHROPIC_API_KEY is configured, retry transparently with the
        // API key instead of forwarding the 429.
        const canRetryWithApiKey =
          requestMode === 'oauth' && !!secrets.ANTHROPIC_API_KEY;

        const forwardUpstreamResponse = (
          upRes: import('http').IncomingMessage,
        ) => {
          res.writeHead(upRes.statusCode!, upRes.headers);
          upRes.pipe(res);
        };

        const retryWithApiKey = () => {
          const retryHeaders: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...headers,
            'x-api-key': secrets.ANTHROPIC_API_KEY,
          };
          delete retryHeaders['authorization'];
          logger.info(
            { url: req.url },
            'cred-proxy 429 spillover: retrying with API key',
          );
          const retry = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: forwardPath,
              method: req.method,
              headers: retryHeaders,
            } as RequestOptions,
            forwardUpstreamResponse,
          );
          retry.on('error', (err) => {
            logger.error({ err, url: req.url }, 'Credential proxy retry error');
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
          retry.write(body);
          retry.end();
        };

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: forwardPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            if (upRes.statusCode === 429 && canRetryWithApiKey) {
              // Drain the 429 body so the socket can be reused, then retry.
              upRes.resume();
              retryWithApiKey();
              return;
            }
            forwardUpstreamResponse(upRes);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'NANOCLAW_USE_OPENROUTER',
    'OPENROUTER_API_KEY',
  ]);
  if (
    secrets.NANOCLAW_USE_OPENROUTER === '1' &&
    secrets.OPENROUTER_API_KEY
  ) {
    return 'openrouter';
  }
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
