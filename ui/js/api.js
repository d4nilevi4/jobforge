const base = '/api/v1';
let memoryToken = null;

// The server module is outside the static root; preserve its ApiError interface here.
export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = Array.isArray(details) ? details : [];
  }
}

export function getToken() {
  if (memoryToken !== null) return memoryToken;
  try { return localStorage.getItem('jobforge.token') || ''; } catch { return ''; }
}

export function setToken(token) {
  memoryToken = token.trim();
  try {
    if (memoryToken) localStorage.setItem('jobforge.token', memoryToken);
    else localStorage.removeItem('jobforge.token');
  } catch { /* The current session still works when storage is unavailable. */ }
}

function apiPath(path) {
  if (path === base || path.startsWith(`${base}/`)) return path;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new ApiError(0, 'bad_request', 'Invalid API path. Use a path under /api/v1/.');
  }
  return `${base}${path}`;
}

async function request(path, { method = 'GET', body, format = 'json', signal, public: isPublic = false } = {}) {
  const headers = { Accept: format === 'json' ? 'application/json' : '*/*' };
  const token = getToken();
  if (!isPublic && token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(apiPath(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, credentials: 'same-origin' });
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof ApiError) throw error;
    throw new ApiError(0, 'network_error', 'Cannot reach JobForge. Check that the server is running, then try again.');
  }
  if (!response.ok) {
    let envelope;
    try { envelope = await response.json(); } catch { /* Use the HTTP fallback below. */ }
    const error = new ApiError(response.status, envelope?.error?.code || 'request_failed', envelope?.error?.message || `Request to ${path} failed (${response.status}). Try again or check the server console.`, envelope?.error?.details);
    if (response.status === 401 && !isPublic && getToken() === token) {
      setToken('');
      window.dispatchEvent(new CustomEvent('jobforge:unauthorized', { detail: error }));
    }
    throw error;
  }
  if (response.status === 204) return null;
  if (format === 'blob') return response.blob();
  if (format === 'text') return response.text();
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new ApiError(response.status, 'invalid_response', `The server returned invalid JSON for ${path}. Check the server console and retry.`); }
}

export const api = {
  get: (path, options) => request(path, options),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  remove: (path, options) => request(path, { ...options, method: 'DELETE' }),
  getBlob: (path, options) => request(path, { ...options, format: 'blob' }),
  getText: (path, options) => request(path, { ...options, format: 'text' })
};
