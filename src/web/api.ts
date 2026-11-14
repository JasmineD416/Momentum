export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

// Local development only: lets the "View as" switcher act as another member (ignored by the production server).
export const devUser = { email: '' as string };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (import.meta.env.DEV && devUser.email) headers['x-dev-user'] = devUser.email;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const d = (typeof data === 'object' ? data : {}) as Record<string, unknown>;
    throw new ApiError(res.status, String(d.error || `The server returned an error (${res.status}).`), d);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T = any>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T = any>(path: string, body: unknown) => request<T>('PUT', path, body),
  /** Fetch a protected CSV and hand it to the browser as a download. */
  async download(path: string, filename: string) {
    const headers: Record<string, string> = {};
    if (import.meta.env.DEV && devUser.email) headers['x-dev-user'] = devUser.email;
    const res = await fetch(path, { headers, credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'The export failed.');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const qs = (params: Record<string, string | undefined>) =>
  '?' + Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
