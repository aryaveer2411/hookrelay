import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken } from '../api';
import { startLiveFeed, type Connection } from '../live';
import type { Endpoint, EventRow, StatusMsg } from '../types';
import { StatusBadge, time } from '../ui';

type Page = { events: EventRow[]; nextCursor: string | null };
type Filter = 'all' | 'dead';

// Update the table from one live message
function applyStatus(rows: EventRow[], m: StatusMsg, filter: Filter): EventRow[] {
  const status = m.outcome === 'delivered' ? 'delivered' : m.outcome === 'dead' ? 'dead' : 'pending';
  const i = rows.findIndex((r) => r.id === m.eventId);
  if (i === -1) {
    if (m.outcome !== 'received' || filter !== 'all') return rows;
    return [{ id: m.eventId, external_id: m.externalId ?? '', status, received_at: m.at, attempts: 0 }, ...rows];
  }
  const copy = rows.slice();
  const row = copy[i]!;
  copy[i] = { ...row, status, attempts: Math.max(row.attempts, m.attempt) };
  return copy;
}

export function EndpointPage({ id }: { id: string }) {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [conn, setConn] = useState<Connection>({ state: 'connecting' });
  const [log, setLog] = useState<StatusMsg[]>([]);
  const [message, setMessage] = useState('');

  const statusParam = filter === 'dead' ? 'status=dead' : '';

  const reload = useCallback(async () => {
    const page = await api<Page>(`/endpoints/${id}/events?${statusParam}`);
    setRows(page.events);
    setCursor(page.nextCursor);
    setSelected(new Set());
  }, [id, statusParam]);

  async function loadMore() {
    if (!cursor) return;
    const page = await api<Page>(`/endpoints/${id}/events?cursor=${encodeURIComponent(cursor)}&${statusParam}`);
    setRows((r) => [...r, ...page.events.filter((e) => !r.some((x) => x.id === e.id))]);
    setCursor(page.nextCursor);
  }

  useEffect(() => { api<Endpoint>(`/endpoints/${id}`).then(setEndpoint).catch(() => setEndpoint(null)); }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  // Refs let the live connection always use the latest filter and reload
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const startIndex = new URLSearchParams(location.search).get('gw') === '2' ? 1 : 0;
    return startLiveFeed({
      token,
      endpointId: id,
      startIndex,
      onConnection: setConn,
      onSubscribed: () => { void reloadRef.current(); }, // catch up on anything missed while offline
      onAuthFailed: () => setToken(null),
      onStatus: (m) => {
        setLog((l) => [m, ...l].slice(0, 30));
        setRows((r) => applyStatus(r, m, filterRef.current));
      },
    });
  }, [id]);

  function toggle(eventId: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(eventId)) next.delete(eventId); else next.add(eventId);
      return next;
    });
  }

  async function replayOne(eventId: string) {
    try {
      await api(`/events/${eventId}/replay`, { method: 'POST' });
      setMessage('Replay queued');
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function replaySelected() {
    try {
      const r = await api<{ replayed: string[] }>('/events/replay', { method: 'POST', body: { ids: [...selected] } });
      setMessage(`${r.replayed.length} replay(s) queued`);
      setSelected(new Set());
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  return (
    <>
      <div className="card row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>{endpoint?.name ?? 'Endpoint'}</h2>
          <code className="muted">{endpoint?.target_url}</code>
        </div>
        <span className={`badge ${conn.state}`}>
          {conn.state === 'live' ? `live via ${conn.gateway}` : conn.state}
        </span>
      </div>

      <div className="layout">
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <button className={filter === 'all' ? 'primary' : ''} onClick={() => setFilter('all')}>All</button>
            <button className={filter === 'dead' ? 'primary' : ''} onClick={() => setFilter('dead')}>Dead letters</button>
            {selected.size > 0 && (
              <button onClick={() => void replaySelected()}>Replay {selected.size} selected</button>
            )}
            {message && <span className="muted">{message}</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th></th><th>Received</th><th>Webhook id</th><th>Status</th><th>Tries</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.status === 'dead' && (
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      )}
                    </td>
                    <td>{time(r.received_at)}</td>
                    <td><a href={`#/events/${r.id}`}><code>{r.external_id || r.id.slice(0, 8)}</code></a></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{r.attempts}</td>
                    <td>{r.status === 'dead' && <button onClick={() => void replayOne(r.id)}>Replay</button>}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={6} className="muted">No events yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {cursor && <button style={{ marginTop: 8 }} onClick={() => void loadMore()}>Load more</button>}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Live log</h3>
          <div className="log">
            {log.map((m, i) => (
              <div key={i}>{time(m.at)} {m.outcome} #{m.attempt} {m.eventId.slice(0, 8)}</div>
            ))}
            {log.length === 0 && <span className="muted">Waiting for events…</span>}
          </div>
        </div>
      </div>
    </>
  );
}
