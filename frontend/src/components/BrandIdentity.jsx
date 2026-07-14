import React from 'react'

const SIZE_STYLES = {
  sm: {
    wrapper: 'gap-2',
    logo: 'w-8 h-8 rounded-lg',
    title: 'text-[11px] tracking-[0.08em]',
    subtitle: 'text-[9px]'
  },
  md: {
    wrapper: 'gap-3',
    logo: 'w-10 h-10 rounded-xl',
    title: 'text-[12px] tracking-[0.1em]',
    subtitle: 'text-[10px]'
  },
  lg: {
    wrapper: 'gap-3.5',
    logo: 'w-12 h-12 rounded-xl',
    title: 'text-sm tracking-[0.12em]',
    subtitle: 'text-[11px]'
  }
}

export default function BrandIdentity({
  size = 'md',
  mode = 'dark',
  className = '',
  showSubtitle = true
}) {
  const styles = SIZE_STYLES[size] || SIZE_STYLES.md
  const isDark = mode === 'dark'

  const titleColor = isDark ? 'text-white' : 'text-slate-900'
  const subtitleColor = isDark ? 'text-slate-300' : 'text-slate-500'
  const logoShell = isDark
    ? 'bg-slate-800 border border-slate-700'
    : 'bg-slate-900 shadow-lg shadow-slate-900/20'

  return (
    <div className={`flex items-center ${styles.wrapper} ${className}`}>
      <div className={`${styles.logo} ${logoShell} flex items-center justify-center overflow-hidden shrink-0`}>
        <img
          src="/brand-logo.png"
          alt="Consignment Packing logo"
          className="w-[72%] h-[72%] object-contain invert brightness-0"
          loading="lazy"
        />
      </div>
      <div className="leading-tight min-w-0">
        <h1 className={`${styles.title} ${titleColor} font-semibold uppercase whitespace-nowrap`}>
          Consignment Packing
        </h1>
        {showSubtitle && (
          <p className={`${styles.subtitle} ${subtitleColor} whitespace-nowrap`}>
            Powered b<span className={`align-top text-[9px] ${isDark ? 'text-white' : 'text-slate-900'}`}>y</span> VB Exports
          </p>
        )}
      </div>
    </div>
  )
}
