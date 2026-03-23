const API_BASE = 'http://142.55.32.101';
const API_KEY = 'supersecretkey123';

function formatErrorBody(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
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

async function apiRequest(path: string, init: RequestInit): Promise<any> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...authHeaders
    }
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new ApiHttpError(path, res.status, raw);
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export async function apiPost(path: string, body: any): Promise<any> {
  return apiRequest(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

export async function apiPut(path: string, body: any): Promise<any> {
  return apiRequest(path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

export async function apiGet(path: string): Promise<any> {
  return apiRequest(path, {
    method: 'GET'
  });
}