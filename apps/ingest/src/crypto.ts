import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const key = Buffer.from(config.ENV_MASTER_KEY, 'base64');
if (key.length !== 32) throw new Error('ENV_MASTER_KEY must be 32 bytes, base64');

// Make a new random secret for an endpoint
export function newSecret(): Buffer {
  return randomBytes(32);
}

// Encrypt a secret before saving it. `aad` ties it to one endpoint id.
export function seal(plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

// Decrypt a saved secret
export function open(blob: Buffer, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

// Check the webhook-signature header: "v1,<base64>" (can contain several, space-separated)
export function verifySignature(secret: Buffer, id: string, ts: string, body: Buffer, header: string): boolean {
  const expected = createHmac('sha256', secret).update(`${id}.${ts}.`).update(body).digest();
  return header.split(' ').some((part) => {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
