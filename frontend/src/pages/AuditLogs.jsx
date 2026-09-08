import React, { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Search, Filter, Loader2, User, Calendar, RefreshCw, ShieldCheck, Download } from 'lucide-react';
import { auditLogsAPI, usersAPI } from '../services/api';
import { useToast } from '../context/ToastContext';

const ACTION_COLORS = {
  create: 'bg-emerald-100 text-emerald-700',
  update: 'bg-blue-100 text-blue-700',
  delete: 'bg-red-100 text-red-700',
  pack: 'bg-amber-100 text-amber-700',
  save_box: 'bg-amber-100 text-amber-700',
  finish: 'bg-slate-100 text-slate-700',
  login: 'bg-cyan-100 text-cyan-700',
  logout: 'bg-slate-100 text-slate-700',
  upload: 'bg-pink-100 text-pink-700',
  permission_change: 'bg-purple-100 text-purple-700',
  logout_all_devices: 'bg-slate-100 text-slate-700',
};

const ACTION_LABELS = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  pack: 'Packed SKU',
  save_box: 'Saved Box',
  finish: 'Finished Packing',
  login: 'Signed In',
  logout: 'Signed Out',
  upload: 'Uploaded',
  permission_change: 'Permissions Changed',
  logout_all_devices: 'Logged Out Devices',
  change_password: 'Changed Password',
  update_profile: 'Updated Profile',
};

const ENTITY_LABELS = {
  consignment: 'Consignment',
  user: 'User',
  video: 'Video',
  document: 'Document',
  box: 'Box',
  sku: 'SKU',
};

function labelFor(map, value) {
  if (!value) return '-';
  return map[value] || String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDetailValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function DetailList({ details }) {
  const entries = Object.entries(details || {}).filter(([, value]) => value !== undefined && value !== '');
  if (!entries.length) return <span className="text-slate-400">No extra details</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.slice(0, 4).map(([key, value]) => (
        <span key={key} className="inline-flex max-w-[280px] items-center gap-1 rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-600">
          <span className="font-semibold text-slate-500">{labelFor({}, key)}:</span>
          <span className="truncate">{formatDetailValue(value)}</span>
        </span>
      ))}
      {entries.length > 4 && <span className="text-[10px] text-slate-400">+{entries.length - 4} more</span>}
    </div>
  );
}

