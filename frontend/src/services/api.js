import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json'
  }
});

const getSessionToken = () => sessionStorage.getItem('token') || localStorage.getItem('token');

const clearSessionTokens = () => {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('user');
  sessionStorage.removeItem('liveSyncToken');
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('supabaseRealtimeToken');
};

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = getSessionToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
  // Only force login when a request was sent with a token that the server rejected.
  // Bare 401s during session refresh (token briefly absent) must not eject the user.
    const hadAuthHeader = Boolean(error.config?.headers?.Authorization);
    if (error.response?.status === 401 && hadAuthHeader && !window.location.pathname.startsWith('/login')) {
      clearSessionTokens();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authAPI = {
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  logout: () => api.post('/auth/logout', {}),
  me: () => api.get('/auth/me')
};

// Consignments API
export const consignmentsAPI = {
  getAll: (params) => api.get('/consignments', { params }),
  getById: (id) => api.get(`/consignments/${id}`),
  getPackingReport: (id) => api.get(`/consignments/${id}/packing-report`),
  create: (data) => api.post('/consignments', data),
  update: (id, data) => api.put(`/consignments/${id}`, data),
  reassignId: (id, newConsignmentId) => api.post(`/consignments/${id}/reassign-id`, { newConsignmentId }),
  delete: (id, data = {}) => api.delete(`/consignments/${id}`, { data }),
  saveBox: (consignmentId, data) => api.post(`/consignments/${consignmentId}/boxes`, data),
  getLabels: (id) => api.get(`/consignments/${id}/labels`, { responseType: 'blob' }),
  archive: (id) => api.post(`/consignments/${id}/archive`),
  downloadOmsGuruTemplate: (id) => api.get(`/consignments/${id}/oms-guru/template`, { responseType: 'blob' }),
  importOmsGuruTemplate: (id, file) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post(`/consignments/${id}/oms-guru/import`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  getOmsGuruUploads: (id) => api.get(`/consignments/${id}/oms-guru/uploads`),
  downloadInwardTemplate: (id) => api.get(`/consignments/${id}/inward/template`, { responseType: 'blob' }),
  importInwardCsv: (id, file) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post(`/consignments/${id}/inward/import`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  getInwardUploads: (id) => api.get(`/consignments/${id}/inward/uploads`),
  editBoxQuantity: (id, boxNo, data) => api.post(`/consignments/${id}/boxes/${encodeURIComponent(boxNo)}/edit-quantity`, data),
};

export const workflowAPI = {
  getStages: () => api.get('/workflow/stages'),
  getAssignees: () => api.get('/workflow/assignees'),
  assignGroundTeam: (id, data) => api.post(`/workflow/${id}/assign-ground-team`, data),
  confirmStage: (id, data) => api.post(`/workflow/${id}/confirm-stage`, data),
  managementBoard: () => api.get('/workflow/management-board'),
  runTatCheck: () => api.post('/workflow/run-tat-check'),
};

// Uploads API
export const uploadsAPI = {
  getFiles: (consignmentId, type) => api.get(`/uploads/${consignmentId}`, { params: { type } }),
  getPlayUrl: (fileId, type = 'video') => api.get(`/uploads/play/${fileId}`, { params: { type } }),
  getStreamUrl: (fileId, type = 'video') => {
    const token = sessionStorage.getItem('token') || localStorage.getItem('token')
    if (!token) return null
    const base = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
    const params = new URLSearchParams({ type, token })
    return `${base}/api/uploads/stream/${encodeURIComponent(fileId)}?${params.toString()}`
  },
  getShareLink: (fileId, type = 'video') => api.get(`/uploads/share/${fileId}`, { params: { type } }),
  delete: (fileId, type, data = {}) => api.delete(`/uploads/${fileId}`, { params: { type }, data }),
  updateVideoStatus: (data) => api.post('/uploads/video-status', data),
  health: (consignmentId) => api.get(`/uploads/health/${consignmentId}`),
};

// Marketplaces API
export const marketplacesAPI = {
  getAll: () => api.get('/marketplaces'),
  create: (data) => api.post('/marketplaces', data),
  update: (id, data) => api.put(`/marketplaces/${id}`, data),
  delete: (id) => api.delete(`/marketplaces/${id}`)
};

// Docket Companies API
export const docketCompaniesAPI = {
  getAll: () => api.get('/docket-companies'),
  create: (data) => api.post('/docket-companies', data),
  update: (id, data) => api.put(`/docket-companies/${id}`, data),
  delete: (id) => api.delete(`/docket-companies/${id}`)
};

// Packing API
export const packingAPI = {
  load: (data) => api.post('/packing/load', data),
  increment: (data) => api.post('/packing/increment', data),
  decrement: (data) => api.post('/packing/decrement', data),
  checkDuplicateBox: (data) => api.post('/packing/check-duplicate-box', data),
  getBoxRemovalContext: (params) => api.get('/packing/box-removal-context', { params }),
  createQuantityRemoval: (data) => api.post('/packing/quantity-removal', data),
  attachQuantityRemovalVideo: (id, data) => api.post(`/packing/quantity-removal/${id}/attach-video`, data),
  completeQuantityRemoval: (id, data) => api.post(`/packing/quantity-removal/${id}/complete`, data || {}),
  saveBox: (data) => api.post('/packing/save-box', data),
  generateLabel: (data) => api.post('/packing/generate-label', data),
  finish: (data) => api.post('/packing/finish', data),
  resumeSession: () => api.get('/packing/resume-session'),
  syncStatus: (consignmentId) => api.get('/packing/sync-status', { params: consignmentId ? { consignment_id: consignmentId } : {} }),
  getProductivity: () => api.get('/packing/productivity'),
  uploadVideo: (data) => api.post('/packing/upload-video', data)
};

// Templates API
export const templatesAPI = {
  downloadConsignment: () => api.get('/templates/consignment', { responseType: 'blob' })
};

// Productivity API
export const productivityAPI = {
  log: (data) => api.post('/productivity', data),
  getStats: (params) => api.get('/productivity', { params }),
  getDashboardSummary: (params) => api.get('/productivity/dashboard-summary', { params }),
  getAuditLogs: (params) => api.get('/productivity/audit', { params }),
  getPlanning: () => api.get('/productivity/planning')
};

// Users API
export const usersAPI = {
  getAll: () => api.get('/users'),
  getProfile: () => api.get('/users/me'),
  updateProfile: (data) => api.put('/users/me', data),
  create: (data) => api.post('/users', data),
  update: (id, data) => api.put(`/users/${id}`, data),
  delete: (id) => api.delete(`/users/${id}`),
  changePassword: (id, data) => api.post(`/users/${id}/change-password`, data),
  logoutAll: (id) => api.post(`/users/${id}/logout-all`, {}),
  syncSecureAccess: () => api.post('/users/sync-secure-access', {}),
  secureAccessStatus: () => api.get('/users/secure-access-status')
};

// Audit Logs API
export const auditLogsAPI = {
  getAll: (params) => api.get('/audit-logs', { params }),
  export: (params) => api.get('/audit-logs/export', { params, responseType: 'blob' }),
  getMyActivity: () => api.get('/audit-logs/my-activity')
};

// Settings API
export const settingsAPI = {
  get: () => api.get('/settings'),
  update: (data) => api.put('/settings', data),
  getPackingConfig: () => api.get('/settings/packing'),
  runCleanup: () => api.post('/settings/cleanup'),
  getDbInfo: () => api.get('/settings/db-info'),
  getSystemHealth: () => api.get('/settings/system-health'),
  reconcile: () => api.post('/settings/reconcile'),
  importLegacyData: () => api.post('/settings/import-legacy-data'),
  getLiveLogs: () => api.get('/settings/live-logs')
};

// Email API (Mailgun — all from consignment@youthnic.shop)
export const emailAPI = {
  send:               (data) => api.post('/email/send', data),
  sendWelcome:        (data) => api.post('/email/welcome', data),
  notifyConsignment:  (data) => api.post('/email/notify-consignment', data),
  resolveAddress:     (name) => api.get('/email/resolve-address', { params: { name } })
};

export const inventoryPlanningAPI = {
  getReport: (refresh = false) => api.get('/inventory-planning/report', { params: refresh ? { refresh: 1 } : {} }),
  getSyncStatus: () => api.get('/inventory-planning/sync/status'),
  syncNow: () => api.post('/inventory-planning/sync'),
  getSettings: () => api.get('/inventory-planning/settings'),
  updateSettings: (data) => api.put('/inventory-planning/settings', data),
  downloadExcel: () => api.get('/inventory-planning/export.xlsx', { responseType: 'blob' }),
  sendNotify: () => api.post('/inventory-planning/notify'),
  emailHistory: () => api.get('/inventory-planning/email-history'),
  syncLogs: (limit) => api.get('/inventory-planning/sync/logs', { params: { limit } }),
};

export default api;
