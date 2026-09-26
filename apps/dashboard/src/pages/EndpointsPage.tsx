import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Endpoint } from '../types';

type Created = { endpoint: Endpoint; inboundSecret: string; outboundSecret: string };

export function EndpointsPage() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [form, setForm] = useState({ name: '', targetUrl: 'http://127.0.0.1:4000/hook', ratePerSec: 50, ordered: false });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ endpoints: Endpoint[] }>('/endpoints');
    setEndpoints(r.endpoints);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      setCreated(await api<Created>('/endpoints', { method: 'POST', body: form }));
      setForm({ ...form, name: '' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="card">
        <h2>New endpoint</h2>
        <form className="row" onSubmit={create}>
          <input placeholder="Name" value={form.name} required
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Target URL" size={34} value={form.targetUrl} required
            onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} />
          <input type="number" min={1} max={1000} title="Requests per second" value={form.ratePerSec}
            onChange={(e) => setForm({ ...form, ratePerSec: Number(e.target.value) })} />
          <label className="row">
            <input type="checkbox" checked={form.ordered}
              onChange={(e) => setForm({ ...form, ordered: e.target.checked })} /> ordered
          </label>
          <button className="primary">Create</button>
        </form>
        {error && <p className="error">{error}</p>}
        {created && (
          <div style={{ marginTop: 12 }}>
            <p><strong>Copy these now. They are shown only once.</strong></p>
            <p className="muted">Endpoint id</p>
            <div className="secret">{created.endpoint.id}</div>
            <p className="muted">Inbound secret (for senders)</p>
            <div className="secret">{created.inboundSecret}</div>
            <p className="muted">Outbound secret (for your receiver to check signatures)</p>
            <div className="secret">{created.outboundSecret}</div>
            <button style={{ marginTop: 8 }} onClick={() => setCreated(null)}>I saved them</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Endpoints</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Target</th><th>Rate/s</th><th>Ordered</th><th>State</th></tr></thead>
            <tbody>
              {endpoints.map((ep) => (
                <tr key={ep.id}>
                  <td><a href={`#/endpoints/${ep.id}`}>{ep.name}</a></td>
                  <td><code>{ep.target_url}</code></td>
                  <td>{ep.rate_per_sec}</td>
                  <td>{ep.ordered ? 'yes' : 'no'}</td>
                  <td>{ep.disabled_at ? <span className="muted">disabled</span> : 'active'}</td>
                </tr>
              ))}
              {endpoints.length === 0 && <tr><td colSpan={5} className="muted">No endpoints yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
