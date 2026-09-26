import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { EventDetail } from '../types';
import { StatusBadge, time } from '../ui';

export function EventPage({ id }: { id: string }) {
  const [data, setData] = useState<EventDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<EventDetail>(`/events/${id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function replay() {
    try {
      await api(`/events/${id}/replay`, { method: 'POST' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { event, attempts, replays } = data;

  return (
    <>
      <p><a href={`#/endpoints/${event.endpoint_id}`}>← Back to endpoint</a></p>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}><code>{event.external_id}</code></h2>
            <span className="muted">received {new Date(event.received_at).toLocaleString()}</span>
          </div>
          <div className="row">
            <StatusBadge status={event.status} />
            {event.status === 'dead' && <button className="primary" onClick={() => void replay()}>Replay</button>}
            <button onClick={() => void load()}>Refresh</button>
          </div>
        </div>
        <h3>Payload</h3>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Attempts</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Time</th><th>HTTP</th><th>Latency</th><th>Error</th></tr></thead>
            <tbody>
              {attempts.map((a, i) => (
                <tr key={i}>
                  <td>{a.attempt}</td>
                  <td>{time(a.created_at)}</td>
                  <td>{a.status_code ?? '—'}</td>
                  <td>{a.latency_ms != null ? `${a.latency_ms} ms` : '—'}</td>
                  <td className="muted">{a.error ?? ''}</td>
                </tr>
              ))}
              {attempts.length === 0 && <tr><td colSpan={5} className="muted">No attempts yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {replays.length > 0 && (
          <>
            <h3>Replays</h3>
            {replays.map((r, i) => (
              <div key={i} className="muted">{new Date(r.created_at).toLocaleString()} by {r.replayed_by}</div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
