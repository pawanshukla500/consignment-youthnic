import React, { useEffect, useMemo, useState } from 'react'
import { Camera, CheckCircle2, Edit3, KeyRound, Loader2, LogOut, Mail, Save, ShieldCheck, X } from 'lucide-react'
import { usersAPI } from '../services/api'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { Skeleton, SkeletonText } from '../components/Skeleton'

const emptyPassword = { currentPassword: '', newPassword: '', confirmPassword: '' }

function initialsFrom(name, email) {
  const source = name || email || 'User'
  const parts = source.split(/[\s@.]+/).filter(Boolean)
  return parts.map((part) => part[0]).join('').toUpperCase().slice(0, 2) || 'U'
}

function formatDate(value) {
  if (!value) return 'Not available'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString('en-IN')
}

export default function Profile() {
  const { user, logout, updateUser, sendVerificationEmail, sessionTimeoutMinutes } = useAuth()
  const { addToast } = useToast()
  const [profile, setProfile] = useState(null)
  const [form, setForm] = useState({ name: '', avatarUrl: '', preferences: { theme: 'light', notifications: true, language: 'en' } })
  const [passwordForm, setPasswordForm] = useState(emptyPassword)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [loggingOutAll, setLoggingOutAll] = useState(false)
  const [sendingVerification, setSendingVerification] = useState(false)
  const [editMode, setEditMode] = useState(false)

  const initials = useMemo(() => initialsFrom(profile?.name || user?.name, profile?.email || user?.email), [profile, user])

  const loadProfile = async () => {
    setLoading(true)
    try {
      const res = await usersAPI.getProfile()
      const next = res.data?.user || user
      if (!next?.email) {
        addToast('Could not load full profile details.', 'error')
        return
      }
      setProfile(next)
      setForm({
        name: next.name || '',
        avatarUrl: next.avatarUrl || '',
        preferences: {
          theme: next.preferences?.theme || 'light',
          notifications: next.preferences?.notifications !== false,
          language: next.preferences?.language || 'en',
        },
      })
      updateUser({
        name: next.name,
        avatarUrl: next.avatarUrl,
        email: next.email,
        role: next.role,
        permissions: next.permissions,
      })
    } catch (error) {
      if (user?.email) {
        setProfile(user)
        setForm({
          name: user.name || '',
          avatarUrl: user.avatarUrl || '',
          preferences: {
            theme: user.preferences?.theme || 'light',
            notifications: user.preferences?.notifications !== false,
            language: user.preferences?.language || 'en',
          },
        })
      }
      addToast(error.response?.data?.error || 'Failed to load profile', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProfile() }, [])

  const cancelEdit = () => {
    setForm({
      name: profile?.name || '',
      avatarUrl: profile?.avatarUrl || '',
      preferences: {
        theme: profile?.preferences?.theme || 'light',
        notifications: profile?.preferences?.notifications !== false,
        language: profile?.preferences?.language || 'en',
      },
    })
    setEditMode(false)
  }

  const saveProfile = async (event) => {
    event.preventDefault()
    if (form.name.trim().length < 2) {
      addToast('Display name must be at least 2 characters.', 'error')
      return
    }
    if (form.avatarUrl && !/^https:\/\//i.test(form.avatarUrl.trim())) {
      addToast('Profile picture must be an HTTPS image URL.', 'error')
      return
    }

    setSaving(true)
    try {
      const res = await usersAPI.updateProfile({
        name: form.name.trim(),
        avatarUrl: form.avatarUrl.trim(),
        preferences: form.preferences,
      })
      const updated = res.data?.user
      if (!updated) {
        addToast('Profile saved but response was incomplete.', 'error')
        return
      }
      setProfile(updated)
      updateUser({ name: updated.name, avatarUrl: updated.avatarUrl })
      setEditMode(false)
      addToast('Profile saved', 'success')
    } catch (error) {
      addToast(error.response?.data?.error || 'Could not save profile', 'error')
    } finally {
      setSaving(false)
    }
  }

  const changePassword = async (event) => {
    event.preventDefault()
    if (passwordForm.newPassword.length < 8) {
      addToast('New password must be at least 8 characters.', 'error')
      return
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      addToast('Password confirmation does not match.', 'error')
      return
    }

    setChangingPassword(true)
    try {
      await usersAPI.changePassword(profile?.id || user?.id, {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      })
      setPasswordForm(emptyPassword)
      addToast('Password updated successfully', 'success')
    } catch (error) {
      addToast(error.response?.data?.error || 'Could not update password', 'error')
    } finally {
      setChangingPassword(false)
    }
  }

  const verifyEmail = async () => {
    setSendingVerification(true)
    try {
      await sendVerificationEmail()
      addToast('Verification email sent', 'success')
    } catch (error) {
      addToast(error.message || 'Could not send verification email', 'error')
    } finally {
      setSendingVerification(false)
    }
  }

  const logoutAllDevices = async () => {
    setLoggingOutAll(true)
    try {
      await usersAPI.logoutAll(profile?.id || user?.id)
      addToast('All sessions signed out. Please sign in again.', 'success')
      await logout()
    } catch (error) {
      addToast(error.response?.data?.error || 'Could not sign out all sessions', 'error')
      setLoggingOutAll(false)
    }
  }

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="card p-6"><Skeleton className="h-28 w-full rounded-2xl" /></div>
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
          <div className="card p-6"><SkeletonText lines={8} /></div>
          <div className="card p-6"><SkeletonText lines={6} /></div>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in space-y-6">
      <section className="relative overflow-hidden rounded-[28px] border border-primary-100 bg-gradient-to-br from-white via-primary-50/80 to-primary-50 p-6 shadow-sm">
        <div className="absolute -right-12 -top-16 h-52 w-52 rounded-full bg-primary-200/30 blur-3xl" />
        <div className="absolute bottom-0 right-32 h-36 w-36 rounded-full bg-amber-200/30 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative h-20 w-20 overflow-hidden rounded-3xl border border-white/80 bg-gradient-to-br from-primary-600 to-primary-400 shadow-lg flex items-center justify-center text-2xl font-black text-white">
              {profile?.avatarUrl ? (
                <img src={profile.avatarUrl} alt="Profile" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none' }} />
              ) : initials}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.26em] text-primary-700">Account settings</p>
              <h1 className="mt-1 text-3xl font-black tracking-[-0.04em] text-slate-950">{profile?.name || 'Your profile'}</h1>
              <p className="mt-1 text-sm text-slate-600">Manage your identity, preferences, and session security.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditMode(true)}
            className="btn btn-primary justify-center"
            disabled={editMode}
          >
            <Edit3 className="h-4 w-4" /> Edit Profile
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_390px] gap-6">
        <div className="space-y-6">
          <form onSubmit={saveProfile} className="card p-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Profile details</h2>
                <p className="text-sm text-slate-500">Keep the packing console identity clear across stations.</p>
              </div>
              {editMode && (
                <div className="flex gap-2">
                  <button type="button" onClick={cancelEdit} className="btn btn-secondary"><X className="h-4 w-4" /> Cancel</button>
                  <button type="submit" disabled={saving} className="btn btn-primary">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <label className="block">
                <span className="text-sm font-semibold text-slate-700">Display name</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  disabled={!editMode}
                  className="inp mt-2"
                  maxLength={80}
                  required
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-slate-700">Email address</span>
                <input value={profile?.email || ''} disabled className="inp mt-2 bg-slate-50 text-slate-500" />
              </label>
              <label className="block md:col-span-2">
                <span className="text-sm font-semibold text-slate-700">Profile picture URL</span>
                <div className="relative mt-2">
                  <Camera className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={form.avatarUrl}
                    onChange={(event) => setForm((prev) => ({ ...prev, avatarUrl: event.target.value }))}
                    disabled={!editMode}
                    placeholder="https://..."
                    className="inp pl-10"
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-400">Use a secure image URL. Leave blank to use initials.</p>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Theme</span>
                <select
                  value={form.preferences.theme}
                  onChange={(event) => setForm((prev) => ({ ...prev, preferences: { ...prev.preferences, theme: event.target.value } }))}
                  disabled={!editMode}
                  className="inp mt-2"
                >
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Language</span>
                <select
                  value={form.preferences.language}
                  onChange={(event) => setForm((prev) => ({ ...prev, preferences: { ...prev.preferences, language: event.target.value } }))}
                  disabled={!editMode}
                  className="inp mt-2"
                >
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 border border-slate-100 mt-5 md:mt-0 md:self-end">
                <span className="text-sm font-semibold text-slate-700">Notifications</span>
                <input
                  type="checkbox"
                  checked={form.preferences.notifications}
                  onChange={(event) => setForm((prev) => ({ ...prev, preferences: { ...prev.preferences, notifications: event.target.checked } }))}
                  disabled={!editMode}
                  className="h-4 w-4 accent-primary-600"
                />
              </label>
            </div>
          </form>

          <form onSubmit={changePassword} className="card p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-amber-50 p-3 text-amber-600"><KeyRound className="h-5 w-5" /></div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">Change password</h2>
                <p className="text-sm text-slate-500">Use at least 8 characters. Avoid sharing station passwords.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <input type="password" autoComplete="current-password" placeholder="Current password" className="inp" value={passwordForm.currentPassword} onChange={(e) => setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))} required />
              <input type="password" autoComplete="new-password" placeholder="New password" className="inp" value={passwordForm.newPassword} onChange={(e) => setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))} required minLength={8} />
              <input type="password" autoComplete="new-password" placeholder="Confirm new password" className="inp" value={passwordForm.confirmPassword} onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))} required minLength={8} />
            </div>
            <button type="submit" disabled={changingPassword} className="btn btn-primary">
              {changingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Update Password
            </button>
          </form>
        </div>

        <aside className="space-y-6">
          <div className="card p-6 space-y-4">
            <h2 className="text-lg font-bold text-slate-900">Account status</h2>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3">
                <span className="flex items-center gap-2 text-slate-600"><Mail className="h-4 w-4" /> Email</span>
                <span className={profile?.emailVerified ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>{profile?.emailVerified ? 'Verified' : 'Not verified'}</span>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3">
                <span className="flex items-center gap-2 text-slate-600"><ShieldCheck className="h-4 w-4" /> Role</span>
                <span className="font-semibold capitalize text-slate-800">{profile?.role || 'user'}</span>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <p className="text-slate-500 text-xs uppercase tracking-wider">Last login</p>
                <p className="mt-1 font-semibold text-slate-800">{formatDate(profile?.lastSignInAt || profile?.lastLoginAt)}</p>
              </div>
              <div className="rounded-xl bg-primary-50 px-4 py-3 border border-primary-100">
                <p className="text-primary-700 text-xs uppercase tracking-wider">Session timeout</p>
                <p className="mt-1 font-semibold text-primary-900">Auto logout after {sessionTimeoutMinutes} minutes of inactivity</p>
              </div>
            </div>
            {!profile?.emailVerified && (
              <button type="button" onClick={verifyEmail} disabled={sendingVerification} className="btn btn-secondary w-full justify-center">
                {sendingVerification ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Send Verification Email
              </button>
            )}
          </div>

          <div className="card p-6 space-y-4 border-rose-100 bg-rose-50/40">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white p-3 text-rose-600"><LogOut className="h-5 w-5" /></div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">Session control</h2>
                <p className="text-sm text-slate-600">Sign out this browser or revoke all active sessions for your account.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3">
              <button type="button" onClick={logout} className="btn btn-secondary justify-center">
                <LogOut className="h-4 w-4" /> Logout This Device
              </button>
              <button type="button" onClick={logoutAllDevices} disabled={loggingOutAll} className="btn justify-center border border-rose-200 bg-white text-rose-700 hover:bg-rose-50">
                {loggingOutAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                Logout All Devices
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
