import React from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react';

/**
 * Premium confirmation modal — replaces all native confirm() dialogs.
 *
 * Props:
 *   show        - boolean
 *   title       - string
 *   message     - string | ReactNode
 *   confirmLabel - string  (default "Delete")
 *   cancelLabel  - string  (default "Cancel")
 *   variant      - "danger" | "warning" | "info"  (default "danger")
 *   loading      - boolean
 *   onConfirm   - () => void
 *   onCancel    - () => void
 */
export default function ConfirmModal({
  show, title, message,
  confirmLabel = 'Delete', cancelLabel = 'Cancel',
  variant = 'danger', loading = false,
  onConfirm, onCancel
}) {
  if (!show) return null;

  const colors = {
    danger:  { bg: 'bg-red-100',    icon: 'text-red-600',    btn: 'bg-red-600 hover:bg-red-700',    shadow: 'shadow-red-100' },
    warning: { bg: 'bg-amber-100',  icon: 'text-amber-600',  btn: 'bg-amber-500 hover:bg-amber-600', shadow: 'shadow-amber-100' },
    info:    { bg: 'bg-primary-100', icon: 'text-primary-600', btn: 'bg-primary-600 hover:bg-primary-700', shadow: 'shadow-primary-100' },
  }[variant] || colors.danger;

  const Icon = variant === 'danger' ? Trash2 : AlertTriangle;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(61, 40, 48, 0.45)', backdropFilter: 'blur(6px)' }}>
      <div className="bg-white rounded-2xl shadow-2xl border border-primary-100/60 max-w-[420px] w-full animate-pop-in overflow-hidden">
        {/* Top accent bar */}
        <div className={`h-1 w-full ${variant === 'danger' ? 'bg-red-500' : variant === 'warning' ? 'bg-amber-400' : 'bg-primary-500'}`} />

        <div className="p-6">
          {/* Icon + Title */}
          <div className="flex items-start gap-4 mb-4">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${colors.bg}`}>
              <Icon className={`w-5 h-5 ${colors.icon}`} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-[15px] font-bold text-slate-900 leading-tight">{title}</h3>
              <div className="text-sm text-slate-500 mt-1 leading-relaxed">{message}</div>
            </div>
          </div>

          {/* Warning note */}
          {variant === 'danger' && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-xl px-3 py-2 mb-5">
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
              <p className="text-[11px] text-red-600 font-medium">This action cannot be undone.</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 justify-end">
            <button onClick={onCancel} disabled={loading}
              className="px-4 py-2 border border-slate-200 text-slate-700 rounded-xl text-sm font-medium hover:bg-slate-50 disabled:opacity-50 transition-colors">
              {cancelLabel}
            </button>
            <button onClick={onConfirm} disabled={loading}
              className={`flex items-center gap-2 px-5 py-2 text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-60 ${colors.btn} shadow-sm`}>
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {!loading && variant === 'danger' && <Trash2 className="w-3.5 h-3.5" />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
