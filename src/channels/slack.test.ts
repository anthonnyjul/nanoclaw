import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../db.js', () => ({ updateChatName: vi.fn() }));

// vi.hoisted + default implementation ({}) matter: slack.ts imports
// config.js, which calls readEnvFile at module-load time — before the test
// module's own body (and any mockReturnValue) has run.
const { readEnvFile } = vi.hoisted(() => ({
  readEnvFile: vi.fn<(keys: string[]) => Record<string, string>>(() => ({})),
}));
vi.mock('../env.js', () => ({ readEnvFile: (k: string[]) => readEnvFile(k) }));

import { DEFAULT_TRIGGER } from '../config.js';
import { updateChatName } from '../db.js';
import { NewMessage, RegisteredGroup } from '../types.js';
import { getChannelFactory } from './registry.js';
import { SlackChannel, slackJid, slackChannelId } from './slack.js';

const CHANNEL = 'C0B1Y483G2U';
const JID = `${CHANNEL}@slack`;
const BOT = 'U0APH690GV8';
const BOT_ID = 'B0AQBEA8VJ4';

interface SlackReply {
  ok: boolean;
  bot_id?: string;
  messages?: Record<string, unknown>[];
  user_id?: string;
  channel?: { name?: string };
  user?: { real_name?: string };
}

