/**
 * Slack channel adapter. Self-registers on import.
 *
 * Transport is Web API polling, not Socket Mode or webhooks: a bot token is the
 * only credential this deployment has. Socket Mode needs an app-level `xapp-`
 * token, webhooks need a public HTTPS endpoint. Polling needs neither, and one
 * channel at 3s is ~20 req/min against a Tier-3 (50+/min) method.
 *
 * The token is read from .env only — never from process.env — so it is not
 * inherited by the agent containers this process spawns.
 */
import { DEFAULT_TRIGGER } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const API = 'https://slack.com/api';
const JID_SUFFIX = '@slack';
const DEFAULT_POLL_INTERVAL_MS = 3000;
/** How far back to look for thread parents whose replies are new. */
const THREAD_LOOKBACK_SECONDS = 24 * 60 * 60;

/** Slack channel ID -> NanoClaw JID. */
export function slackJid(channelId: string): string {
  return `${channelId}${JID_SUFFIX}`;
}

/** NanoClaw JID -> Slack channel ID. */
export function slackChannelId(jid: string): string {
  return jid.slice(0, -JID_SUFFIX.length);
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  latest_reply?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  channel?: { name?: string };
  user_id?: string;
  bot_id?: string;
  user?: { real_name?: string; name?: string };
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  token: string;
  channelIds: string[];
  pollIntervalMs?: number;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private connected = false;
  private timer?: NodeJS.Timeout;
  private polling = false;
  /** Per-channel high-water mark, as a Slack `ts` string. */
  private cursors = new Map<string, string>();
  /** Thread to reply into, keyed by JID — set from the last inbound message. */
  private replyThreads = new Map<string, string | undefined>();
  /** Display names by Slack user ID. Caches misses too, so we ask once. */
  private senderNames = new Map<string, string>();
  private botUserId = '';
  private botId = '';

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const auth = await this.api('auth.test', {});
    if (!auth.ok) {
      throw new Error(`Slack auth.test failed: ${auth.error}`);
    }
    this.botUserId = auth.user_id || '';
    this.botId = auth.bot_id || '';

    // Start at now. Replaying history on every restart would re-deliver
    // messages the assistant has already answered.
    const now = (Date.now() / 1000).toFixed(6);
    for (const id of this.opts.channelIds) this.cursors.set(id, now);

    this.connected = true;
    logger.info(
      { channels: this.opts.channelIds, botUserId: this.botUserId },
      'Connected to Slack',
    );

    await this.syncGroups(true);
    this.scheduleNextPoll();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = slackChannelId(jid);
    const thread = this.replyThreads.get(jid);
    const res = await this.api('chat.postMessage', {
      channel,
      text,
      ...(thread ? { thread_ts: thread } : {}),
    });
    if (!res.ok) {
      throw new Error(`Slack chat.postMessage failed: ${res.error}`);
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    if (!force) return;
    for (const id of this.opts.channelIds) {
      const info = await this.api('conversations.info', { channel: id });
      if (info.ok && info.channel?.name) {
        updateChatName(slackJid(id), `#${info.channel.name}`);
      } else {
        logger.warn(
          { channel: id, err: info.error },
          'Could not resolve Slack channel name',
        );
      }
    }
  }

  private scheduleNextPoll(): void {
    if (!this.connected) return;
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.scheduleNextPoll());
    }, interval);
  }

  /** One poll pass over every configured channel. Never throws. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const id of this.opts.channelIds) {
        const messages = await this.fetchNew(id);
        for (const msg of messages) this.deliver(id, msg);
      }
    } catch (err) {
      logger.warn({ err }, 'Slack poll failed, will retry next tick');
    } finally {
      this.polling = false;
    }
  }

  /**
   * Messages strictly newer than the channel cursor, oldest first.
   *
   * Two fetches, deliberately. `conversations.history` returns only top-level
   * posts, so in-thread replies are invisible to it — and widening the
   * top-level fetch with a lookback instead of splitting it fills page 1 with
   * old messages on a busy channel, hiding the new ones on pages never read.
   */
  private async fetchNew(channelId: string): Promise<SlackMessage[]> {
    const since = Number(this.cursors.get(channelId) ?? 0);
    const collected: SlackMessage[] = [];

    const top = await this.api('conversations.history', {
      channel: channelId,
      oldest: String(since),
      inclusive: 'false',
      limit: '200',
    });
    if (!top.ok) {
      logger.warn(
        { channel: channelId, err: top.error },
        'Slack conversations.history failed',
      );
      return [];
    }
    for (const m of top.messages ?? []) {
      if (Number(m.ts) > since) collected.push(m);
    }

    const lookback = Math.max(since - THREAD_LOOKBACK_SECONDS, 0);
    const parents = await this.api('conversations.history', {
      channel: channelId,
      oldest: String(lookback),
      inclusive: 'false',
      limit: '100',
    });
    for (const parent of parents.ok ? (parents.messages ?? []) : []) {
      if (!parent.latest_reply || Number(parent.latest_reply) <= since)
        continue;
      const replies = await this.api('conversations.replies', {
        channel: channelId,
        ts: parent.ts,
        oldest: String(since),
        inclusive: 'false',
        limit: '100',
      });
      if (!replies.ok) continue;
      for (const reply of replies.messages ?? []) {
        if (reply.ts === parent.ts) continue;
        if (Number(reply.ts) > since) collected.push(reply);
      }
    }

    collected.sort((a, b) => Number(a.ts) - Number(b.ts));
    const newest = collected[collected.length - 1];
    if (newest) this.cursors.set(channelId, newest.ts);
    return collected;
  }

  private deliver(channelId: string, msg: SlackMessage): void {
    // Joins, topic changes and other channel events carry a subtype and are
    // not conversation. Thread broadcasts are.
    if (msg.subtype && msg.subtype !== 'thread_broadcast') return;

    const chatJid = slackJid(channelId);
    const timestamp = new Date(Number(msg.ts) * 1000).toISOString();
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    // Own posts carry both `user` (bot user ID) and `bot_id`. Match either:
    // a self-post that slipped through would make the assistant answer itself,
    // and each answer is a new message, so the loop does not stop on its own.
    const sender = msg.user || msg.bot_id || '';
    const isFromMe =
      (Boolean(this.botUserId) && msg.user === this.botUserId) ||
      (Boolean(this.botId) && msg.bot_id === this.botId);
    if (isFromMe) return;

    // A real Slack mention arrives as `<@U…>`, which never matches the
    // `@Name` trigger pattern. Rewrite our own mention to the group's
    // trigger form so mentioning the bot summons it like typing its name.
    // Empty/missing trigger falls back to DEFAULT_TRIGGER, mirroring
    // getTriggerPattern's fallback in the router.
    const trigger = groups[chatJid].trigger?.trim() || DEFAULT_TRIGGER;
    const mentionAs = trigger.startsWith('@') ? trigger : `@${trigger}`;
    const content = this.botUserId
      ? (msg.text || '').replaceAll(`<@${this.botUserId}>`, mentionAs)
      : msg.text || '';

    this.replyThreads.set(chatJid, msg.thread_ts);
    this.opts.onMessage(chatJid, {
      id: msg.ts,
      chat_jid: chatJid,
      sender,
      sender_name: this.senderNames.get(sender) || msg.username || sender,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: Boolean(msg.bot_id),
      thread_id: msg.thread_ts,
    });

    if (msg.user && !this.senderNames.has(msg.user)) {
      void this.cacheSenderName(msg.user);
    }
  }

  /**
   * Resolve a display name once. `users.info` needs the `users:read` scope,
   * which this workspace's bot may not carry — cache the ID itself on failure
   * so a missing scope costs one call per user, not one per message.
   */
  private async cacheSenderName(userId: string): Promise<void> {
    const res = await this.api('users.info', { user: userId });
    const name = res.ok ? res.user?.real_name || res.user?.name : undefined;
    this.senderNames.set(userId, name || userId);
  }

  private async api(
    method: string,
    params: Record<string, string>,
  ): Promise<SlackApiResponse> {
    const url = new URL(`${API}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '1');
      logger.warn({ method, retryAfter }, 'Slack rate limited');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return { ok: false, error: 'ratelimited' };
    }

    return (await res.json()) as SlackApiResponse;
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'SLACK_BOT_TOKEN',
    'SLACK_CHANNELS',
    'SLACK_POLL_INTERVAL_MS',
  ]);
  if (!env.SLACK_BOT_TOKEN) return null;

  const channelIds = (env.SLACK_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (channelIds.length === 0) {
    logger.warn(
      'SLACK_BOT_TOKEN is set but SLACK_CHANNELS is empty — no channels to watch.',
    );
    return null;
  }

  const pollIntervalMs = Number(env.SLACK_POLL_INTERVAL_MS) || undefined;
  return new SlackChannel({
    ...opts,
    token: env.SLACK_BOT_TOKEN,
    channelIds,
    pollIntervalMs,
  });
});
