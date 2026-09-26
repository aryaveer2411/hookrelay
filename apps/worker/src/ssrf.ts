import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import { config } from './config.js';

const allowList = new Set(config.ENV_SSRF_ALLOW_IPS);

// Only public addresses are allowed (plus anything on the dev allow list)
export function isAllowedIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.process(address); // turns ::ffff:10.0.0.1 into 10.0.0.1
  if (allowList.has(ip.toString())) return true;
  return ip.range() === 'unicast';
}

function ssrfError(message: string) {
  return Object.assign(new Error(message), { code: 'ESSRF' });
}

// Check the URL before connecting. Returns an error message, or null if OK.
export function checkTargetUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw); // also turns tricks like http://2130706433 into 127.0.0.1
  } catch {
    return 'ESSRF: invalid URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.ENV_ALLOW_HTTP)) {
    return `ESSRF: scheme ${url.protocol} not allowed`;
  }
  // IP addresses written directly in the URL skip DNS, so check them here
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isAllowedIp(host)) {
    return `ESSRF: blocked address ${host}`;
  }
  return null;
}

// Hostnames: look up the IP once, check it, and connect to exactly that IP
function guardedLookup(hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.length === 0) return callback(ssrfError(`ESSRF: ${hostname} has no addresses`));
    const blocked = addresses.find((a) => !isAllowedIp(a.address));
    if (blocked) return callback(ssrfError(`ESSRF: ${hostname} resolves to blocked address ${blocked.address}`));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

// All deliveries use this agent. It never follows redirects.
export const deliveryAgent = new Agent({
  connect: { lookup: guardedLookup as any, timeout: 5_000 },
});
