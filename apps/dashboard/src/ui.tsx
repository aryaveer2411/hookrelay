import type { EventStatus } from './types';

export function StatusBadge({ status }: { status: EventStatus }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString();
