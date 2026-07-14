import React from 'react'

const VARIANTS = {
  default: 'tag-btn--default',
  primary: 'tag-btn--primary',
  success: 'tag-btn--success',
  warning: 'tag-btn--warning',
  danger: 'tag-btn--danger',
  info: 'tag-btn--info',
}

/**
 * Interactive filter / status tag with hover, active, and transition states.
 */
export default function TagButton({
  children,
  active = false,
  variant = 'default',
  onClick,
  disabled = false,
  count,
  className = '',
  type = 'button',
  ...rest
}) {
  const variantClass = VARIANTS[variant] || VARIANTS.default

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`tag-btn ${variantClass} ${active ? 'tag-btn--active' : ''} ${disabled ? 'tag-btn--disabled' : ''} ${className}`}
      {...rest}
    >
      <span className="tag-btn__label">{children}</span>
      {count !== undefined && count !== null && (
        <span className="tag-btn__count">{count}</span>
      )}
    </button>
  )
}

export function TagButtonGroup({ children, className = '' }) {
  return (
    <div className={`tag-btn-group ${className}`} role="group">
      {children}
    </div>
  )
}
