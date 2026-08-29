/**
 * Raised for any 401 so the shell can tell an expired session from a real
 * failure. It still carries the server's message: on the login form a 401
 * *is* the answer ("that password is wrong"), and dropping the text left
 * the user staring at a generic apology.
 */
export class UnauthorizedError extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init)

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    const message = typeof body?.error === 'string' ? body.error : res.statusText
    throw res.status === 401 ? new UnauthorizedError(message) : new Error(message)
  }

  return res.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: unknown) =>
    req<T>(path, { method: 'POST', ...(body === undefined ? {} : json(body)) }),
  patch: <T>(path: string, body: unknown) => req<T>(path, { method: 'PATCH', ...json(body) }),
  put: <T>(path: string, body: unknown) => req<T>(path, { method: 'PUT', ...json(body) }),
  del: <T>(path: string) => req<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return req<T>(path, { method: 'POST', body: form })
  },
}
