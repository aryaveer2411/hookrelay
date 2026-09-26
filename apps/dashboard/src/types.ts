export type Endpoint = {
  id: string;
  name: string;
  target_url: string;
  rate_per_sec: number;
  ordered: boolean;
  disabled_at: string | null;
  created_at: string;
};

export type EventStatus = 'pending' | 'delivered' | 'dead';

export type EventRow = {
  id: string;
  external_id: string;
  status: EventStatus;
  received_at: string;
  attempts: number;
};

export type Attempt = {
  attempt: number;
  status_code: number | null;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
};

export type EventDetail = {
  event: { id: string; endpoint_id: string; external_id: string; status: EventStatus; payload: unknown; received_at: string };
  attempts: Attempt[];
  replays: { replayed_by: string; created_at: string }[];
};

export type StatusMsg = {
  type: 'status';
  eventId: string;
  endpointId: string;
  externalId?: string;
  attempt: number;
  outcome: 'received' | 'delivered' | 'retrying' | 'dead' | 'replayed';
  statusCode?: number | null;
  at: string;
};
