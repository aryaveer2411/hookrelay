import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newSecret, open, seal, verifySignature } from '../src/crypto.js';

const secret = newSecret();
const id = 'msg_1';
const ts = '1700000000';
const body = Buffer.from('{"hello":"world"}');
const sigFor = (s: Buffer, i = id, t = ts, b = body) =>
  'v1,' + createHmac('sha256', s).update(`${i}.${t}.`).update(b).digest('base64');

describe('seal / open', () => {
  it('gets the same secret back', () => {
    expect(open(seal(secret, 'ep-a'), 'ep-a').equals(secret)).toBe(true);
  });
  it('fails if the ciphertext is copied to another endpoint', () => {
    expect(() => open(seal(secret, 'ep-a'), 'ep-b')).toThrow();
  });
  it('fails if the ciphertext was changed', () => {
    const blob = seal(secret, 'ep-a');
    blob[blob.length - 1] ^= 1;
    expect(() => open(blob, 'ep-a')).toThrow();
  });
});

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    expect(verifySignature(secret, id, ts, body, sigFor(secret))).toBe(true);
  });
  it('rejects a changed body', () => {
    expect(verifySignature(secret, id, ts, Buffer.from('{"hello":"evil"}'), sigFor(secret))).toBe(false);
  });
  it('rejects a changed id', () => {
    expect(verifySignature(secret, 'msg_2', ts, body, sigFor(secret))).toBe(false);
  });
  it('rejects a changed timestamp', () => {
    expect(verifySignature(secret, id, '1700000001', body, sigFor(secret))).toBe(false);
  });
  it('rejects the wrong secret', () => {
    expect(verifySignature(secret, id, ts, body, sigFor(newSecret()))).toBe(false);
  });
  it('rejects a too-short signature', () => {
    expect(verifySignature(secret, id, ts, body, 'v1,AAAA')).toBe(false);
  });
  it('rejects an unknown version', () => {
    expect(verifySignature(secret, id, ts, body, sigFor(secret).replace('v1,', 'v2,'))).toBe(false);
  });
  it('accepts when one of several signatures matches', () => {
    expect(verifySignature(secret, id, ts, body, `${sigFor(newSecret())} ${sigFor(secret)}`)).toBe(true);
  });
});
