import { createHash } from 'node:crypto';

// A number from 0 to ~4.3 billion, taken from the first 4 bytes of an MD5 hash.
// MD5 is used only to spread keys evenly, not for security.
export const hash32 = (s: string) => createHash('md5').update(s).digest().readUInt32BE(0);

export class HashRing {
  private readonly points: number[];
  private readonly owners: string[];

  // Each partition gets 128 points spread around the ring (called virtual nodes)
  constructor(partitions: readonly string[], vnodes = 128) {
    if (partitions.length === 0) throw new Error('HashRing needs at least one partition');
    const entries: [number, string][] = [];
    for (const p of partitions) {
      for (let v = 0; v < vnodes; v++) entries.push([hash32(`${p}#${v}`), p]);
    }
    entries.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    this.points = entries.map((e) => e[0]);
    this.owners = entries.map((e) => e[1]);
  }

  // Hash the key, then walk clockwise to the first point: its owner is the answer
  get(key: string): string {
    const h = hash32(key);
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid]! < h) lo = mid + 1;
      else hi = mid;
    }
    return this.owners[lo === this.points.length ? 0 : lo]!;
  }
}
