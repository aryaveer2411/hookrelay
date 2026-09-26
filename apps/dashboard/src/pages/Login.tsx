import { useState, type FormEvent } from 'react';
import { api, ApiError, setToken } from '../api';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string }>('/login', { method: 'POST', body: { password } });
      setToken(r.token);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many tries, wait a second' : 'Wrong password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card login" onSubmit={submit}>
      <h2>HookRelay</h2>
      <input type="password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} autoFocus required />
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
