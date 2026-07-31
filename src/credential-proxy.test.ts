import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  startCredentialProxy,
  rewriteModelInBody,
} from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('429 spillover: OAuth lane 429 retries with API key', async () => {
    // Override the upstream server: first call (OAuth) returns 429,
    // second call (API key retry) returns 200.
    await new Promise<void>((r) => upstreamServer.close(() => r()));

    let callCount = 0;
    const calls: { auth?: string; xApiKey?: string }[] = [];
    upstreamServer = http.createServer((req, res) => {
      callCount += 1;
      calls.push({
        auth: req.headers['authorization'] as string | undefined,
        xApiKey: req.headers['x-api-key'] as string | undefined,
      });
      if (callCount === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Error' },
          }),
        );
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, viaRetry: true }));
      }
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({
      CLAUDE_CODE_RESPONDER_OAUTH_TOKEN: 'pro-oauth-token',
      ANTHROPIC_API_KEY: 'sk-ant-spillover-key',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(callCount).toBe(2);
    expect(calls[0].auth).toBe('Bearer pro-oauth-token');
    expect(calls[0].xApiKey).toBeUndefined();
    expect(calls[1].xApiKey).toBe('sk-ant-spillover-key');
    expect(calls[1].auth).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, viaRetry: true });
  });

  it('429 spillover skipped when no ANTHROPIC_API_KEY configured', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));

    let callCount = 0;
    upstreamServer = http.createServer((req, res) => {
      callCount += 1;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Error' },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({
      CLAUDE_CODE_RESPONDER_OAUTH_TOKEN: 'pro-oauth-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(callCount).toBe(1);
    expect(res.statusCode).toBe(429);
  });

  describe('rewriteModelInBody', () => {
    const JSON_CT = 'application/json';

    function decode(buf: Buffer): any {
      return JSON.parse(buf.toString('utf-8'));
    }

    it('rewrites the model field', () => {
      const out = rewriteModelInBody(
        Buffer.from(JSON.stringify({ model: 'claude-opus-4-6' })),
        JSON_CT,
        'claude-haiku-4-5',
      );
      expect(decode(out).model).toBe('claude-haiku-4-5');
    });

    it('returns body unchanged when content-type is not JSON', () => {
      const raw = Buffer.from('not json');
      const out = rewriteModelInBody(raw, 'text/plain', 'claude-haiku-4-5');
      expect(out.toString()).toBe('not json');
    });

    it('returns body unchanged when JSON has no model field', () => {
      const raw = Buffer.from(JSON.stringify({ messages: [] }));
      const out = rewriteModelInBody(raw, JSON_CT, 'claude-haiku-4-5');
      expect(out.toString()).toBe(raw.toString());
    });

    it('injects reasoning.effort with exclude=true and strips thinking', () => {
      const out = rewriteModelInBody(
        Buffer.from(
          JSON.stringify({
            model: 'x',
            thinking: { type: 'enabled', budget_tokens: 1024 },
          }),
        ),
        JSON_CT,
        'gemini-3-flash',
        'high',
      );
      const parsed = decode(out);
      expect(parsed.reasoning).toEqual({ effort: 'high', exclude: true });
      expect(parsed.thinking).toBeUndefined();
    });

    it('omits reasoning field when reasoningEffort is empty', () => {
      const out = rewriteModelInBody(
        Buffer.from(JSON.stringify({ model: 'x' })),
        JSON_CT,
        'claude-haiku-4-5',
        undefined,
      );
      expect(decode(out).reasoning).toBeUndefined();
    });

    it('injects context-compression plugin when enabled', () => {
      const out = rewriteModelInBody(
        Buffer.from(JSON.stringify({ model: 'x' })),
        JSON_CT,
        'claude-haiku-4-5',
        undefined,
        true,
      );
      expect(decode(out).plugins).toEqual([{ id: 'context-compression' }]);
    });

    it('does not duplicate context-compression plugin when already present', () => {
      const out = rewriteModelInBody(
        Buffer.from(
          JSON.stringify({
            model: 'x',
            plugins: [{ id: 'context-compression' }, { id: 'other' }],
          }),
        ),
        JSON_CT,
        'claude-haiku-4-5',
        undefined,
        true,
      );
      const plugins = decode(out).plugins;
      expect(plugins).toHaveLength(2);
      expect(
        plugins.filter((p: any) => p.id === 'context-compression'),
      ).toHaveLength(1);
    });

    it('injects provider.order with allow_fallbacks=false when whitelist is set', () => {
      const out = rewriteModelInBody(
        Buffer.from(JSON.stringify({ model: 'deepseek/deepseek-v4-pro' })),
        JSON_CT,
        'deepseek/deepseek-v4-pro',
        undefined,
        undefined,
        ['Fireworks', 'Together', 'DeepInfra'],
      );
      const parsed = decode(out);
      expect(parsed.provider).toEqual({
        order: ['Fireworks', 'Together', 'DeepInfra'],
        allow_fallbacks: false,
      });
    });

    it('omits provider field when whitelist is undefined or empty', () => {
      const undef = rewriteModelInBody(
        Buffer.from(JSON.stringify({ model: 'x' })),
        JSON_CT,
        'y',
      );
      expect(decode(undef).provider).toBeUndefined();

      const empty = rewriteModelInBody(
        Buffer.from(JSON.stringify({ model: 'x' })),
        JSON_CT,
        'y',
        undefined,
        undefined,
        [],
      );
      expect(decode(empty).provider).toBeUndefined();
    });
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
});
