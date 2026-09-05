class BackendError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500 || code === 'PACKING_LEASE_NOT_ACTIVE';
  }
}

class BackendClient {
  constructor({ baseUrl, logger }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.logger = logger;
    this.token = null;
  }

  setToken(token) { this.token = token ? String(token) : null; }

  async request(path, options = {}) {
    if (!this.baseUrl) throw new BackendError('Backend URL is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
    const headers = { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...options, headers, signal: controller.signal });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
      if (!response.ok) {
        throw new BackendError(body?.error || `Backend request failed (${response.status})`, {
          status: response.status,
          code: body?.code || null,
          body,
        });
      }
      return body;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      const wrapped = new BackendError(error.name === 'AbortError' ? 'Backend request timed out' : error.message);
      wrapped.cause = error;
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
  }

  json(path, method, body, options = {}) {
    return this.request(path, { ...options, method, body: JSON.stringify(body) });
  }

  async checkCompatibility() {
    let status;
    // POST is still read-only here; old SPA servers can hang on unknown GETs.
    try { status = await this.request('/desktop/status', { method: 'POST', timeoutMs: 10000 }); }
    catch (error) {
      if (error.status === 404 || error.code === 'DESKTOP_SCHEMA_REQUIRED') {
        throw new BackendError('The application server needs the desktop packing update and database setup. Ask your administrator to deploy the matching backend, then retry. Your local work is preserved.', { status: 409, code: 'DESKTOP_SERVER_UPGRADE_REQUIRED' });
      }
      throw error;
    }
    if (status?.ready !== true || status.protocolVersion !== 1 || status.capabilities?.stationLeases !== true || status.capabilities?.boxIdempotency !== true || status.capabilities?.multipartRecovery !== true) {
      throw new BackendError('The application server is not compatible with this desktop version. Deploy the matching backend and retry.', { status: 409, code: 'DESKTOP_SERVER_UPGRADE_REQUIRED' });
    }
    return status;
  }

  async claimLease(payload) {
    await this.checkCompatibility();
    return this.json('/packing/lease/claim', 'POST', payload);
  }
  renewLease(payload) { return this.json('/packing/lease/renew', 'POST', payload); }
  releaseLease(payload) { return this.json('/packing/lease/release', 'POST', payload); }
  saveBox(payload) { return this.json('/packing/save-box', 'POST', payload); }
  generateUploadUrl(payload) { return this.json('/uploads/generate-signed-url', 'POST', payload); }
  createMultipart(payload) { return this.json('/uploads/multipart/create', 'POST', payload); }
  signParts(payload) { return this.json('/uploads/multipart/sign-parts', 'POST', payload); }
  listParts(payload) { return this.json('/uploads/multipart/list-parts', 'POST', payload); }
  headObject(payload) { return this.json('/uploads/object-head', 'POST', payload); }
  completeMultipart(payload) { return this.json('/uploads/multipart/complete', 'POST', payload); }
  saveMetadata(payload) { return this.json('/uploads/metadata', 'POST', payload); }
}

module.exports = { BackendClient, BackendError };