/** Queue one canned response per API method call, in order. */
function mockSlack(byMethod: Record<string, SlackReply[]>) {
  const calls: { method: string; params: URLSearchParams }[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const method = url.pathname.replace('/api/', '');
    calls.push({ method, params: url.searchParams });
    const queue = byMethod[method];
    const body = queue?.length ? (queue.shift() as SlackReply) : { ok: true };
    return {
      status: 200,
      headers: new Headers(),
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function makeChannel(groups: Record<string, RegisteredGroup> = {}) {
  const received: NewMessage[] = [];
  const metadata: string[] = [];
  const channel = new SlackChannel({
    onMessage: (_jid, m) => received.push(m),
    onChatMetadata: (jid) => metadata.push(jid),
    registeredGroups: () => groups,
    token: 'xoxb-test',
    channelIds: [CHANNEL],
  });
  return { channel, received, metadata };
}

const registered: Record<string, RegisteredGroup> = {
  [JID]: {
    name: 'tce-develop',
    folder: 'tce_develop',
    trigger: '@Aria',
    added_at: '2026-07-28T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('jid mapping', () => {
  it('round-trips a channel ID', () => {
    expect(slackJid(CHANNEL)).toBe(JID);
    expect(slackChannelId(JID)).toBe(CHANNEL);
  });

  it('owns only slack JIDs', () => {
    const { channel } = makeChannel();
    expect(channel.ownsJid(JID)).toBe(true);
    expect(channel.ownsJid('120363044763905176@g.us')).toBe(false);
    expect(channel.ownsJid('16477875660@s.whatsapp.net')).toBe(false);
  });
});

describe('factory', () => {
  it('returns null when the token is missing, so the channel is skipped', () => {
    readEnvFile.mockReturnValue({ SLACK_CHANNELS: CHANNEL });
    const factory = getChannelFactory('slack')!;
    expect(
      factory({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      }),
    ).toBeNull();
  });

  it('returns null when a token is set but no channels are listed', () => {
    readEnvFile.mockReturnValue({ SLACK_BOT_TOKEN: 'xoxb-test' });
    const factory = getChannelFactory('slack')!;
    expect(
      factory({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      }),
    ).toBeNull();
  });

  it('builds a channel when both are present', () => {
    readEnvFile.mockReturnValue({
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_CHANNELS: ` ${CHANNEL} , `,
    });
    const factory = getChannelFactory('slack')!;
    const built = factory({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(built).toBeInstanceOf(SlackChannel);
  });
});

describe('connect', () => {
  it('resolves the bot user, names the chat, and starts after now', async () => {
    mockSlack({
      'auth.test': [{ ok: true, user_id: BOT, bot_id: BOT_ID }],
      'conversations.info': [{ ok: true, channel: { name: 'tce-develop' } }],
    });
    const { channel } = makeChannel();
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    expect(updateChatName).toHaveBeenCalledWith(JID, '#tce-develop');
    await channel.disconnect();
  });

  it('throws when the token is rejected', async () => {
    mockSlack({ 'auth.test': [{ ok: false }] });
    const { channel } = makeChannel();
    await expect(channel.connect()).rejects.toThrow('auth.test failed');
  });
});

describe('polling', () => {
  /** Drive one poll pass without waiting on the timer. */
  async function pollOnce(channel: SlackChannel) {
    await (channel as unknown as { poll: () => Promise<void> }).poll();
  }

  async function connected(groups: Record<string, RegisteredGroup>) {
    mockSlack({
      'auth.test': [{ ok: true, user_id: BOT, bot_id: BOT_ID }],
      'conversations.info': [{ ok: true }],
    });
    const made = makeChannel(groups);
    await made.channel.connect();
    return made;
  }

  it('delivers a new top-level message to a registered group', async () => {
    const { channel, received } = await connected(registered);
    const calls = mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [{ ts: '9999999999.0001', text: 'hi', user: 'U1' }],
        },
        { ok: true, messages: [] },
      ],
      'users.info': [{ ok: true, user: { real_name: 'Ant' } }],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: '9999999999.0001',
      chat_jid: JID,
      sender: 'U1',
      content: 'hi',
      is_from_me: false,
    });
    // Two history fetches: new top-level, then the thread-parent lookback.
    const history = calls.filter((c) => c.method === 'conversations.history');
    expect(history).toHaveLength(2);
    expect(Number(history[1].params.get('oldest'))).toBeLessThan(
      Number(history[0].params.get('oldest')),
    );
    await channel.disconnect();
  });

  it('rewrites a real bot mention to the group trigger form', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [
            {
              ts: '9999999999.0005',
              text: `<@${BOT}> are you there?`,
              user: 'U1',
            },
          ],
        },
        { ok: true, messages: [] },
      ],
      'users.info': [{ ok: true, user: { real_name: 'Ant' } }],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('@Aria are you there?');
    await channel.disconnect();
  });

  it('rewrites a mention with the default trigger when the group trigger is empty', async () => {
    const { channel, received } = await connected({
      [JID]: { ...registered[JID], trigger: '' },
    });
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [
            { ts: '9999999999.0007', text: `<@${BOT}> status?`, user: 'U1' },
          ],
        },
        { ok: true, messages: [] },
      ],
      'users.info': [{ ok: true, user: { real_name: 'Ant' } }],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe(`${DEFAULT_TRIGGER} status?`);
    await channel.disconnect();
  });

  it('leaves other users mentions untouched', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [
            { ts: '9999999999.0006', text: '<@USOMEONE> ping', user: 'U1' },
          ],
        },
        { ok: true, messages: [] },
      ],
      'users.info': [{ ok: true, user: { real_name: 'Ant' } }],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('<@USOMEONE> ping');
    await channel.disconnect();
  });

  it('ignores messages for chats that are not registered groups', async () => {
    const { channel, received, metadata } = await connected({});
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [{ ts: '9999999999.0002', text: 'hi', user: 'U1' }],
        },
        { ok: true, messages: [] },
      ],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(0);
    // Metadata still flows, so the chat is discoverable for registration.
    expect(metadata).toContain(JID);
    await channel.disconnect();
  });

  it('drops the assistant’s own messages so it cannot answer itself', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [{ ts: '9999999999.0003', text: 'mine', user: BOT }],
        },
        { ok: true, messages: [] },
      ],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(0);
    await channel.disconnect();
  });

  it('drops a self-post identified only by bot_id, so it cannot loop', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [{ ts: '9999999999.0007', text: 'mine', bot_id: BOT_ID }],
        },
        { ok: true, messages: [] },
      ],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(0);
    await channel.disconnect();
  });

  it('drops channel events like joins', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [
            { ts: '9999999999.0004', subtype: 'channel_join', user: 'U1' },
          ],
        },
        { ok: true, messages: [] },
      ],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(0);
    await channel.disconnect();
  });

  it('picks up in-thread replies, which history alone never returns', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        { ok: true, messages: [] },
        {
          ok: true,
          messages: [
            {
              ts: '9999999999.1000',
              text: 'parent',
              user: 'U1',
              latest_reply: '9999999999.2000',
            },
          ],
        },
      ],
      'conversations.replies': [
        {
          ok: true,
          messages: [
            { ts: '9999999999.1000', text: 'parent', user: 'U1' },
            {
              ts: '9999999999.2000',
              text: 'in thread',
              user: 'U1',
              thread_ts: '9999999999.1000',
            },
          ],
        },
      ],
    });

    await pollOnce(channel);

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('in thread');
    expect(received[0].thread_id).toBe('9999999999.1000');
    await channel.disconnect();
  });

  it('advances the cursor so a message is delivered once', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        {
          ok: true,
          messages: [{ ts: '9999999999.0005', text: 'once', user: 'U1' }],
        },
        { ok: true, messages: [] },
        { ok: true, messages: [] },
        { ok: true, messages: [] },
      ],
    });

    await pollOnce(channel);
    await pollOnce(channel);

    expect(received).toHaveLength(1);
    await channel.disconnect();
  });

  it('survives a history error and keeps the cursor', async () => {
    const { channel, received } = await connected(registered);
    mockSlack({
      'conversations.history': [
        { ok: false },
        {
          ok: true,
          messages: [{ ts: '9999999999.0006', text: 'later', user: 'U1' }],
        },
        { ok: true, messages: [] },
      ],
    });

    await pollOnce(channel);
    expect(received).toHaveLength(0);

    await pollOnce(channel);
    expect(received).toHaveLength(1);
    await channel.disconnect();
  });
});

