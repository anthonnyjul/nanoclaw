/**
 * sizing_observer.ts — Weekly task sizing calibration report.
 *
 * Every Monday at 08:15, queries agent-team's sessions.db for:
 *   - Tasks with high retry counts (signals oversized tasks)
 *   - Recent escalations and their causes
 *   - Skill evolution patterns
 *
 * Posts a calibration report to #agent-manager.
 * Over time, this data informs updates to the Initialiser prompt so
 * future project decompositions become more accurate.
 *
 * This is a read-only observer — it never writes to any database.
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';

const SESSIONS_DB = process.env.AGENT_TEAM_DB ?? `${process.env.HOME}/agent-team/memory/sessions.db`;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const MANAGER_CHANNEL = process.env.SLACK_MANAGER_CHANNEL ?? '#agent-manager';

const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour
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
    logger.warn({ err }, '[sizing-observer] Slack post failed');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMonday815am(): boolean {
  const now = new Date();
  const localStr = now.toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return localStr.includes('Mon') && localStr.includes('08:1');
}

// ── Report generation ─────────────────────────────────────────────────────────

async function runSizingCalibrationReport(): Promise<void> {
  if (!isMonday815am()) return;

  logger.info('[sizing-observer] Running weekly sizing calibration report');

  let report = ':straight_ruler: *Weekly sizing calibration report*\n\n';

  try {
    const db = new Database(SESSIONS_DB, { readonly: true });

    // ── Outcome distribution (last 7 days) ────────────────────────────────
    const outcomes = db.prepare(`
      SELECT outcome, COUNT(*) as count
      FROM engineer_sessions
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY outcome ORDER BY count DESC
    `).all() as { outcome: string; count: number }[];

    if (outcomes.length > 0) {
      report += '*Engineer session outcomes (7 days):*\n```\n';
      report += outcomes.map(r => `${(r.outcome ?? 'unknown').padEnd(20)} ${r.count}`).join('\n');
      report += '\n```\n\n';
    }

    // ── Recent escalations with failure context ────────────────────────────
    const escalations = db.prepare(`
      SELECT project, domain, task_summary, what_failed, created_at
      FROM engineer_sessions
      WHERE created_at >= datetime('now', '-7 days')
        AND (outcome LIKE '%escalat%' OR outcome LIKE '%bridge%' OR outcome LIKE '%fail%')
      ORDER BY created_at DESC
      LIMIT 5
    `).all() as {
      project: string; domain: string; task_summary: string;
      what_failed: string; created_at: string;
    }[];

    if (escalations.length > 0) {
      report += `*Recent escalations / failures (${escalations.length}):*\n`;
      for (const row of escalations) {
        const failed = (row.what_failed ?? '').slice(0, 120);
        report += `• [${row.project}/${row.domain}] ${(row.task_summary ?? '').slice(0, 80)}\n`;
        if (failed) report += `  ↳ ${failed}\n`;
      }
      report += '\n';
    }

    // ── Skill evolution ────────────────────────────────────────────────────
    const skillsWritten = db.prepare(`
      SELECT COUNT(*) as count
      FROM engineer_sessions
      WHERE created_at >= datetime('now', '-7 days')
        AND skill_written != '' AND skill_written IS NOT NULL
    `).get() as { count: number };

    report += `*Skills auto-written this week:* ${skillsWritten?.count ?? 0}\n\n`;

    // ── Project breakdown ──────────────────────────────────────────────────
    const byProject = db.prepare(`
      SELECT project, COUNT(*) as sessions,
             SUM(CASE WHEN outcome NOT LIKE '%fail%' AND outcome NOT LIKE '%bridge%' THEN 1 ELSE 0 END) as successes
      FROM engineer_sessions
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY project ORDER BY sessions DESC
    `).all() as { project: string; sessions: number; successes: number }[];

    if (byProject.length > 0) {
      report += '*By project:*\n```\n';
      report += byProject.map(r => {
        const rate = r.sessions > 0 ? Math.round((r.successes / r.sessions) * 100) : 0;
        return `${(r.project ?? 'unknown').padEnd(20)} ${r.sessions} sessions, ${rate}% success`;
      }).join('\n');
      report += '\n```\n';
    }

    db.close();
  } catch (err) {
    report += `Error reading sessions.db: ${String(err).slice(0, 150)}`;
    logger.warn({ err }, '[sizing-observer] DB read failed');
  }

  await postToSlack(MANAGER_CHANNEL, report);
  logger.info('[sizing-observer] Calibration report posted');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startSizingObserver(): void {
  weeklyTimer = setInterval(() => {
    runSizingCalibrationReport().catch((err) => {
      logger.warn({ err }, '[sizing-observer] Report failed');
    });
  }, WEEKLY_CHECK_INTERVAL_MS);

  logger.info('[sizing-observer] Started (report every Monday 08:15)');
}

export function stopSizingObserver(): void {
  if (weeklyTimer) { clearInterval(weeklyTimer); weeklyTimer = null; }
}
