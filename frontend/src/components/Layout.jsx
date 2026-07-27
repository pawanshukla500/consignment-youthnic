import React, { useState, useEffect } from 'react';
import { Outlet, useLocation, Link } from 'react-router';
import Sidebar from './Sidebar';
import GlobalLoadingBar from './GlobalLoadingBar';
import PageTransition from './PageTransition';
import { HelpCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const TITLES = {
  '/':              { title: 'Dashboard',        sub: 'Overview of your operations' },
  '/packing':       { title: 'Packing Station',   sub: 'CCTV-enabled scan workflow' },
  '/consignments':  { title: 'Consignments',      sub: 'Manage shipments and SKUs' },
  '/marketplaces':  { title: 'Marketplaces',      sub: 'Portals and warehouse config' },
  '/docket-companies': { title: 'Docket Companies', sub: 'Courier & logistics partners' },
  '/productivity':  { title: 'Productivity',      sub: 'Reports and audit trail' },
  '/users':         { title: 'Users',             sub: 'Team access management' },
  '/audit-logs':    { title: 'Audit Logs',        sub: 'Full system activity log' },
  '/settings':      { title: 'Settings',          sub: 'System configuration' },
  '/profile':       { title: 'Profile',           sub: 'Account and preferences' },
};

const Layout = () => {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true');
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const location = useLocation();
  const { user } = useAuth();
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    const handler = (e) => setCollapsed(e.detail.collapsed);
    window.addEventListener('sidebarToggle', handler);
    return () => window.removeEventListener('sidebarToggle', handler);
  }, []);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setNavigating(true);
    const t = setTimeout(() => setNavigating(false), 300);
    return () => clearTimeout(t);
  }, [location.pathname]);

  const effectiveCollapsed = collapsed || isMobile;
  const mainOffset = effectiveCollapsed ? 'ml-[68px]' : 'ml-[240px]';

  // Get page title (handle /consignments/:id)
  const key = Object.keys(TITLES).find(k => k !== '/' && location.pathname.startsWith(k)) || '/';
  const page = TITLES[key] || TITLES['/'];
  const isDetail = location.pathname.match(/\/consignments\/.+/);

  return (
    <div className="min-h-screen bg-surface">
      <GlobalLoadingBar loading={navigating} />
      <Sidebar forceCollapsed={isMobile} />

      <div className={`flex flex-col min-h-screen min-w-0 transition-all duration-300 ease-out ${mainOffset}`}>
        <header className="sticky top-0 z-30 glass px-3 sm:px-5 py-2 flex items-center justify-between">
          <div className="animate-fade-in min-w-0">
            <h2 className="font-display text-[13px] sm:text-sm font-bold text-slate-900 leading-tight truncate">{isDetail ? 'Consignment Detail' : page.title}</h2>
            <p className="text-[10px] text-slate-500 leading-tight truncate">{isDetail ? 'Full shipment breakdown' : page.sub}</p>
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
            <Link to="/contact" className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors" title="Help & Support">
              <HelpCircle className="w-4 h-4" />
            </Link>
            <div className="hidden sm:block w-px h-4 bg-slate-200" />
            <Link to="/profile" className="flex items-center gap-2 px-2 py-1 bg-white border border-slate-200 rounded-lg transition hover:border-slate-300 hover:bg-slate-50" title="Open profile settings">
              <div className="w-5 h-5 rounded-md bg-primary-600 flex items-center justify-center text-white text-[8px] font-bold">
                {user?.name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U'}
              </div>
              <div className="hidden sm:block">
                <p className="text-[11px] font-semibold text-slate-700 leading-tight">{user?.name?.split(' ')[0] || 'User'}</p>
                <p className="text-[9px] text-slate-400 capitalize leading-tight">{user?.role}</p>
              </div>
            </Link>
          </div>
        </header>

        <main className="flex-1 p-3 sm:p-4 min-w-0 overflow-x-hidden">
          <div className="max-w-[1400px] mx-auto min-w-0">
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </div>
        </main>

        <footer className="border-t border-slate-200 px-3 sm:px-5 py-2 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-[10px] text-slate-500">
          <span className="text-center sm:text-left">© 2025 Youthnic Exports Pvt. Ltd.</span>
          <div className="flex items-center gap-3">
            <Link to="/terms"   className="hover:text-slate-800 transition-colors">Terms</Link>
            <Link to="/privacy" className="hover:text-slate-800 transition-colors">Privacy</Link>
            <Link to="/contact" className="hover:text-slate-800 transition-colors">Contact</Link>
            <Link to="/copyright" className="hover:text-slate-800 transition-colors">Copyright</Link>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default Layout;
