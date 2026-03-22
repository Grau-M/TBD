const API_BASE = 'http://142.55.32.101';

let apiTokenProvider: (() => Promise<string | undefined>) | undefined;

export class ApiHttpError extends Error {
  status: number;
  responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`API request failed with status ${status}`);
    this.status = status;
    this.responseBody = responseBody;
  }
}

export function configureApiTokenProvider(provider: (() => Promise<string | undefined>) | undefined): void {
  apiTokenProvider = provider;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = (await apiTokenProvider?.())?.trim();
  if (!token) {
    return {};
  }

  // Keep both headers temporarily for backend compatibility while migrating.
  return {
    Authorization: `Bearer ${token}`,
    'x-api-key': token
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
    throw new ApiHttpError(res.status, raw);
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

export async function apiGet(path: string): Promise<any> {
  return apiRequest(path, {
    method: 'GET'
  });
}