export default function AuditLogs() {
  const { addToast } = useToast();
  const [logs, setLogs] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [downloading, setDownloading] = useState(false)
  const [retentionDays, setRetentionDays] = useState(400)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [logsRes, usersRes] = await Promise.all([
        auditLogsAPI.getAll({ startDate, endDate, limit: 1000 }),
        usersAPI.getAll().catch(() => ({ data: { users: [] } }))
      ]);
      setLogs(logsRes.data.logs || []);
      setRetentionDays(logsRes.data.retentionDays || 400);
      setUsers(usersRes.data.users || []);
    } catch (error) { addToast('Failed to load logs', 'error'); }
    finally { setLoading(false); }
  }, [addToast, startDate, endDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const getUserName = (id) => users.find(u => u.id === id)?.name || id;

  let filtered = [...logs];
  if (filterUser) filtered = filtered.filter(l => l.userId === filterUser);
  if (filterAction) filtered = filtered.filter(l => l.action === filterAction);
  if (startDate) filtered = filtered.filter(l => new Date(l.timestamp).getTime() >= new Date(startDate).getTime());
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    filtered = filtered.filter(l => new Date(l.timestamp).getTime() <= end.getTime());
  }
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(l =>
      l.action?.toLowerCase().includes(s) ||
      l.entityType?.toLowerCase().includes(s) ||
      l.summary?.toLowerCase().includes(s) ||
      getUserName(l.userId)?.toLowerCase().includes(s)
    );
  }


  const downloadLogs = async () => {
    try {
      setDownloading(true)
      const res = await auditLogsAPI.export({ startDate, endDate, userId: filterUser, action: filterAction })
      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const suffix = [startDate, endDate].filter(Boolean).join('_to_') || 'all-dates'
      link.href = url
      link.download = `audit-logs-${suffix}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      addToast('Audit logs downloaded', 'success')
    } catch (error) {
      addToast('Failed to download audit logs', 'error')
    } finally {
      setDownloading(false)
    }
  }

  const stats = {
    total: logs.length,
    deletions: logs.filter((l) => l.action === 'delete').length,
    signIns: logs.filter((l) => l.action === 'login').length,
    permissionChanges: logs.filter((l) => l.action === 'permission_change').length,
  };

  return (
    <div className="animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Audit Logs</h1>
          <p className="text-slate-500 mt-1">Protected audit history shown in clear, plain English. Cleanup keeps the latest {retentionDays}+ days</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={downloadLogs} className="btn btn-primary text-xs" disabled={downloading}>
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Download CSV
          </button>
        <button type="button" onClick={fetchData} className="btn btn-ghost text-xs" disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          ['Events', stats.total],
          ['Deletes', stats.deletions],
          ['Sign-ins', stats.signIns],
          ['Permission edits', stats.permissionChanges],
        ].map(([label, value]) => (
          <div key={label} className="bg-white rounded-xl border border-slate-100 px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500">{label}</p>
              <ShieldCheck className="w-4 h-4 text-slate-300" />
            </div>
            <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 mb-6">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search actions, entities..." className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="px-3 py-2.5 border border-slate-200 rounded-lg outline-none bg-white text-sm" title="From date" />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="px-3 py-2.5 border border-slate-200 rounded-lg outline-none bg-white text-sm" title="To date" />
            <Filter className="w-5 h-5 text-slate-400" />
            <select value={filterUser} onChange={e => setFilterUser(e.target.value)} className="px-4 py-2.5 border border-slate-200 rounded-lg outline-none bg-white"><option value="">All Users</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <select value={filterAction} onChange={e => setFilterAction(e.target.value)} className="px-4 py-2.5 border border-slate-200 rounded-lg outline-none bg-white"><option value="">All Actions</option>
              <option value="create">Create</option><option value="update">Update</option><option value="delete">Delete</option>
              <option value="pack">Pack</option><option value="save_box">Save Box</option><option value="finish">Finish</option>
              <option value="login">Login</option><option value="logout">Logout</option><option value="upload">Upload</option>
              <option value="permission_change">Permission Change</option>
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50"><tr>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Time</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">User</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Action</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Entity</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Clear Activity Summary</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? <tr><td colSpan="5" className="py-12 text-center"><Loader2 className="w-8 h-8 animate-spin mx-auto text-primary-600" /></td></tr>
              : filtered.length > 0 ? filtered.map((log, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-6 py-4 text-xs text-slate-500 whitespace-nowrap"><div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(log.timestamp).toLocaleString()}</div></td>
                  <td className="px-6 py-4"><div className="flex items-center gap-2"><User className="w-3.5 h-3.5 text-slate-400" /><span className="text-sm font-medium text-slate-900">{getUserName(log.userId)}</span></div></td>
                  <td className="px-6 py-4"><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${ACTION_COLORS[log.action] || 'bg-slate-100 text-slate-700'}`}>{labelFor(ACTION_LABELS, log.action)}</span></td>
                  <td className="px-6 py-4 text-sm text-slate-600">{labelFor(ENTITY_LABELS, log.entityType)} <span className="text-xs text-slate-400 font-mono">{log.entityId?.slice(0, 16)}{log.entityId?.length > 16 ? '...' : ''}</span></td>
                  <td className="px-6 py-4 text-sm text-slate-600 max-w-[620px]"><p className="leading-relaxed">{log.summary || <DetailList details={log.details} />}</p></td>
                </tr>
              )) : <tr><td colSpan="5" className="py-12 text-center text-slate-400"><ClipboardList className="w-12 h-12 mx-auto mb-3 text-slate-300" /><p>No logs found</p></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
