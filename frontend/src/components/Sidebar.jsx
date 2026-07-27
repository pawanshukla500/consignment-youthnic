import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import {
  LayoutDashboard, Package, BarChart3, LogOut, ScanBarcode,
  Store, Users, ClipboardList, Truck, PanelLeftClose, PanelLeftOpen,
  Settings as SettingsIcon, ChevronRight, Shield, Factory
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import logo from '../assets/logo.png';

const Sidebar = ({ forceCollapsed = false }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true');

  const isCollapsed = forceCollapsed || collapsed;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebarCollapsed', String(next));
    window.dispatchEvent(new CustomEvent('sidebarToggle', { detail: { collapsed: next } }));
  };

  const hasPerm = (key) =>
    user?.role === 'admin' ||
    user?.role === 'organization_head' ||
    user?.permissions?.[key] === true;

  const isElevated = user?.role === 'admin' || user?.role === 'organization_head';

  const navGroups = [
    {
      label: 'Operations',
      items: [
        { path: '/',             icon: LayoutDashboard, label: 'Dashboard',       perm: null },
        { path: '/packing',      icon: ScanBarcode,     label: 'Packing Station', perm: 'packing' },
        { path: '/consignments', icon: Package,         label: 'Consignments',    perm: 'consignments' },
      ]
    },
    {
      label: 'Management',
      items: [
        { path: '/marketplaces',    icon: Store,          label: 'Marketplaces',    perm: 'marketplaces' },
        { path: '/docket-companies',icon: Truck,          label: 'Docket Companies',perm: null },
        { path: '/productivity',    icon: BarChart3,      label: 'Productivity',    perm: 'productivity' },
        { path: '/inventory-planning', icon: Factory,     label: 'Inventory Planning', perm: 'inventoryPlanning' },
      ]
    },
    {
      label: 'Admin',
      adminOnly: true,
      items: [
        { path: '/users',     icon: Users,        label: 'Users',      perm: 'users',     adminOnly: true },
        { path: '/audit-logs',icon: ClipboardList, label: 'Audit Logs', perm: 'auditLogs', adminOnly: false },
        { path: '/settings',  icon: SettingsIcon, label: 'Settings',   perm: null,        adminOnly: true },
      ]
    }
  ];

  const isActive = (path) =>
    path === '/'
      ? location.pathname === '/'
      : location.pathname === path || location.pathname.startsWith(path + '/');

  const initials = user?.name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U';

  return (
    <aside className={`flex flex-col fixed left-0 top-0 z-40 h-screen transition-all duration-300 ease-in-out
      ${isCollapsed ? 'w-[68px]' : 'w-[240px]'}
      bg-sidebar-bg border-r border-sidebar-border`}
      style={{ boxShadow: '1px 0 0 #E2E8F0' }}>

      {/* ── Logo ── */}
      <div className={`flex items-center border-b border-slate-200 flex-shrink-0
        ${isCollapsed ? 'justify-center py-3 px-2' : 'px-4 py-3 gap-2.5'}`}>
        <div className={`flex-shrink-0 rounded-lg overflow-hidden bg-slate-50 border border-slate-200 flex items-center justify-center
          ${isCollapsed ? 'w-8 h-8' : 'w-9 h-9'}`}>
          <img src={logo} alt="Youthnic" className="w-full h-full object-contain p-1" loading="lazy" />
        </div>
        {!isCollapsed && (
          <div className="min-w-0">
            <h1 className="text-xs font-bold text-slate-900 leading-tight truncate">Consignment Packing</h1>
            <p className="text-[9px] text-slate-500 leading-tight truncate">Youthnic operations</p>
          </div>
        )}
        {!isCollapsed && !forceCollapsed && (
          <button onClick={toggle} className="ml-auto p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ── Expand toggle when collapsed (desktop only) ── */}
      {isCollapsed && !forceCollapsed && (
        <button onClick={toggle} className="flex justify-center py-2 border-b border-slate-200 text-slate-400 hover:text-slate-700 transition-colors">
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      {/* ── Nav ── */}
      <nav className="flex-1 overflow-y-auto py-2 px-1.5">
        {navGroups.map(group => {
          const visibleItems = group.items.filter(item => {
            if (group.adminOnly && !isElevated) return false;
            if (item.adminOnly && !isElevated) return false;
            return !item.perm || hasPerm(item.perm);
          });
          if (visibleItems.length === 0) return null;

          return (
            <div key={group.label} className="mb-2">
              {!isCollapsed && (
                <p className="text-[9.5px] font-semibold uppercase tracking-[1.2px] text-slate-400 px-3 py-1.5 mb-0.5">
                  {group.label}
                </p>
              )}
              {visibleItems.map(item => {
                const Icon = item.icon;
                const active = isActive(item.path);
                return (
                  <NavLink key={item.path} to={item.path}
                    title={isCollapsed ? item.label : undefined}
            className={`flex items-center gap-2.5 rounded-lg transition-all duration-150 my-px
                      ${isCollapsed ? 'justify-center px-2 py-2' : 'px-2.5 py-2'}
                      ${active
                        ? 'nav-active text-white'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                      }`}>
                    <Icon className={`flex-shrink-0 ${isCollapsed ? 'w-4 h-4' : 'w-4 h-4'}`} />
                    {!isCollapsed && (
                      <span className="text-xs font-medium truncate">{item.label}</span>
                    )}
                    {!isCollapsed && active && (
                      <ChevronRight className="w-3 h-3 ml-auto opacity-60" />
                    )}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* ── User footer ── */}
      <div className={`border-t border-slate-200 flex-shrink-0 ${isCollapsed ? 'p-1.5' : 'p-2'}`}>
        {!isCollapsed && (
          <NavLink to="/profile" className="flex items-center gap-2 px-2.5 py-2 mb-1 rounded-lg bg-slate-50 border border-slate-200 transition hover:bg-slate-100">
            <div className="w-7 h-7 rounded-md bg-primary-600 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-slate-800 truncate">{user?.name || user?.email}</p>
              <div className="flex items-center gap-1">
                {isElevated && <Shield className="w-2.5 h-2.5 text-slate-500" />}
                <p className="text-[10px] text-slate-500 capitalize">{user?.role === 'organization_head' ? 'Org Head' : (user?.role || 'User')}</p>
              </div>
            </div>
          </NavLink>
        )}
        <button onClick={logout} title={isCollapsed ? 'Logout' : undefined}
          className={`flex items-center gap-3 w-full text-slate-400 hover:text-red-600 hover:bg-red-50
            rounded-xl transition-colors ${isCollapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2'}`}>
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!isCollapsed && <span className="text-[13px] font-medium">Logout</span>}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
