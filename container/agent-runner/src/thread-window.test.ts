import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  findResumeAnchor,
  DEFAULT_THREAD_WINDOW,
  THREAD_WINDOW_ENV_VAR,
} from './thread-window.js';

let tmpDir: string;

function writeJsonl(filename: string, lines: string[]): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

function assistantLine(uuid: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text: 'hi' }] },
  });
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-window-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findResumeAnchor', () => {
  it('returns undefined for an empty file', () => {
    const p = writeJsonl('empty.jsonl', []);
    expect(findResumeAnchor(p, 5)).toBeUndefined();
  });

  it('returns undefined when the log has fewer assistant messages than windowSize', () => {
    const p = writeJsonl('short.jsonl', [
      userLine('q1'),
      assistantLine('a1'),
      userLine('q2'),
      assistantLine('a2'),
    ]);
    expect(findResumeAnchor(p, 5)).toBeUndefined();
  });

  it('returns the first assistant UUID when count equals windowSize', () => {
    const p = writeJsonl('exact.jsonl', [
      assistantLine('a1'),
      assistantLine('a2'),
      assistantLine('a3'),
    ]);
    expect(findResumeAnchor(p, 3)).toBe('a1');
  });

  it('returns the (len - windowSize)-th assistant UUID when count exceeds windowSize', () => {
    const p = writeJsonl('window.jsonl', [
      assistantLine('a1'),
      assistantLine('a2'),
      assistantLine('a3'),
      assistantLine('a4'),
      assistantLine('a5'),
    ]);
    // len=5, windowSize=2 → anchor at index (5-2)=3 → 'a4'
    expect(findResumeAnchor(p, 2)).toBe('a4');
  });

  it('skips malformed JSON lines without throwing', () => {
    const p = writeJsonl('malformed.jsonl', [
      assistantLine('a1'),
      'this is not json',
      assistantLine('a2'),
      '{"broken":',
      assistantLine('a3'),
    ]);
    expect(findResumeAnchor(p, 3)).toBe('a1');
  });

  it('returns undefined when windowSize is 0 (defensive disable sentinel)', () => {
    const p = writeJsonl('any.jsonl', [
      assistantLine('a1'),
      assistantLine('a2'),
    ]);
    expect(findResumeAnchor(p, 0)).toBeUndefined();
  });

  it('returns the last assistant UUID when windowSize is 1', () => {
    const p = writeJsonl('last.jsonl', [
      assistantLine('a1'),
      assistantLine('a2'),
      assistantLine('a3'),
    ]);
    expect(findResumeAnchor(p, 1)).toBe('a3');
  });

  it('counts only assistant-typed lines (skips user and system entries)', () => {
    const p = writeJsonl('interleaved.jsonl', [
      userLine('q1'),
      assistantLine('a1'),
      JSON.stringify({ type: 'system', subtype: 'init' }),
      userLine('q2'),
      assistantLine('a2'),
      JSON.stringify({ type: 'result', subtype: 'success' }),
      userLine('q3'),
      assistantLine('a3'),
    ]);
    // Only 3 assistant lines; windowSize=2 → anchor at (3-2)=1 → 'a2'
    expect(findResumeAnchor(p, 2)).toBe('a2');
  });

  it('returns undefined when the file is missing (no throw)', () => {
    const missing = path.join(tmpDir, 'does-not-exist.jsonl');
    expect(findResumeAnchor(missing, 3)).toBeUndefined();
  });

  it('ignores assistant entries missing a uuid field', () => {
    const p = writeJsonl('missing-uuid.jsonl', [
      assistantLine('a1'),
      // Assistant entry without uuid — should be ignored
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'no uuid' }] },
      }),
      assistantLine('a2'),
      assistantLine('a3'),
    ]);
    // Effective assistant UUIDs: [a1, a2, a3]; windowSize=2 → anchor at (3-2)=1 → 'a2'
    expect(findResumeAnchor(p, 2)).toBe('a2');
  });

  it('exports the default window size and env var name as named constants', () => {
    expect(DEFAULT_THREAD_WINDOW).toBe(15);
    expect(THREAD_WINDOW_ENV_VAR).toBe('THREAD_WINDOW');
  });
});
