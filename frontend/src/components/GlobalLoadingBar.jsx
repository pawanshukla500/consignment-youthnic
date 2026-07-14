import React from 'react'

export default function GlobalLoadingBar({ loading }) {
  if (!loading) return null
  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-[3px] overflow-hidden pointer-events-none" role="progressbar" aria-hidden="true">
      <div
        className="h-full w-full origin-left animate-loading-bar"
        style={{ background: 'linear-gradient(90deg, #E11D48, #F43F5E, #FDA4AF)' }}
      />
    </div>
  )
}
