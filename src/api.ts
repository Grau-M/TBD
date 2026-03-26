export const API_BASE = 'http://142.55.32.101';
const API_KEY = 'supersecretkey123';

interface ApiRequestOptions {
  silent?: boolean;
}

let cachedHealthCheck: Promise<any> | null = null;

function formatErrorBody(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const parts: string[] = [];
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        parts.push(parsed.error.trim());
      }
      if (typeof parsed.message === 'string' && parsed.message.trim() && parsed.message.trim() !== parsed.error?.trim()) {
        parts.push(parsed.message.trim());
      }
      if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
        parts.push(parsed.detail.trim());
      }
      if (typeof parsed.details === 'string' && parsed.details.trim()) {
        parts.push(parsed.details.trim());
      }

      if (parts.length > 0) {
        return parts.join(' | ');
      }

      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Fall through to plain text handling.
  }

  return text.replace(/\s+/g, ' ').slice(0, 800);
}

export class ApiHttpError extends Error {
  path: string;
  status: number;
  responseBody: string;

  constructor(path: string, status: number, responseBody: string) {
    const bodySnippet = formatErrorBody(responseBody);
    super(
      bodySnippet
        ? `API ${path} failed with status ${status}: ${bodySnippet}`
        : `API ${path} failed with status ${status}`
    );
    this.path = path;
    this.status = status;
    this.responseBody = responseBody;
  }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'x-api-key': API_KEY
  };
}

async function apiRequest(path: string, init: RequestInit, options?: ApiRequestOptions): Promise<any> {
  const authHeaders = await getAuthHeaders();
  const url = `${API_BASE}${path}`;
  const method = String(init.method || 'GET').toUpperCase();
  const silent = options?.silent === true;

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...authHeaders
      }
    });

    const raw = await res.text();
    if (!res.ok) {
      if (!silent) {
        console.error('[TBD API ERROR]', { method, url, status: res.status, responseBody: raw });
      }
      throw new ApiHttpError(path, res.status, raw);
    }

    if (!raw) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw);
      return parsed;
    } catch {
      return { raw };
    }
  } catch (error) {
    if (!silent) {
      console.error('[TBD API FETCH ERROR]', { method, url, error });
    }
    throw error;
  }
}

export async function apiPost(path: string, body: any, options?: ApiRequestOptions): Promise<any> {
  // --- TEMPORARY TEST HACK ---
    // Uncomment the line below to simulate the server being dead
     //throw new Error("Simulated Offline Mode"); 
    // ---------------------------
  return apiRequest(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, options);
}

export async function apiPut(path: string, body: any, options?: ApiRequestOptions): Promise<any> {
  return apiRequest(path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, options);
}

export async function apiPatch(path: string, body: any, options?: ApiRequestOptions): Promise<any> {
  return apiRequest(path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, options);
}

export async function apiGet(path: string, options?: ApiRequestOptions): Promise<any> {
  if (path === '/health') {
    if (!cachedHealthCheck) {
      cachedHealthCheck = apiRequest(path, {
        method: 'GET'
      }, options).catch((error) => {
        cachedHealthCheck = null;
        throw error;
      });
    }

    return cachedHealthCheck;
  }

  return apiRequest(path, {
    method: 'GET'
  }, options);
}