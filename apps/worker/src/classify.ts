export type Outcome = 'success' | 'retry' | 'dead';

export function isSsrfError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === 'ESSRF' || e?.cause?.code === 'ESSRF';
}

export function classify(statusCode: number | null, err: unknown): Outcome {
  if (err) return isSsrfError(err) ? 'dead' : 'retry';   // blocked target: never retry
  if (statusCode === null) return 'retry';
  if (statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return 'retry';
  return 'dead';                                          // other 4xx and 3xx: retrying won't help
}
