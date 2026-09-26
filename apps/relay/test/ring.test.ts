import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HashRing, hash32 } from '@hookrelay/shared/ring';

const eight = Array.from({ length: 8 }, (_, i) => `p${i}`);
const keys = Array.from({ length: 100_000 }, () => randomUUID());

describe('HashRing', () => {
  it('always gives the same partition for the same endpoint', () => {
    const ring = new HashRing(eight);
    for (const k of keys.slice(0, 1000)) expect(ring.get(k)).toBe(ring.get(k));
    expect(new HashRing(eight).get(keys[0]!)).toBe(ring.get(keys[0]!));
  });

  it('spreads 100K endpoints evenly: each partition gets 12.5% ± 2%', () => {
    const ring = new HashRing(eight);
    const counts = new Map<string, number>();
    for (const k of keys) {
      const p = ring.get(k);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    expect(counts.size).toBe(8);
    for (const p of eight) {
      const share = ((counts.get(p) ?? 0) / keys.length) * 100;
      expect(share).toBeGreaterThan(10.5);
      expect(share).toBeLessThan(14.5);
    }
  });

  it('adding a 9th partition moves only about 1/9 of endpoints, all to the new one', () => {
    const before = new HashRing(eight);
    const after = new HashRing([...eight, 'p8']);
    let moved = 0;
    for (const k of keys) {
      const a = before.get(k);
      const b = after.get(k);
      if (a !== b) {
        moved++;
        expect(b).toBe('p8');
      }
    }
    const pct = (moved / keys.length) * 100;
    expect(pct).toBeGreaterThan(8);
    expect(pct).toBeLessThan(15);
  });

  it('for comparison, hash % N would move almost everything', () => {
    let moved = 0;
    for (const k of keys) {
      const h = hash32(k);
      if (h % 8 !== h % 9) moved++;
    }
    expect((moved / keys.length) * 100).toBeGreaterThan(85);
  });
});
