import { request } from 'undici';
import { describe, expect, it } from 'vitest';
import { isSsrfError } from '../src/classify.js';
import { checkTargetUrl, deliveryAgent, isAllowedIp } from '../src/ssrf.js';

describe('isAllowedIp', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isAllowedIp(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', // loopback and private
    '169.254.169.254',                                   // cloud metadata
    '100.64.0.1', '0.0.0.0',                             // carrier NAT, "any"
    '::1', 'fe80::1', 'fd00:ec2::254',                   // IPv6 loopback, link-local, AWS metadata
    '::ffff:10.0.0.1', '::ffff:127.0.0.1',               // IPv4 hidden inside IPv6
  ])('blocks %s', (ip) => {
    expect(isAllowedIp(ip)).toBe(false);
  });

  it('rejects things that are not IPs', () => {
    expect(isAllowedIp('not-an-ip')).toBe(false);
  });
});

describe('checkTargetUrl', () => {
  it('allows a public https URL', () => {
    expect(checkTargetUrl('https://example.com/hook')).toBeNull();
  });

  it.each([
    'http://example.com/hook',              // plain http is off
    'https://127.0.0.1/hook',
    'https://2130706433/hook',              // 127.0.0.1 as one decimal number
    'https://0177.0.0.1/hook',              // 127.0.0.1 in octal
    'https://0x7f.0.0.1/hook',              // 127.0.0.1 in hex
    'https://[::1]/hook',
    'https://[::ffff:169.254.169.254]/hook',
    'ftp://example.com/',
    'not a url',
  ])('blocks %s', (url) => {
    expect(checkTargetUrl(url)).toMatch(/^ESSRF/);
  });
});

describe('DNS check', () => {
  it('blocks a hostname that points to a private address', async () => {
    const err = await request('https://localhost:9/', { dispatcher: deliveryAgent }).catch((e) => e);
    expect(isSsrfError(err)).toBe(true);
  });
});
