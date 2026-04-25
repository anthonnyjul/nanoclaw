/**
 * model_health_observer.ts — Model health monitoring for the agent team.
 *
 * Two responsibilities:
 *   1. Warm-up: ping Ollama every 8 minutes to keep qwen3:30b-a3b loaded in VRAM.
 *      Prevents cold-start penalty (8-12s) from triggering LiteLLM timeouts.
 *
 *   2. Weekly health report: every Monday at 08:00, query the LiteLLM /health
 *      endpoint and sessions.db to produce a model health summary and post it
 *      to the Slack #agent-manager channel.
 *
 * Alerts: if LiteLLM health check fails 3 times in a row → post alert.
 * Target: ≤15% bridge-failure rate (proxy for Sonnet fallback rate).
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';

const LITELLM_BASE = process.env.LITELLM_API_BASE ?? 'http://localhost:4000';
const OLLAMA_BASE = 'http://localhost:11434';
const SESSIONS_DB = process.env.AGENT_TEAM_DB ?? `${process.env.HOME}/agent-team/memory/sessions.db`;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const MANAGER_CHANNEL = process.env.SLACK_MANAGER_CHANNEL ?? '#agent-manager';

const WARMUP_INTERVAL_MS = 8 * 60 * 1000;  // 8 minutes
const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour; run report on Monday 08:00

let consecutiveFailures = 0;
let warmupTimer: ReturnType<typeof setInterval> | null = null;
let weeklyTimer: ReturnType<typeof setInterval> | null = null;

// ── Slack helper ──────────────────────────────────────────────────────────────

async function postToSlack(channel: string, text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text }),
    });
  } catch (err) {
    logger.warn({ err }, '[model-health] Slack post failed');
  }
}

// ── Warm-up ping ──────────────────────────────────────────────────────────────

async function pingOllama(): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:30b-a3b',
        prompt: 'ping',
        stream: false,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      logger.debug('[model-health] Ollama warm-up ping OK');
      consecutiveFailures = 0;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    consecutiveFailures++;
    logger.warn({ err, consecutiveFailures }, '[model-health] Ollama warm-up ping failed');

    if (consecutiveFailures >= 3) {
      await postToSlack(
        MANAGER_CHANNEL,
        `:warning: *Model health alert* — Ollama warm-up ping failed ${consecutiveFailures} times in a row.\n` +
        `qwen3:30b-a3b may be unresponsive. Engineer tasks will fall back to Sonnet until resolved.\n` +
        `Check: \`docker exec homelab-ollama ollama list\``,
      );
    }
  }
}

// ── Weekly health report ──────────────────────────────────────────────────────

function isMonday8am(): boolean {
  const now = new Date();
  // Use TIMEZONE to determine local time
  const localStr = now.toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', hour12: false });
  return localStr.startsWith('Mon') && localStr.includes('08');
}

async function runWeeklyHealthReport(): Promise<void> {
  if (!isMonday8am()) return;

  logger.info('[model-health] Running weekly health report');

  // ── LiteLLM health check ─────────────────────────────────────────────
  let litellmStatus = 'unknown';
  try {
    const res = await fetch(`${LITELLM_BASE}/health/readiness`, {
      signal: AbortSignal.timeout(10_000),
    });
    litellmStatus = res.ok ? 'healthy' : `HTTP ${res.status}`;
  } catch (err) {
    litellmStatus = `unreachable (${String(err).slice(0, 60)})`;
  }

  // ── sessions.db — last 7 days ─────────────────────────────────────────
  let sessionSummary = 'sessions.db not available';
  try {
    const db = new Database(SESSIONS_DB, { readonly: true });

    const rows = db.prepare(`
      SELECT
        outcome,
        COUNT(*) as count
      FROM engineer_sessions
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY outcome
      ORDER BY count DESC
    `).all() as { outcome: string; count: number }[];

    const bridgeFailures = rows.find(r => r.outcome?.toLowerCase().includes('bridge'))?.count ?? 0;
    const total = rows.reduce((s, r) => s + r.count, 0);
    const failRate = total > 0 ? Math.round((bridgeFailures / total) * 100) : 0;

    const breakdown = rows.map(r => `  ${r.outcome}: ${r.count}`).join('\n');
    sessionSummary = `Total: ${total} | Bridge-failures: ${bridgeFailures} (${failRate}%)\n${breakdown}`;

    const alertThreshold = 15;
    if (failRate > alertThreshold) {
      await postToSlack(
        MANAGER_CHANNEL,
        `:rotating_light: *Model health alert* — Bridge-failure rate ${failRate}% exceeds ${alertThreshold}% threshold.\n` +
        `This likely indicates qwen3:30b-a3b is timing out and falling back to Sonnet.\n` +
        `Consider increasing \`timeout\` in litellm config or reducing \`num_ctx\`.`,
      );
    }

    db.close();
  } catch (err) {
    sessionSummary = `Error reading sessions.db: ${String(err).slice(0, 120)}`;
  }

  // ── Post weekly report ────────────────────────────────────────────────
  const report =
    `:bar_chart: *Weekly model health report*\n` +
    `*LiteLLM:* ${litellmStatus}\n` +
    `*Ollama consecutive failures:* ${consecutiveFailures}\n` +
    `*Engineer sessions (last 7 days):*\n\`\`\`\n${sessionSummary}\n\`\`\``;

  await postToSlack(MANAGER_CHANNEL, report);
  logger.info('[model-health] Weekly report posted');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startModelHealthObserver(): void {
  // Warm-up: every 8 minutes
  pingOllama().catch(() => {});  // immediate first ping
  warmupTimer = setInterval(() => {
    pingOllama().catch(() => {});
  }, WARMUP_INTERVAL_MS);

  // Weekly report: check every hour, run report on Monday 08:00
  weeklyTimer = setInterval(() => {
    runWeeklyHealthReport().catch((err) => {
      logger.warn({ err }, '[model-health] Weekly report failed');
    });
  }, WEEKLY_CHECK_INTERVAL_MS);

  logger.info('[model-health] Observer started (warm-up every 8min, report every Monday 08:00)');
}

export function stopModelHealthObserver(): void {
  if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
  if (weeklyTimer) { clearInterval(weeklyTimer); weeklyTimer = null; }
}
