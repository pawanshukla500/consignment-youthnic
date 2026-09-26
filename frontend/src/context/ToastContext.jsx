import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { upsertToast } from '../utils/toastDedupe';

const ToastContext = createContext(null);

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const toastsRef = useRef([]);
  const timersRef = useRef(new Map());

  const syncToasts = (next) => {
    toastsRef.current = next;
    setToasts(next);
  };

  const removeToast = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
    syncToasts(toastsRef.current.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const { list, toast, merged } = upsertToast(toastsRef.current, { id: Date.now() + Math.random(), message, type, duration });
    if (merged) clearTimeout(timersRef.current.get(toast.id));
    timersRef.current.set(toast.id, setTimeout(() => removeToast(toast.id), toast.duration));
    syncToasts(list);
  }, [removeToast]);

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-emerald-500" />,
    error: <AlertCircle className="w-5 h-5 text-red-500" />,
    info: <Info className="w-5 h-5 text-blue-500" />,
    warning: <AlertCircle className="w-5 h-5 text-amber-500" />
  };

  const styles = {
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800'
  };

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 space-y-3 w-80">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`flex items-start gap-3 p-4 rounded-xl border shadow-lg animate-pop-in ${styles[toast.type]}`}
          >
            {icons[toast.type]}
            <p className="text-sm font-medium flex-1">
              {toast.message}
              {toast.count > 1 && <span className="ml-1.5 text-[10px] font-bold opacity-60">×{toast.count}</span>}
            </p>
            <button
              onClick={() => removeToast(toast.id)}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
};
