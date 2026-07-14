import React, { useState, useEffect, useCallback } from 'react'
import {
  Users as UsersIcon, Plus, Search, Trash2, Loader2,
  Edit2, X, Check, Shield, KeyRound, Eye, EyeOff,
} from 'lucide-react'
import { usersAPI } from '../services/api'
import { useToast } from '../context/ToastContext'
import Modal from '../components/Modal'
import ConfirmModal from '../components/ConfirmModal'

const PERMISSIONS = [
  { key: 'consignments', label: 'Consignments', desc: 'View and manage shipments' },
  { key: 'packing', label: 'Packing Station', desc: 'Scan and pack boxes' },
  { key: 'productivity', label: 'Productivity', desc: 'Reports and planning' },
  { key: 'marketplaces', label: 'Marketplaces', desc: 'Portal configuration' },
  { key: 'users', label: 'Users', desc: 'Team administration' },
  { key: 'auditLogs', label: 'Audit Logs', desc: 'System activity history' },
]

const DELETION_PERMISSIONS = [
  { key: 'deleteConsignments', label: 'Delete Consignments', desc: 'Permanently remove consignments and all related records' },
  { key: 'deleteVideos', label: 'Delete Videos', desc: 'Remove uploaded box videos from protected storage' },
  { key: 'editBoxQuantities', label: 'Edit Box Quantities', desc: 'Change SKU quantities box-wise with audit history' },
]

const ALL_PERMISSIONS = [...PERMISSIONS, ...DELETION_PERMISSIONS]

const DEFAULT_PERMISSIONS = {
  consignments: true,
  packing: true,
  productivity: false,
  marketplaces: false,
  users: false,
  auditLogs: false,
  deleteConsignments: false,
  deleteVideos: false,
  editBoxQuantities: false,
}

const EMAIL_ONLY_PERMISSIONS = {
  consignments: false,
  packing: false,
  productivity: false,
  marketplaces: false,
  users: false,
  auditLogs: false,
  deleteConsignments: false,
  deleteVideos: false,
  editBoxQuantities: false,
}

const emptyForm = () => ({
  name: '',
  email: '',
  password: '',
  role: 'user',
  permissions: { ...DEFAULT_PERMISSIONS },
})

const permissionsForRole = (role, current = {}) => {
  if (role === 'admin') {
    return Object.fromEntries(ALL_PERMISSIONS.map((p) => [p.key, true]))
  }
  if (role === 'organization_head') {
    return { ...EMAIL_ONLY_PERMISSIONS }
  }
  return { ...DEFAULT_PERMISSIONS, ...current }
}

