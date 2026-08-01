/**
 * The single summons decision for trigger-required groups, shared by the
 * message loop's piping path and processGroupMessages' fresh-spawn path.
 *
 * A batch summons the agent when some message in it
 *   (a) carries the trigger — or arrives while a conversation container is
 *       already live, in which case the open conversation window stands in
 *       for the trigger — AND
 *   (b) comes from a sender allowed to summon (own messages always qualify).
 *
 * (b) applies in BOTH modes deliberately: an open conversation window must
 * not let an allowlist-denied sender drive the agent mid-conversation.
 */
import { getTriggerPattern } from './config.js';
import { isTriggerAllowed, SenderAllowlistConfig } from './sender-allowlist.js';

export interface SummonsCandidate {
  content: string;
  sender: string;
  is_from_me?: boolean;
}

export function hasSummons(
  chatJid: string,
  messages: SummonsCandidate[],
  opts: {
    trigger?: string;
    /** True while a conversation container is live for this group. */
    conversationActive?: boolean;
    allowlist: SenderAllowlistConfig;
  },
): boolean {
  const triggerPattern = getTriggerPattern(opts.trigger);
  return messages.some(
    (m) =>
      (opts.conversationActive === true ||
        triggerPattern.test(m.content.trim())) &&
      (Boolean(m.is_from_me) ||
        isTriggerAllowed(chatJid, m.sender, opts.allowlist)),
  );
}
