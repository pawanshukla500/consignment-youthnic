import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, ArrowRight, Mail, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import logo from '../assets/logo.png';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [socialLoading, setSocialLoading] = useState('');
  const [shakeKey, setShakeKey] = useState(0);
  const { login, loginWithGoogle, loginWithMicrosoft, sendPasswordReset } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const triggerError = (message) => {
    setError(message);
    setShakeKey((v) => v + 1);
    addToast(message, 'error');
  };

  const handleSocialLogin = async (providerFn, label) => {
    setError('');
    setSocialLoading(label);
    try {
      await providerFn();
      addToast('Signed in successfully.', 'success');
      navigate('/');
    } catch (err) {
      const msg = err.response?.data?.error || err.message || `Could not sign in with ${label}.`;
      if (!msg.includes('cancelled')) triggerError(msg);
    } finally {
      setSocialLoading('');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      addToast('Signed in successfully.', 'success');
      navigate('/');
    } catch (err) {
      let msg = err.response?.data?.error || err.message || 'Invalid credentials. Please try again.';
      if (msg.includes('status code 502')) {
        msg = 'Application service is not reachable. Please try again shortly.';
      }
      triggerError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async () => {
    if (!email) {
      triggerError('Enter your email first, then request a reset link.');
      return;
    }
    setSendingReset(true);
    try {
      const result = await sendPasswordReset(email);
      addToast(result?.message || 'Password reset email sent.', 'success');
      setError('');
    } catch (err) {
      const code = err?.code || '';
      const msg =
        code === 'auth/user-not-found'
          ? 'No account found with that email.'
          : code === 'auth/invalid-email'
            ? 'That email address looks invalid.'
            : err?.response?.data?.error || err?.message || 'Could not send reset email.';
      triggerError(msg);
    } finally {
      setSendingReset(false);
    }
  };

  return (
    <main className="login-page relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-primary-200/20 blur-[120px] pointer-events-none z-0" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40vw] h-[40vw] rounded-full bg-primary-300/10 blur-[100px] pointer-events-none z-0" />

      {/* Brand panel — desktop */}
      <aside className="login-brand-panel relative z-10" aria-hidden="false">
        <div>
          <div className="flex items-center gap-3 mb-12">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15 shadow-inner">
              <img src={logo} alt="" className="h-6 w-6 object-contain brightness-0 invert" loading="eager" />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Youthnic Operations</p>
              <p className="font-display text-sm font-extrabold text-white">Packing Station</p>
            </div>
          </div>
          
          <div className="space-y-6">
            <h1 className="font-display text-[2rem] font-extrabold leading-snug tracking-tight text-white">
              Warehouse packing,<br />
              <span className="bg-gradient-to-r from-rose-200 to-pink-100 bg-clip-text text-transparent font-black">tracked end to end.</span>
            </h1>
            <p className="max-w-sm text-[13px] leading-relaxed text-slate-400 font-medium">
              Barcode scanning, live station sync, and shipment evidence — built for high-volume export operations.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Live Status Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10.5px] font-bold tracking-wide">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            All Systems Operational
          </div>
          <p className="text-[11px] text-slate-500 font-medium">© 2026 Youthnic Exports Pvt. Ltd.</p>
        </div>
      </aside>

      {/* Sign-in */}
      <div className="login-form-panel relative z-10">
        <div className="mb-8 flex items-center gap-2.5 lg:hidden">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-600 shadow-md">
            <img src={logo} alt="" className="h-6 w-6 object-contain brightness-0 invert" />
          </div>
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-400">Youthnic</p>
            <p className="font-display text-xs font-extrabold text-slate-900">Packing Station</p>
          </div>
        </div>

        <div key={shakeKey} className={`login-card relative overflow-hidden ${error ? 'login-card-shake' : ''}`}>
          {/* Decorative glowing card accent */}
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-primary-500 to-primary-700" />
          
          <div className="mb-6 pt-2">
            <h2 className="font-display text-xl font-extrabold text-slate-900 tracking-tight">Sign in</h2>
            <p className="mt-1.5 text-[12px] font-medium text-slate-500">Enter your company credentials to continue.</p>
          </div>

          {error && (
            <div className="mb-5 rounded-xl border border-red-200 bg-red-50/70 p-3.5 text-[12px] font-medium text-red-700 leading-relaxed animate-fade-in">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5" autoComplete="on">
            <div>
              <label htmlFor="email" className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Email Address
              </label>
              <div className="relative group">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4.5 w-4.5 text-slate-400 group-focus-within:text-primary-500 transition-colors pointer-events-none" />
                <input
                  id="email"
                  type="email"
                  name="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck="false"
                  placeholder="you@company.com"
                  className="login-input login-input-with-icon shadow-sm font-medium"
                />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="password" className="block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Password
                </label>
                <button
                  type="button"
                  onClick={handleForgot}
                  disabled={sendingReset}
                  className="text-[11px] font-bold text-primary-600 hover:text-primary-700 disabled:opacity-60 transition-colors"
                >
                  {sendingReset ? 'Sending…' : 'Forgot password?'}
                </button>
              </div>
              <div className="relative group">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4.5 w-4.5 text-slate-400 group-focus-within:text-primary-500 transition-colors pointer-events-none" />
                <input
                  id="password"
                  type={showPwd ? 'text' : 'password'}
                  name="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className="login-input login-input-with-icon login-input-with-right-icon shadow-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(!showPwd)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label={showPwd ? 'Hide password' : 'Show password'}
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading || socialLoading} className="login-btn mt-2 shadow-md hover:shadow-lg transition-all font-bold">
              {loading ? (
                <>
                  <span className="login-btn-spinner" aria-hidden="true" />
                  <span>Signing in…</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight className="h-4.5 w-4.5 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Or continue with</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              disabled={loading || socialLoading}
              onClick={() => handleSocialLogin(loginWithGoogle, 'Google')}
              className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[13px] font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
            >
              {socialLoading === 'Google' ? (
                <span className="login-btn-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path fill="#EA4335" d="M12 11.8v3.6h5.1c-.2 1.2-1.6 3.5-5.1 3.5-3.1 0-5.6-2.5-5.6-5.6S8.9 7.7 12 7.7c1.8 0 3 .8 3.7 1.5l2.5-2.4C16.9 5.4 14.6 4.5 12 4.5 7.3 4.5 3.5 8.3 3.5 13s3.8 8.5 8.5 8.5c4.9 0 8.1-3.4 8.1-8.2 0-.6-.1-1-.2-1.5H12z" />
                </svg>
              )}
              <span>Google</span>
            </button>
            <button
              type="button"
              disabled={loading || socialLoading}
              onClick={() => handleSocialLogin(loginWithMicrosoft, 'Microsoft')}
              className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[13px] font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
            >
              {socialLoading === 'Microsoft' ? (
                <span className="login-btn-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path fill="#F25022" d="M3 3h9v9H3z" />
                  <path fill="#7FBA00" d="M12 3h9v9h-9z" />
                  <path fill="#00A4EF" d="M3 12h9v9H3z" />
                  <path fill="#FFB900" d="M12 12h9v9h-9z" />
                </svg>
              )}
              <span>Microsoft</span>
            </button>
          </div>
          <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">
            Passwords are managed in Firebase Authentication. Use Forgot password or sign in with Google if your admin enabled it.
          </p>
        </div>

        <footer className="mt-8 flex gap-5 text-[11.5px] font-bold text-slate-400">
          <Link to="/terms" className="hover:text-slate-600 transition-colors tracking-wide">Terms of Service</Link>
          <span className="text-slate-300">•</span>
          <Link to="/contact" className="hover:text-slate-600 transition-colors tracking-wide">Support</Link>
          <span className="text-slate-300">•</span>
          <Link to="/copyright" className="hover:text-slate-600 transition-colors tracking-wide">Copyright</Link>
        </footer>
      </div>
    </main>
  );
};

export default Login;
