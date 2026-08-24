import { auth } from './firebase';

async function authHeaders(): Promise<Record<string, string>> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  return { Authorization: `Bearer ${idToken}` };
}

async function parseResponse(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return data;
}

export async function adminGet(path: string) {
  const res = await fetch(path, { headers: await authHeaders() });
  return parseResponse(res);
}

export async function adminPost(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseResponse(res);
}

export async function adminDelete(path: string) {
  const res = await fetch(path, { method: 'DELETE', headers: await authHeaders() });
  return parseResponse(res);
}