function PermissionGrid({ permissions, onToggle, disabled }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {PERMISSIONS.map((p) => {
        const active = !!permissions[p.key]
        return (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(p.key)}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
              active
                ? 'border-primary-200 bg-primary-50/80'
                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              active ? 'border-primary-600 bg-primary-600 text-white' : 'border-slate-300 bg-white'
            }`}>
              {active && <Check className="h-2.5 w-2.5" />}
            </span>
            <span className="min-w-0">
              <span className={`block text-xs font-semibold ${active ? 'text-primary-800' : 'text-slate-800'}`}>
                {p.label}
              </span>
              <span className="block text-[10px] text-slate-500 leading-snug mt-0.5">{p.desc}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function DeletionPermissionGrid({ permissions, onToggle, disabled }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {DELETION_PERMISSIONS.map((p) => {
        const active = !!permissions[p.key]
        return (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(p.key)}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
              active
                ? 'border-red-200 bg-red-50/80'
                : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              active ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 bg-white'
            }`}>
              {active && <Check className="h-2.5 w-2.5" />}
            </span>
            <span className="min-w-0">
              <span className={`block text-xs font-semibold ${active ? 'text-red-800' : 'text-slate-800'}`}>
                {p.label}
              </span>
              <span className="block text-[10px] text-slate-500 leading-snug mt-0.5">{p.desc}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default function Users() {
  const { addToast } = useToast()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [selected, setSelected] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [editing, setEditing] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', email: '', role: 'user', permissions: {} })
  const [showChangePwd, setShowChangePwd] = useState(null)
  const [pwdForm, setPwdForm] = useState({ newPassword: '', confirmPassword: '' })
  const [form, setForm] = useState(emptyForm)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await usersAPI.getAll()
      let data = res.data.users || []
      if (search) {
        const s = search.toLowerCase()
        data = data.filter((u) => u.name?.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s))
      }
      setUsers(data)
    } catch {
      addToast('Failed to load users', 'error')
    } finally {
      setLoading(false)
    }
  }, [search, addToast])

  useEffect(() => { fetchData() }, [fetchData])

  const closeCreate = () => {
    if (isSubmitting) return
    setShowCreate(false)
    setForm(emptyForm())
    setShowPassword(false)
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!form.name?.trim() || !form.email?.trim() || !form.password) return
    setIsSubmitting(true)
    try {
      const res = await usersAPI.create(form)
      if (res?.data?.inviteSent) {
        addToast('User created — password setup email sent', 'success', 5000)
      } else {
        addToast(
          'User created. Invite email was not sent — ask them to use Forgot password, or resend the setup link.',
          'warning',
          7000
        )
      }
      closeCreate()
      fetchData()
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to create user', 'error')
    }
    setIsSubmitting(false)
  }

  const handleDelete = async () => {
    if (!selected) return
    setIsSubmitting(true)
    try {
      await usersAPI.delete(selected.id)
      addToast('User deleted', 'success')
      setShowDelete(false)
      fetchData()
    } catch {
      addToast('Failed to delete user', 'error')
    }
    setIsSubmitting(false)
  }

  const startEdit = (u) => {
    setEditing(u.id)
    setEditForm({
      name: u.name,
      email: u.email,
      role: u.role || 'user',
      permissions: permissionsForRole(u.role || 'user', u.permissions || {}),
    })
  }

  const saveEdit = async (id) => {
    setIsSubmitting(true)
    try {
      await usersAPI.update(id, editForm)
      addToast('User updated', 'success')
      setEditing(null)
      fetchData()
    } catch {
      addToast('Update failed', 'error')
    }
    setIsSubmitting(false)
  }

  const handleChangePassword = async (e) => {
    e.preventDefault()
    if (!showChangePwd) return
    if (pwdForm.newPassword !== pwdForm.confirmPassword) {
      addToast('Passwords do not match', 'error')
      return
    }
    if (pwdForm.newPassword.length < 4) {
      addToast('Password must be at least 4 characters', 'error')
      return
    }
    setIsSubmitting(true)
    try {
      await usersAPI.changePassword(showChangePwd.id, { newPassword: pwdForm.newPassword })
      addToast('Password changed', 'success')
      setShowChangePwd(null)
      setPwdForm({ newPassword: '', confirmPassword: '' })
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to change password', 'error')
    }
    setIsSubmitting(false)
  }

  const togglePerm = (permKey, isEdit = false) => {
    if (isEdit) {
      setEditForm((prev) => ({
        ...prev,
        permissions: { ...prev.permissions, [permKey]: !prev.permissions[permKey] },
      }))
    } else {
      setForm((prev) => ({
        ...prev,
        permissions: { ...prev.permissions, [permKey]: !prev.permissions[permKey] },
      }))
    }
  }

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="btn btn-primary text-xs sm:ml-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          New User
        </button>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-2.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="inp pl-8 py-1.5 text-xs"
          />
        </div>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full tbl">
            <thead>
              <tr>
                <th className="text-left">User</th>
                <th className="text-left">Role</th>
                <th className="text-left">Permissions</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="4" className="py-10 text-center">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary-600" />
                  </td>
                </tr>
              ) : users.length > 0 ? (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/80">
                    <td>
                      {editing === u.id ? (
                        <div className="space-y-1.5 min-w-[180px]">
                          <input
                            value={editForm.name}
                            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                            className="inp py-1.5 text-xs"
                            placeholder="Name"
                          />
                          <input
                            value={editForm.email}
                            onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                            className="inp py-1.5 text-xs"
                            placeholder="Email"
                          />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-md bg-slate-100 flex items-center justify-center shrink-0">
                            <UsersIcon className="w-3.5 h-3.5 text-slate-500" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-semibold text-slate-900 truncate">{u.name}</span>
                              {u.isDefault && (
                                <span className="text-[9px] bg-amber-100 text-amber-700 px-1 py-px rounded font-medium">DEFAULT</span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">{u.email}</div>
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {editing === u.id ? (
                        <select
                          value={editForm.role}
                          onChange={(e) => {
                            const role = e.target.value
                            setEditForm({
                              ...editForm,
                              role,
                              permissions: permissionsForRole(role, editForm.permissions),
                            })
                          }}
                          className="inp py-1.5 text-xs w-auto"
                        >
                          <option value="user">User</option>
                          <option value="organization_head">Organization Head</option>
                          <option value="admin">Admin</option>
                        </select>
                      ) : (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-semibold ${
                          u.role === 'admin' ? 'bg-amber-100 text-amber-800'
                            : u.role === 'organization_head' ? 'bg-indigo-100 text-indigo-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}>
                          <Shield className="w-2.5 h-2.5" />
                          {u.role === 'organization_head' ? 'Org Head' : u.role}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[280px]">
                      {editing === u.id ? (
                        <div className="space-y-2 min-w-[280px]">
                          <PermissionGrid
                            permissions={editForm.permissions}
                            onToggle={(key) => togglePerm(key, true)}
                            disabled={isSubmitting || editForm.role === 'admin' || editForm.role === 'organization_head'}
                          />
                          <DeletionPermissionGrid
                            permissions={editForm.permissions}
                            onToggle={(key) => togglePerm(key, true)}
                            disabled={isSubmitting || editForm.role === 'admin' || editForm.role === 'organization_head'}
                          />
                          {editForm.role === 'organization_head' && (
                            <p className="text-[10px] text-slate-500">Email reports only — module access is locked off.</p>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {ALL_PERMISSIONS.filter((p) => u.role === 'admin' || u.permissions?.[p.key]).map((p) => (
                            <span key={p.key} className={`text-[9px] font-medium px-1.5 py-px rounded ${
                              p.key.startsWith('delete') ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'
                            }`}>
                              {p.label}
                            </span>
                          ))}
                          {u.role !== 'admin' && !ALL_PERMISSIONS.some((p) => u.permissions?.[p.key]) && (
                            <span className="text-[10px] text-slate-400">None</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-0.5">
                        {editing === u.id ? (
                          <>
                            <button onClick={() => saveEdit(u.id)} disabled={isSubmitting} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded" title="Save">
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setEditing(null)} className="p-1 text-slate-400 hover:bg-slate-100 rounded" title="Cancel">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            {!u.isDefault && (
                              <button
                                onClick={() => { setShowChangePwd(u); setPwdForm({ newPassword: '', confirmPassword: '' }) }}
                                className="p-1 text-slate-400 hover:text-primary-600 hover:bg-slate-100 rounded"
                                title="Change password"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => startEdit(u)} className="p-1 text-slate-400 hover:text-primary-600 hover:bg-slate-100 rounded" title="Edit">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            {!u.isDefault && (
                              <button
                                onClick={() => { setSelected(u); setShowDelete(true) }}
                                className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="4" className="py-10 text-center text-slate-400 text-xs">
                    <UsersIcon className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    No users found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create user */}
      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="Add team member"
        subtitle="Create an account with role and module permissions"
        size="md"
        footer={(
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeCreate} className="btn btn-ghost text-xs" disabled={isSubmitting}>
              Cancel
            </button>
            <button
              type="submit"
              form="create-user-form"
              disabled={isSubmitting}
              className="btn btn-primary text-xs"
            >
              {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Create user
            </button>
          </div>
        )}
      >
        <form id="create-user-form" onSubmit={handleCreate} className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Full name *</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="inp py-1.5 text-xs"
                placeholder="Pawan Shukla"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Email *</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="inp py-1.5 text-xs"
                placeholder="name@company.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Password *</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="inp py-1.5 text-xs pr-9"
                  placeholder="Initial password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value
                  setForm({
                    ...form,
                    role,
                    permissions: permissionsForRole(role, form.permissions),
                  })
                }}
                className="inp py-1.5 text-xs"
              >
                <option value="user">User — module access only</option>
                <option value="organization_head">Organization Head — email reports only (Tue & Fri)</option>
                <option value="admin">Admin — full access</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-2">Module permissions</label>
            <PermissionGrid
              permissions={form.permissions}
              onToggle={(key) => togglePerm(key)}
              disabled={isSubmitting || form.role === 'admin' || form.role === 'organization_head'}
            />
            {form.role === 'admin' && (
              <p className="text-[10px] text-slate-500 mt-2">Admins have access to all modules.</p>
            )}
            {form.role === 'organization_head' && (
              <p className="text-[10px] text-slate-500 mt-2">
                Organization Heads receive Tuesday & Friday email summaries only. Module access stays locked off.
              </p>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-2">Deletion permissions</label>
            <DeletionPermissionGrid
              permissions={form.permissions}
              onToggle={(key) => togglePerm(key)}
              disabled={isSubmitting || form.role === 'admin' || form.role === 'organization_head'}
            />
            {form.role === 'organization_head' && (
              <p className="text-[10px] text-slate-500 mt-2">Deletion is locked off for Organization Heads.</p>
            )}
            {form.role !== 'admin' && form.role !== 'organization_head' && (
              <p className="text-[10px] text-slate-500 mt-2">These are off by default for non-admin users.</p>
            )}
          </div>
        </form>
      </Modal>

      <ConfirmModal
        show={showDelete && !!selected}
        title="Delete user"
        message={<>Remove <strong>{selected?.name}</strong> ({selected?.email})? This cannot be undone.</>}
        confirmLabel="Delete"
        variant="danger"
        loading={isSubmitting}
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
      />

      {/* Change password */}
      <Modal
        open={!!showChangePwd}
        onClose={() => !isSubmitting && setShowChangePwd(null)}
        title="Change password"
        subtitle={showChangePwd ? `${showChangePwd.name} · ${showChangePwd.email}` : ''}
        size="sm"
        footer={(
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowChangePwd(null)} className="btn btn-ghost text-xs" disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" form="change-pwd-form" disabled={isSubmitting} className="btn btn-primary text-xs">
              {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Update password
            </button>
          </div>
        )}
      >
        <form id="change-pwd-form" onSubmit={handleChangePassword} className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">New password</label>
            <input
              type={showPassword ? 'text' : 'password'}
              required
              minLength={4}
              value={pwdForm.newPassword}
              onChange={(e) => setPwdForm({ ...pwdForm, newPassword: e.target.value })}
              className="inp py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">Confirm password</label>
            <input
              type="password"
              required
              minLength={4}
              value={pwdForm.confirmPassword}
              onChange={(e) => setPwdForm({ ...pwdForm, confirmPassword: e.target.value })}
              className="inp py-1.5 text-xs"
            />
          </div>
        </form>
      </Modal>
    </div>
  )
}
