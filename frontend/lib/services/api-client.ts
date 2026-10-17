export interface ApiErrorDetails {
  path?: string
  message: string
}

interface ApiErrorResponse {
  error?: {
    code?: string
    message?: string
    details?: ApiErrorDetails[] | unknown
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: ApiErrorDetails[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function apiBaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_BASE_URL?.trim()
  if (!value) throw new ApiError('Set NEXT_PUBLIC_API_BASE_URL to the Express API URL.', 0, 'API_NOT_CONFIGURED')
  return value.replace(/\/+$/, '')
}

export function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers,
      credentials: 'include',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError('Could not reach the ReachInbox API. Check that the backend is running.', 0, 'NETWORK_ERROR')
  }

  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const payload = body && typeof body === 'object' ? body as ApiErrorResponse : undefined
    const error = payload?.error
    const details = Array.isArray(error?.details)
      ? error.details.filter(
          (detail): detail is ApiErrorDetails =>
            Boolean(detail) &&
            typeof detail === 'object' &&
            typeof (detail as ApiErrorDetails).message === 'string',
        )
      : []
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('reachinbox:unauthorized'))
    }
    throw new ApiError(
      error?.message ?? `The API request failed (${response.status}).`,
      response.status,
      error?.code ?? 'API_ERROR',
      details,
    )
  }

  return body as T
}

export function getCurrentUser() {
  return apiRequest<{ user: import('../types').User }>('/api/auth/me').then((result) => result.user)
}

export function logout() {
  return apiRequest<void>('/api/auth/logout', { method: 'POST' })
}
