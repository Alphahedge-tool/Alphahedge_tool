export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export function apiPath(path: string) {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}