describe('sendMessage', () => {
  it('posts to the channel when the last inbound was top-level', async () => {
    const calls = mockSlack({ 'chat.postMessage': [{ ok: true }] });
    const { channel } = makeChannel(registered);

    await channel.sendMessage(JID, 'hello');

    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.params.get('channel')).toBe(CHANNEL);
    expect(post.params.get('text')).toBe('hello');
    expect(post.params.get('thread_ts')).toBeNull();
  });

  it('replies inside the thread the human spoke in', async () => {
    mockSlack({
      'auth.test': [{ ok: true, user_id: BOT, bot_id: BOT_ID }],
      'conversations.info': [{ ok: true }],
    });
    const { channel } = makeChannel(registered);
    await channel.connect();

    mockSlack({
      'conversations.history': [
        { ok: true, messages: [] },
        {
          ok: true,
          messages: [
            {
              ts: '9999999999.3000',
              user: 'U1',
              latest_reply: '9999999999.4000',
            },
          ],
        },
      ],
      'conversations.replies': [
        {
          ok: true,
          messages: [
            {
              ts: '9999999999.4000',
              text: 'ask',
              user: 'U1',
              thread_ts: '9999999999.3000',
            },
          ],
        },
      ],
    });
    await (channel as unknown as { poll: () => Promise<void> }).poll();

    const calls = mockSlack({ 'chat.postMessage': [{ ok: true }] });
    await channel.sendMessage(JID, 'answer');

    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.params.get('thread_ts')).toBe('9999999999.3000');
    await channel.disconnect();
  });

  it('throws when Slack rejects the post', async () => {
    mockSlack({ 'chat.postMessage': [{ ok: false }] });
    const { channel } = makeChannel(registered);
    await expect(channel.sendMessage(JID, 'hello')).rejects.toThrow(
      'chat.postMessage failed',
    );
  });
});
