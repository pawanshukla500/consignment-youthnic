import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * Accessible modal — portals to document.body, locks scroll, handles Escape.
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'lg',
  closeOnBackdrop = true,
}) {
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const maxW = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-3xl',
    xl: 'max-w-5xl',
  }[size] || 'max-w-3xl'

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
      style={{ background: 'rgba(15, 23, 42, 0.35)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose?.()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={panelRef}
        className={`bg-white rounded-2xl shadow-2xl border border-slate-200/80 w-full ${maxW} max-h-[min(90vh,900px)] flex flex-col animate-pop-in overflow-hidden mt-6 sm:mt-12 mb-6`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Top brand accent bar */}
        <div className="h-1 w-full bg-gradient-to-r from-primary-500 via-primary-600 to-primary-700 flex-shrink-0" />

        {(title || onClose) && (
          <div className="px-6 py-4.5 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-4 flex-shrink-0">
            <div className="min-w-0">
              {title && (
                <h2 id="modal-title" className="font-display text-sm sm:text-base font-extrabold text-slate-900 leading-tight flex items-center gap-2">
                  <span className="w-1 h-4.5 rounded bg-primary-600 shrink-0" />
                  {title}
                </h2>
              )}
              {subtitle && <p className="text-[11px] text-slate-500 mt-1 font-medium leading-normal">{subtitle}</p>}
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-all flex-shrink-0 border border-slate-200/60 bg-white shadow-sm"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 bg-white">
          {children}
        </div>

        {footer && (
          <div className="px-6 py-4 border-t border-slate-100 flex-shrink-0 bg-slate-50/50">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
