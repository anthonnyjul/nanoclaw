import { describe, it, expect } from 'vitest';

import {
  buildTriggerPattern,
  getTriggerPattern,
  DEFAULT_TRIGGER,
} from './config.js';

describe('buildTriggerPattern', () => {
  it('matches the @-prefixed trigger at the start', () => {
    expect(buildTriggerPattern('@Aria').test('@Aria are you there?')).toBe(
      true,
    );
  });

  it('matches the bare name without the @', () => {
    expect(buildTriggerPattern('@Aria').test('Aria are you there?')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(buildTriggerPattern('@Aria').test('aria status?')).toBe(true);
  });

  it('does not match the name mid-sentence', () => {
    expect(buildTriggerPattern('@Aria').test('I asked Aria yesterday')).toBe(
      false,
    );
  });

  it('does not match a longer word sharing the prefix', () => {
    expect(buildTriggerPattern('@Aria').test('Arianna hello')).toBe(false);
  });

  it('accepts a trigger configured without the @', () => {
    const p = buildTriggerPattern('Aria');
    expect(p.test('@Aria hi')).toBe(true);
    expect(p.test('Aria hi')).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the group trigger when given', () => {
    expect(getTriggerPattern('@Aria').test('aria ping')).toBe(true);
  });

  it('falls back to DEFAULT_TRIGGER when the trigger is missing or empty', () => {
    const name = DEFAULT_TRIGGER.replace(/^@/, '');
    expect(getTriggerPattern(undefined).test(`${name} hi`)).toBe(true);
    expect(getTriggerPattern('').test(`@${name} hi`)).toBe(true);
    expect(getTriggerPattern('  ').test(`${name} hi`)).toBe(true);
  });
});
