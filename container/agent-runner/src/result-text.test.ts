import { describe, it, expect } from 'vitest';

import { extractAssistantText } from './result-text.js';

describe('extractAssistantText', () => {
  it('returns the text of a single text block', () => {
    expect(extractAssistantText([{ type: 'text', text: 'hello' }])).toBe(
      'hello',
    );
  });

  it('joins multiple text blocks in order', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('ignores thinking blocks around the text (trailing-thinking case)', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: 'answer' },
        { type: 'redacted_thinking', data: 'x' },
      ]),
    ).toBe('answer');
  });

  it('returns undefined for a thinking-only message', () => {
    expect(
      extractAssistantText([{ type: 'redacted_thinking', data: 'x' }]),
    ).toBeUndefined();
  });

  it('returns undefined for empty-string text blocks', () => {
    expect(extractAssistantText([{ type: 'text', text: '' }])).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(extractAssistantText([])).toBeUndefined();
  });

  it('returns undefined for non-array content', () => {
    expect(extractAssistantText(undefined)).toBeUndefined();
    expect(extractAssistantText(null)).toBeUndefined();
    expect(extractAssistantText('text')).toBeUndefined();
    expect(extractAssistantText({ type: 'text', text: 'x' })).toBeUndefined();
  });

  it('skips malformed blocks (null entries, missing/non-string text)', () => {
    expect(
      extractAssistantText([
        null,
        { type: 'text' },
        { type: 'text', text: 42 },
        { type: 'text', text: 'ok' },
      ]),
    ).toBe('ok');
  });
});
