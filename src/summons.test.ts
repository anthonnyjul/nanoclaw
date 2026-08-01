import { describe, it, expect } from 'vitest';

import { SenderAllowlistConfig } from './sender-allowlist.js';
import { hasSummons, SummonsCandidate } from './summons.js';

const JID = 'C123@slack';

const allowAll: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: false,
};

const onlyU1: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: { [JID]: { allow: ['U1'], mode: 'trigger' } },
  logDenied: false,
};

function msg(
  content: string,
  sender = 'U1',
  is_from_me = false,
): SummonsCandidate {
  return { content, sender, is_from_me };
}

describe('hasSummons', () => {
  it('is false for an empty batch', () => {
    expect(hasSummons(JID, [], { allowlist: allowAll })).toBe(false);
  });

  it('summons on a trigger from an allowed sender', () => {
    expect(
      hasSummons(JID, [msg('@Aria hello')], {
        trigger: '@Aria',
        allowlist: allowAll,
      }),
    ).toBe(true);
  });

  it('does not summon without trigger when no conversation is active', () => {
    expect(
      hasSummons(JID, [msg('just chatting')], {
        trigger: '@Aria',
        allowlist: allowAll,
      }),
    ).toBe(false);
  });

  it('summons without trigger while a conversation is active', () => {
    expect(
      hasSummons(JID, [msg('and the cart?')], {
        trigger: '@Aria',
        conversationActive: true,
        allowlist: allowAll,
      }),
    ).toBe(true);
  });

  it('denies a trigger from a sender outside the allowlist', () => {
    expect(
      hasSummons(JID, [msg('@Aria do it', 'U9')], {
        trigger: '@Aria',
        allowlist: onlyU1,
      }),
    ).toBe(false);
  });

  it('still applies the allowlist while a conversation is active', () => {
    // An open conversation window must not let a denied sender drive the
    // agent — the trigger requirement is waived, the allowlist is not.
    expect(
      hasSummons(JID, [msg('sneaky follow-up', 'U9')], {
        trigger: '@Aria',
        conversationActive: true,
        allowlist: onlyU1,
      }),
    ).toBe(false);
  });

  it('lets own messages summon regardless of the allowlist', () => {
    expect(
      hasSummons(JID, [msg('note to self', 'U9', true)], {
        trigger: '@Aria',
        conversationActive: true,
        allowlist: onlyU1,
      }),
    ).toBe(true);
  });

  it('summons when any message in the batch qualifies', () => {
    expect(
      hasSummons(JID, [msg('chatter', 'U9'), msg('@Aria ping', 'U1')], {
        trigger: '@Aria',
        allowlist: onlyU1,
      }),
    ).toBe(true);
  });

  it('respects the per-group trigger word', () => {
    expect(
      hasSummons(JID, [msg('@Claw go')], {
        trigger: '@Claw',
        allowlist: allowAll,
      }),
    ).toBe(true);
    expect(
      hasSummons(JID, [msg('@Aria go')], {
        trigger: '@Claw',
        allowlist: allowAll,
      }),
    ).toBe(false);
  });
});
