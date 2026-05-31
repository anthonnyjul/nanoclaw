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

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
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
  ]);

  // Prefer the Pro token for nanoclaw containers (Aria lane). Fall back to
  // the Max token for single-account installs.
  const oauthToken =
    secrets.CLAUDE_CODE_RESPONDER_OAUTH_TOKEN ||
    secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    secrets.ANTHROPIC_AUTH_TOKEN;

  // Default mode: OAuth when token present, else API key. API key takes over
  // per-request when the Pro lane is throttled (spillover, optional).
  const defaultAuthMode: AuthMode =
    secrets.ANTHROPIC_API_KEY && !oauthToken ? 'api-key' : 'oauth';
  const authMode: AuthMode = defaultAuthMode;
  const rateStatePath = secrets.NANOCLAW_RATE_STATE_PATH;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
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
            hasAuth: !!headers['authorization'],
            hasXApiKey: !!headers['x-api-key'],
          },
          'cred-proxy request',
        );

        if (requestMode === 'api-key') {
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

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
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
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
