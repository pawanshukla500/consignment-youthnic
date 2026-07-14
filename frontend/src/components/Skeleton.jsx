import React from 'react'

export function Skeleton({ className = '', style }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  )
}

export function DashboardSkeleton() {
  return (
    <div className="animate-fade-in space-y-8" aria-busy="true" aria-label="Loading dashboard">
      <div>
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-6">
            <Skeleton className="h-4 w-24 mb-4" />
            <Skeleton className="h-10 w-16 mb-2" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-6"><Skeleton className="h-40 w-full rounded-xl" /></div>
        <div className="card p-6"><Skeleton className="h-40 w-full rounded-xl" /></div>
      </div>
      <div className="card p-6">
        <Skeleton className="h-5 w-40 mb-6" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function ProductivitySkeleton() {
  return (
    <div className="animate-fade-in space-y-6" aria-busy="true" aria-label="Loading productivity reports">
      <div>
        <Skeleton className="h-8 w-64 mb-2" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-12 w-full max-w-3xl rounded-xl" />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-100 p-4">
            <Skeleton className="h-8 w-12 mb-2" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-100 p-4">
            <Skeleton className="h-8 w-8 rounded-lg mb-2" />
            <Skeleton className="h-7 w-10 mb-1" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <TableSkeleton rows={8} />
    </div>
  )
}

export function TableSkeleton({ rows = 6 }) {
  return (
    <div className="card overflow-hidden p-4 space-y-3" aria-busy="true">
      <Skeleton className="h-10 w-full rounded-lg" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full rounded-lg" style={{ opacity: 1 - i * 0.08 }} />
      ))}
    </div>
  )
}

export default function PageSpinner({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 animate-fade-in">
      <div className="page-spinner" role="status" aria-label={label}>
        <div className="page-spinner__ring" />
        <div className="page-spinner__ring page-spinner__ring--delay" />
      </div>
      <p className="text-sm font-medium text-slate-500">{label}</p>
    </div>
  )
}
