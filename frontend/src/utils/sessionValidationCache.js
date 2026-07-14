/**
 * Shared cache so PrivateRoute can skip a duplicate /auth/me round-trip
 * immediately after a successful login or session refresh.
 */
const VALIDATION_TTL_MS = 30_000

let cachedValidation = { result: null, at: 0 }

export function getSessionValidationCache(ttlMs = VALIDATION_TTL_MS) {
  const age = Date.now() - cachedValidation.at
  if (cachedValidation.result === null || age >= ttlMs) {
    return { hit: false, result: null, age }
  }
  return { hit: true, result: cachedValidation.result, age }
}

export function markSessionValidated(ok = true) {
  cachedValidation = { result: Boolean(ok), at: Date.now() }
}

export function clearSessionValidationCache() {
  cachedValidation = { result: null, at: 0 }
}

export { VALIDATION_TTL_MS }
