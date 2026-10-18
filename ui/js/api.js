// Thin client for the local server.
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; this.code = (data && data.code) || ''; }
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body != null ? { 'Content-Type': 'application/json' } : undefined, body: body != null ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('The kit server is not reachable. Is it still running?', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  // the pages are read from disk on every load, but a server started before an update does not know the new routes
  if (res.status === 404 && data && data.error === 'Unknown endpoint') throw new ApiError('This window is connected to an older copy of the kit that is still running. Close the kit (and its black console window), then start it again.', 404, { code: 'stale-server' });
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body || {});
export const patch = (url, body) => api('PATCH', url, body || {});
export const put = (url, body) => api('PUT', url, body || {});
