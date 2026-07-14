import React from 'react'

export default function PageTransition({ children, className = '' }) {
  return (
    <div className={`page-enter ${className}`}>
      {children}
    </div>
  )
}
