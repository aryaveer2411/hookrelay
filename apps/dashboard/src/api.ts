const KEY = 'hookrelay_token';
let token: string | null = sessionStorage.getItem(KEY);
const listeners = new Set<() => void>();

export const getToken = () => token;

export function setToken(t: string | null) {
  token = t;
  if (t) sessionStorage.setItem(KEY, t);
  else sessionStorage.removeItem(KEY);
  listeners.forEach((f) => f());
}

export function onTokenChange(f: () => void) {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (res.status === 401 && path !== '/login') setToken(null); // pass expired → back to login

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}
