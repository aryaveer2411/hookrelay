import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, retryExchangeFor } from '@hookrelay/shared/topology';
import { classify } from '../src/classify.js';

describe('classify', () => {
  it.each([
    [200, 'success'], [204, 'success'],
    [301, 'dead'], [400, 'dead'], [401, 'dead'], [404, 'dead'],
    [408, 'retry'], [429, 'retry'], [500, 'retry'], [503, 'retry'],
  ] as const)('HTTP %i → %s', (code, expected) => {
    expect(classify(code, null)).toBe(expected);
  });

  it('network error → retry', () => {
    expect(classify(null, Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('retry');
  });
  it('SSRF block → dead', () => {
    expect(classify(null, Object.assign(new Error('blocked'), { code: 'ESSRF' }))).toBe('dead');
  });
});

describe('retry schedule', () => {
  it('sends each failed attempt to the right waiting room', () => {
    expect(retryExchangeFor(1)).toBe('retry.10s.x');
    expect(retryExchangeFor(2)).toBe('retry.1m.x');
    expect(retryExchangeFor(3)).toBe('retry.5m.x');
    expect(retryExchangeFor(4)).toBe('retry.30m.x');
  });
  it('has no waiting room after the last attempt', () => {
    expect(() => retryExchangeFor(MAX_ATTEMPTS)).toThrow();
  });
});
