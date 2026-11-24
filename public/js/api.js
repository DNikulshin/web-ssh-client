// Тонкая обёртка над fetch: одна точка, где решается, что считать ошибкой и как
// показывать её пользователю. Иначе каждая функция придумывает свой текст.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    payload = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const message = (payload && payload.error) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return payload;
}

export const api = {
  authState: () => request('GET', '/api/auth/state'),
  login: (login, password) => request('POST', '/api/auth/login', { login, password }),
  register: (login, password) => request('POST', '/api/auth/register', { login, password }),
  logout: () => request('POST', '/api/auth/logout'),

  hosts: () => request('GET', '/api/hosts'),
  addHost: (host) => request('POST', '/api/hosts', host),
  deleteHost: (id) => request('DELETE', `/api/hosts/${id}`),

  credentials: () => request('GET', '/api/credentials'),
  addCredential: (cred) => request('POST', '/api/credentials', cred),
  deleteCredential: (id) => request('DELETE', `/api/credentials/${id}`),

  sessions: () => request('GET', '/api/sessions'),
  createSession: (payload) => request('POST', '/api/sessions', payload),
  killSession: (id) => request('DELETE', `/api/sessions/${id}`),
  scrollback: (id, from = 0, limit = 5000) =>
    request('GET', `/api/sessions/${id}/scrollback?from=${from}&limit=${limit}`),

  getState: (device) => request('GET', `/api/state?device=${encodeURIComponent(device)}`),
  putState: (device, data) => request('PUT', '/api/state', { device, data }),
};
