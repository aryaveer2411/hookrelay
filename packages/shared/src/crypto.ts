import { createDecipheriv, createHmac } from 'node:crypto';

// Decrypt a secret saved by the ingest app (same format: iv | tag | ciphertext)
export function openSecret(masterKey: Buffer, blob: Buffer, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', masterKey, blob.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

// Build the webhook-signature header value: "v1,<base64 HMAC>"
export function sign(secret: Buffer, id: string, ts: string, body: string): string {
  return 'v1,' + createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
}
