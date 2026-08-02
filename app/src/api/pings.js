import { apiFetch } from './client'

/**
 * @returns {Promise<Array<{id: number, tenantId: number, label: string, createdAt: string|null}>>}
 */
export async function listPings() {
  const payload = await apiFetch('/api/v1/tasker/pings')
  return payload.data
}

/**
 * @param {string} label
 * @returns {Promise<{id: number, tenantId: number, label: string, createdAt: string|null}>}
 */
export async function createPing(label) {
  const payload = await apiFetch('/api/v1/tasker/pings', {
    method: 'POST',
    body: { label },
  })
  return payload.data
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function login(email, password) {
  return apiFetch('/api/v1/login', {
    method: 'POST',
    body: { email, password },
  })
}
