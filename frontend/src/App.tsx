import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import {
  Shield, FileText, Users, BarChart3, Search, Upload,
  Lock, Unlock, LogOut, ChevronRight, AlertTriangle,
  CheckCircle, XCircle, Clock, Download, Eye,
  RefreshCw, Plus, X, ShieldCheck, Sparkles,
  FileCheck, Activity, Bell, Key, Copy,
  ArrowRight, ArrowUpRight, Sun, Moon, Fingerprint,
} from 'lucide-react';
import './index.css';
import './redesign.css';
import {
  api, saveCsrfToken, clearCsrfToken, ApiError,
  type User, type Document, type CatalogDocument, type Suggestion, type ShareInvite, type AccessRequest,
} from './api.ts';

// ============================================================
// Toast System
// ============================================================

type ToastType = 'success' | 'error' | 'warning' | 'info';
interface Toast { id: string; type: ToastType; message: string; }

const ToastContext = createContext<(msg: string, type?: ToastType) => void>(() => {});

function useToast() { return useContext(ToastContext); }

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      <div className="toast-container" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role="alert">
            {t.type === 'success' && <CheckCircle size={16} style={{ color: 'var(--color-success)', flexShrink: 0 }} />}
            {t.type === 'error' && <XCircle size={16} style={{ color: 'var(--color-danger)', flexShrink: 0 }} />}
            {t.type === 'warning' && <AlertTriangle size={16} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />}
            {t.type === 'info' && <Bell size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />}
            <span style={{ color: 'var(--color-text-primary)' }}>{t.message}</span>
            <button
              onClick={() => setToasts((p) => p.filter((tt) => tt.id !== t.id))}
              className="btn btn-ghost btn-icon btn-sm" style={{ marginLeft: 'auto' }}
              aria-label="Dismiss notification"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ============================================================
// Auth Context
// ============================================================

const AuthContext = createContext<{
  user: User | null;
  setUser: (u: User | null) => void;
  logout: () => Promise<boolean>;
}>({ user: null, setUser: () => {}, logout: async () => true });

const useAuth = () => useContext(AuthContext);

const ThemeContext = createContext<{
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}>({ theme: 'dark', toggleTheme: () => {} });

const useTheme = () => useContext(ThemeContext);

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button className="theme-toggle" onClick={toggleTheme} type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  );
}

// ============================================================
// Utility Hooks & Components
// ============================================================

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);
  return { data, loading, error, refetch: run };
}

function SkeletonRow({ cols = 5 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i}><div className="skeleton" style={{ height: 16, borderRadius: 4 }} /></td>
      ))}
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ALLOWED: 'badge-success', DENIED: 'badge-danger',
    ERROR: 'badge-danger', INFO: 'badge-info',
    read: 'badge-info', edit: 'badge-accent',
    owner: 'badge-success', admin: 'badge-warning',
    viewer: 'badge-neutral', active: 'badge-success',
    disabled: 'badge-danger', pending: 'badge-warning',
    approved: 'badge-success', denied: 'badge-danger',
  };
  return <span className={`badge ${map[status] || 'badge-neutral'}`}>{status}</span>;
}

function formatDate(d: string) {
  return new Date(d).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================
// Command Palette
// ============================================================

function CommandPalette({
  onClose, onNavigate, documents, user,
}: { onClose: () => void; onNavigate: (view: string, docId?: string) => void; documents: Document[]; user: User }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const commands = [
    { label: 'Dashboard', icon: <BarChart3 size={16} />, action: () => onNavigate('dashboard') },
    { label: 'My Documents', icon: <FileText size={16} />, action: () => onNavigate('documents') },
    ...(user.role === 'owner' ? [
      { label: 'Upload Document', icon: <Upload size={16} />, action: () => onNavigate('upload') },
      { label: 'Access Requests', icon: <Key size={16} />, action: () => onNavigate('access-requests') },
    ] : []),
    ...(user.role === 'viewer' ? [
      { label: 'My Access Requests', icon: <Clock size={16} />, action: () => onNavigate('my-requests') },
    ] : []),
    ...(user.role === 'admin' ? [
      { label: 'Audit Log', icon: <Activity size={16} />, action: () => onNavigate('audit') },
      { label: 'Manage Users', icon: <Users size={16} />, action: () => onNavigate('users') },
    ] : []),
    ...documents.map((d) => ({
      label: d.title,
      icon: <FileText size={16} />,
      action: () => onNavigate('doc-detail', d.id),
    })),
  ];

  const filtered = commands.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setSelected((s) => Math.min(s + 1, filtered.length - 1));
    if (e.key === 'ArrowUp') setSelected((s) => Math.max(s - 1, 0));
    if (e.key === 'Enter' && filtered[selected]) { filtered[selected].action(); onClose(); }
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="command-palette-overlay" onClick={onClose} role="dialog" aria-modal aria-label="Command palette">
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input">
          <Search size={18} style={{ color: 'var(--color-text-muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search documents, actions..."
            id="cmd-palette-input"
            aria-label="Search commands"
          />
        </div>
        <div className="command-palette-results" role="listbox">
          {filtered.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
              No results for "{query}"
            </div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={i}
              className={`command-palette-item ${i === selected ? 'selected' : ''}`}
              onClick={() => { cmd.action(); onClose(); }}
              onMouseEnter={() => setSelected(i)}
              role="option"
              aria-selected={i === selected}
            >
              <span style={{ color: 'var(--color-accent)' }}>{cmd.icon}</span>
              <span style={{ fontSize: '0.875rem', color: 'var(--color-text-primary)' }}>{cmd.label}</span>
            </div>
          ))}
        </div>
        <div className="command-palette-footer">
          <span><kbd className="kbd">↑↓</kbd> navigate</span>
          <span><kbd className="kbd">↵</kbd> select</span>
          <span><kbd className="kbd">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function BrandLockup({ onClick }: { onClick?: () => void }) {
  return (
    <button className="brand-lockup" type="button" onClick={onClick} aria-label="TrustVault home">
      <span className="brand-mark" aria-hidden><Shield size={18} strokeWidth={1.7} /></span>
      <span className="brand-name">trust<span>vault</span></span>
    </button>
  );
}

function PublicHeader({ onHome, onSignIn, onRequestAccess }: { onHome: () => void; onSignIn: () => void; onRequestAccess: () => void }) {
  return (
    <header className="public-header">
      <BrandLockup onClick={onHome} />
      <nav className="public-nav" aria-label="Main navigation">
        <a href="#principles">Principles</a>
        <a href="#how-it-works">How it works</a>
      </nav>
      <div className="public-header-actions">
        <ThemeToggle />
        <button className="text-link" type="button" onClick={onSignIn}>Sign in</button>
        <button className="button button-dark" type="button" onClick={onRequestAccess}>Request access <ArrowUpRight size={15} /></button>
      </div>
    </header>
  );
}

function PublicLanding({ onSignIn, onRequestAccess }: { onSignIn: () => void; onRequestAccess: () => void }) {
  return (
    <div className="marketing-site" id="top">
      <PublicHeader onHome={() => window.scrollTo({ top: 0, behavior: 'smooth' })} onSignIn={onSignIn} onRequestAccess={onRequestAccess} />
      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> PRIVATE BY DESIGN <span className="eyebrow-rule" /> BUILT FOR THE WORK THAT MATTERS</div>
            <h1>Trust, built<br />into <em>every file.</em></h1>
            <p className="hero-intro">Sensitive documents deserve more than a sharing link. TrustVault makes every access intentional, every boundary enforceable, and every decision provable.</p>
            <div className="hero-actions">
              <button className="button button-accent" type="button" onClick={onRequestAccess}>Request workspace access <ArrowRight size={16} /></button>
              <a className="button button-quiet" href="#how-it-works">See how it works <span className="button-play">↓</span></a>
            </div>
            <div className="hero-footnote"><span className="tiny-check"><CheckCircle size={13} /></span> Access is checked again at the moment a file is opened.</div>
          </div>

          <div className="hero-art" aria-label="Illustration of a document passing through the TrustVault policy engine">
            <div className="art-grid" />
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-axis art-axis-x" /><div className="art-axis art-axis-y" />
            <div className="art-coordinate coord-nw">POLICY / 01</div>
            <div className="art-coordinate coord-se">AES-256 · SHA-256</div>
            <div className="signal-node node-one"><span /> IDENTITY VERIFIED</div>
            <div className="signal-node node-two"><span /> DEFAULT DENY</div>
            <div className="vault-card">
              <div className="vault-card-head"><span><span className="live-pip" /> POLICY ENGINE</span><span className="card-index">DEFAULT DENY</span></div>
              <div className="file-preview">
                <div className="file-glyph"><FileText size={20} strokeWidth={1.5} /></div>
                <div><strong>Protected document</strong><small>Encrypted · Access scoped</small></div>
                <span className="file-lock"><Lock size={14} /></span>
              </div>
              <div className="gate-flow"><span className="flow-line" /><div className="gate-icon"><Shield size={19} strokeWidth={1.6} /></div><span className="flow-line" /></div>
              <div className="decision-line"><div><small>POLICY RESULT</small><strong><i /> Authorized</strong></div><div className="decision-time">GRANT</div></div>
              <div className="ledger-line"><Fingerprint size={16} /><span>RECORDED IN AUDIT CHAIN</span><span className="ledger-hash">APPEND-ONLY</span></div>
            </div>
            <div className="denied-stamp"><span>DENIED</span><small>NO GRANT FOUND</small></div>
          </div>
        </section>

        <section className="proof-strip" aria-label="Security properties">
          <div><span className="proof-number">01</span><span>One authorization engine</span></div>
          <div><span className="proof-number">02</span><span>Revocation on the next request</span></div>
          <div><span className="proof-number">03</span><span>Append-only evidence</span></div>
          <div className="proof-status"><span className="eyebrow-dot" /> ENFORCED BY DEFAULT</div>
        </section>

        <section className="principles-section" id="principles">
          <div className="section-heading"><div><div className="eyebrow">A BETTER KIND OF SHARING</div><h2>Permission is a decision.<br /><em>Make it a deliberate one.</em></h2></div><p>Most tools hand over a link and hope for the best. TrustVault makes the boundary part of the file’s entire lifecycle.</p></div>
          <div className="principle-grid">
            <article className="principle-card"><div className="principle-top"><span className="principle-icon"><ShieldCheck size={18} /></span><span className="principle-number">01 / AUTHORIZE</span></div><h3>One gate.<br />Every time.</h3><p>Every document request passes through one policy engine. No grant means no file, even if someone knows where to look.</p><div className="principle-diagram"><span>REQUEST</span><i /><span className="diagram-gate"><Shield size={12} /></span><i /><span>DECISION</span></div></article>
            <article className="principle-card"><div className="principle-top"><span className="principle-icon"><RefreshCw size={18} /></span><span className="principle-number">02 / REVOKE</span></div><h3>Access ends<br />when you say.</h3><p>Remove a grant or session and the next request is refused. No lingering link. No waiting for a token to expire.</p><div className="revoke-visual"><span className="revoke-line" /><span className="revoke-node">ACCESS</span><span className="revoke-cut">×</span><span className="revoke-node revoked">REVOKED</span></div></article>
            <article className="principle-card"><div className="principle-top"><span className="principle-icon"><Fingerprint size={18} /></span><span className="principle-number">03 / PROVE</span></div><h3>The record<br />stays honest.</h3><p>Allowed and denied actions become part of a hash-chained audit trail that cannot be quietly rewritten.</p><div className="hash-visual"><span>SHA-256</span><span className="hash-block">a91c7e</span><ArrowRight size={13} /><span className="hash-block">0d4fb2</span><ArrowRight size={13} /><span className="hash-block">e3081a</span></div></article>
          </div>
        </section>

        <section className="how-section" id="how-it-works">
          <div className="how-copy"><div className="eyebrow">THE TRUSTVAULT MODEL</div><h2>Security should be<br /><em>quietly certain.</em></h2><p>Encrypted storage is only the beginning. TrustVault pairs it with explicit grants, live authorization, and a record that holds up under scrutiny.</p><button className="button button-dark" type="button" onClick={onRequestAccess}>Bring your workspace in <ArrowUpRight size={15} /></button></div>
          <div className="model-list">
            <div className="model-row"><span>01</span><div><strong>Seal</strong><p>Each file is encrypted with its own data key.</p></div><Lock size={17} /></div>
            <div className="model-row"><span>02</span><div><strong>Grant</strong><p>Owners choose who can read or edit, and for how long.</p></div><Key size={17} /></div>
            <div className="model-row"><span>03</span><div><strong>Verify</strong><p>Identity and permission are checked at stream time.</p></div><ShieldCheck size={17} /></div>
            <div className="model-row"><span>04</span><div><strong>Record</strong><p>Every outcome is linked into an immutable audit chain.</p></div><Activity size={17} /></div>
          </div>
        </section>

        <section className="closing-section"><div className="closing-mark"><Shield size={25} strokeWidth={1.5} /></div><div className="eyebrow">FOR WORK THAT CANNOT LEAK</div><h2>Share with intention.<br /><em>Keep proof.</em></h2><button className="button button-accent" type="button" onClick={onRequestAccess}>Request workspace access <ArrowRight size={16} /></button><span className="closing-note">Your workspace administrator provisions accounts.</span></section>
      </main>
      <footer className="public-footer"><BrandLockup onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} /><span>Document control, with the receipts.</span><span>© 2026 TRUSTVAULT</span></footer>
    </div>
  );
}

function LoginPage({ onLogin, mode, onHome, onSwitchMode, inviteToken, requestDocumentId }: {
  onLogin: (user: User) => void;
  mode: 'login' | 'signup';
  onHome: () => void;
  onSwitchMode: (mode: 'login' | 'signup') => void;
  inviteToken?: string | null;
  requestDocumentId?: string | null;
}) {
  // OTP flow state
  const [step, setStep] = useState<'email' | 'otp' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const addToast = useToast();

  // Resend countdown
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const m = mode === 'signup' ? 'register' : 'login';
      await api.auth.sendOtp(email.trim(), name.trim(), m);
      setStep('otp'); setCountdown(60);
      addToast('Verification code sent — check your Gmail inbox.', 'success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send code. Try again.');
    } finally { setLoading(false); }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api.auth.verifyOtp(email.trim(), otp.trim(), name.trim());
      saveCsrfToken(res.csrfToken);
      if (inviteToken) {
        try { const a = await api.invites.accept(inviteToken); addToast(a.message || 'Invite accepted.', 'success'); }
        catch (ie) { addToast(ie instanceof Error ? ie.message : 'Invite error.', 'warning'); }
      }
      if (inviteToken || requestDocumentId) window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#/login`);
      onLogin(res.user);
      addToast(`Welcome, ${res.user.name}!`, 'success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid or expired code.');
    } finally { setLoading(false); }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api.auth.login(email.trim(), password);
      saveCsrfToken(res.csrfToken);
      onLogin(res.user);
      addToast(`Signed in as ${res.user.name}`, 'success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid credentials.');
    } finally { setLoading(false); }
  };

  const isRegister = mode === 'signup';

  return (
    <div className="auth-page">
      <header className="auth-header">
        <BrandLockup onClick={onHome} />
        <div className="auth-header-right"><span>Protected workspace access</span><ThemeToggle /></div>
      </header>
      <main className="auth-layout">
        <section className="auth-story">
          <div className="eyebrow"><span className="eyebrow-dot" /> YOUR DOCUMENTS. YOUR RULES.</div>
          <h1>{isRegister ? <><span>Create your</span><br /><em>secure account.</em></> : <><span>A quieter way</span><br /><em>to stay in control.</em></>}</h1>
          <p>{isRegister ? 'Register with your Gmail. We send a one-time code to verify you — no passwords needed.' : 'Enter your Gmail and we\'ll send a 6-digit code. No password required.'}</p>
          <div className="auth-assurance">
            <div className="assurance-seal"><ShieldCheck size={21} strokeWidth={1.5} /></div>
            <div><strong>One-time codes. Zero stored passwords.</strong><span>Your identity is verified via Gmail OTP every login.</span></div>
          </div>
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(['📧 Enter Gmail address', '🔢 Receive 6-digit code', '✅ Verified & signed in'] as const).map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', background: i < (step === 'otp' ? 1 : 0) + 1 ? 'var(--color-accent)' : 'var(--color-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: '#fff', flexShrink: 0, fontWeight: 700 }}>{i + 1}</span>
                {s}
              </div>
            ))}
          </div>
          <div className="auth-coordinates"><span>TRUSTVAULT / ACCESS PORTAL</span><span>GMAIL OTP → SESSION → PROOF</span></div>
        </section>

        <section className="auth-form-wrap">
          <div className="auth-card">
            {/* Tab switcher */}
            <div className="auth-mode-switch" role="tablist">
              <button className={!isRegister && step !== 'password' ? 'selected' : ''} type="button" onClick={() => { setError(''); setStep('email'); setOtp(''); onSwitchMode('login'); }}>Sign in</button>
              <button className={isRegister ? 'selected' : ''} type="button" onClick={() => { setError(''); setStep('email'); setOtp(''); onSwitchMode('signup'); }}>Register</button>
              <button className={step === 'password' ? 'selected' : ''} type="button" onClick={() => { setError(''); setStep('password'); }} title="Admin password login">Password</button>
            </div>

            {/* ── Password login (admin fallback) ── */}
            {step === 'password' && (
              <>
                <div className="auth-card-title"><span className="form-kicker">ADMIN ACCESS</span><h2>Password sign-in</h2><p>For accounts created by your administrator with a set password.</p></div>
                <form onSubmit={handlePasswordLogin} className="public-form">
                  <div className="public-field"><label htmlFor="pw-email">Work email</label><input id="pw-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" className="public-input" autoComplete="username" required /></div>
                  <div className="public-field"><label htmlFor="pw-pass">Password</label><input id="pw-pass" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" className="public-input" autoComplete="current-password" required /></div>
                  {error && <div className="auth-error" role="alert"><XCircle size={15} /><span>{error}</span></div>}
                  <button type="submit" disabled={loading} className="button button-accent auth-submit">{loading ? <><RefreshCw size={16} className="animate-spin" /> Checking…</> : <>Continue securely <ArrowRight size={16} /></>}</button>
                </form>
                <div className="auth-foot"><Lock size={13} /><span>Sessions are private, scoped, and immediately revocable.</span></div>
              </>
            )}

            {/* ── Step 1: Email input ── */}
            {step === 'email' && (
              <>
                <div className="auth-card-title">
                  <span className="form-kicker">{isRegister ? 'CREATE ACCOUNT' : 'GMAIL SIGN-IN'}</span>
                  <h2>{isRegister ? 'Register with Gmail.' : 'Enter your Gmail.'}</h2>
                  <p>{isRegister ? 'We\'ll send a 6-digit code to verify your email.' : 'We\'ll send a one-time code — no password needed.'}</p>
                </div>
                <form onSubmit={handleSendOtp} className="public-form">
                  {isRegister && (
                    <div className="public-field"><label htmlFor="reg-name">Full name</label><input id="reg-name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" className="public-input" required minLength={2} /></div>
                  )}
                  <div className="public-field">
                    <label htmlFor="otp-email">Gmail address</label>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 16 }}>📧</span>
                      <input id="otp-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@gmail.com" className="public-input" style={{ paddingLeft: 38 }} autoComplete="email" required />
                    </div>
                  </div>
                  {error && <div className="auth-error" role="alert"><XCircle size={15} /><span>{error}</span></div>}
                  <button type="submit" disabled={loading} className="button button-accent auth-submit">
                    {loading ? <><RefreshCw size={16} className="animate-spin" /> Sending code…</> : <>Send verification code <ArrowRight size={16} /></>}
                  </button>
                </form>
                <div className="auth-foot"><Lock size={13} /><span>A 6-digit code valid for 10 minutes will be sent.</span></div>
              </>
            )}

            {/* ── Step 2: OTP input ── */}
            {step === 'otp' && (
              <>
                <div className="auth-card-title">
                  <span className="form-kicker">CHECK YOUR GMAIL</span>
                  <h2>Enter your code.</h2>
                  <p>A 6-digit code was sent to <strong>{email}</strong>. Enter it below to verify.</p>
                </div>
                <form onSubmit={handleVerifyOtp} className="public-form">
                  <div className="public-field">
                    <label htmlFor="otp-code">6-digit verification code</label>
                    <input
                      id="otp-code" type="text" inputMode="numeric" pattern="[0-9]{6}"
                      value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000" className="public-input"
                      style={{ letterSpacing: '0.3em', fontSize: '1.5rem', textAlign: 'center', fontWeight: 700 }}
                      autoComplete="one-time-code" maxLength={6} required
                    />
                  </div>
                  {error && <div className="auth-error" role="alert"><XCircle size={15} /><span>{error}</span></div>}
                  <button type="submit" disabled={loading || otp.length < 6} className="button button-accent auth-submit">
                    {loading ? <><RefreshCw size={16} className="animate-spin" /> Verifying…</> : <>Verify & sign in <ArrowRight size={16} /></>}
                  </button>
                </form>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                  <button type="button" className="text-link" style={{ fontSize: '0.8rem' }} onClick={() => { setStep('email'); setOtp(''); setError(''); }}>← Change email</button>
                  <button
                    type="button" className="text-link" style={{ fontSize: '0.8rem' }}
                    disabled={countdown > 0} onClick={handleSendOtp}
                  >
                    {countdown > 0 ? `Resend in ${countdown}s` : 'Resend code'}
                  </button>
                </div>
                <div className="auth-foot"><Lock size={13} /><span>Code expires in 10 minutes. Check spam if not received.</span></div>
              </>
            )}
          </div>
          <button type="button" className="back-home" onClick={onHome}>← Back to TrustVault</button>
        </section>
      </main>
      <footer className="auth-footer"><span>TRUSTVAULT / SECURE ACCESS</span><span>GMAIL OTP · ENCRYPTED · VERIFIED</span></footer>
    </div>
  );
}
// ============================================================
// Sidebar + Layout
// ============================================================


type View = 'dashboard' | 'documents' | 'upload' | 'doc-detail' | 'users' | 'audit' | 'access-requests' | 'my-requests' | 'settings';

interface NavItem {
  id: View;
  label: string;
  icon: React.ReactNode;
  roles: string[];
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 size={16} />, roles: ['admin', 'owner', 'viewer'] },
  { id: 'documents', label: 'Documents', icon: <FileText size={16} />, roles: ['admin', 'owner', 'viewer'] },
  { id: 'upload', label: 'Upload', icon: <Upload size={16} />, roles: ['owner'] },
  { id: 'access-requests', label: 'Access Requests', icon: <Key size={16} />, roles: ['owner'] },
  { id: 'my-requests', label: 'My Requests', icon: <Clock size={16} />, roles: ['viewer'] },
  { id: 'users', label: 'Manage Users', icon: <Users size={16} />, roles: ['admin'] },
  { id: 'audit', label: 'Audit Log', icon: <Activity size={16} />, roles: ['admin'] },
];

function Sidebar({ active, onNavigate, user }: { active: View; onNavigate: (v: View) => void; user: User }) {
  const { logout } = useAuth();
  const addToast = useToast();

  const handleLogout = async () => {
    const serverConfirmed = await logout();
    addToast(
      serverConfirmed
        ? 'Signed out successfully.'
        : 'Signed out here, but the server could not confirm session revocation.',
      serverConfirmed ? 'success' : 'warning'
    );
  };

  return (
    <aside className="app-sidebar" aria-label="Navigation">
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon" aria-hidden>
          <Shield size={18} />
        </div>
        <div className="sidebar-logo-text">
          <h1>TrustVault</h1>
          <p>Private by design</p>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <span className="sidebar-section-label">Navigation</span>
        {NAV_ITEMS.filter((n) => n.roles.includes(user.role)).map((item) => (
          <button
            key={item.id}
            className={`sidebar-nav-item ${active === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            aria-current={active === item.id ? 'page' : undefined}
            id={`nav-${item.id}`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}

        <span className="sidebar-section-label" style={{ marginTop: 'auto' }}>Account</span>
        <button className="sidebar-nav-item" type="button" onClick={handleLogout} id="nav-logout">
          <LogOut size={16} />
          Sign out
        </button>
      </nav>

      <div className="sidebar-footer">
        <div className="user-card" aria-label={`Logged in as ${user.name}`}>
          <div className="user-avatar" aria-hidden>
            {user.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="user-info">
            <div className="user-name">{user.name}</div>
            <div className="user-role">{user.role} · {user.email.split('@')[1]}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ============================================================
// Documents View
// ============================================================

function DocumentsView({ onNavigate }: { onNavigate: (v: View, id?: string) => void }) {
  const { user } = useAuth();
  const addToast = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const { data, loading, error, refetch } = useAsync(() => api.documents.list(), []);
  const { data: requestsData, refetch: refetchRequests } = useAsync(
    () => user?.role === 'viewer' ? api.accessRequests.listMine() : Promise.resolve(null),
    [user?.role]
  );
  const docs = data?.documents || [];
  const categories = [...new Set(docs.map((doc) => doc.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const visibleDocs = docs.filter((doc) =>
    (!category || doc.category === category) && doc.title.toLowerCase().includes(search.trim().toLowerCase())
  );
  const pendingEditRequests = new Set((requestsData?.requests || [])
    .filter((request) => request.status === 'pending' && request.targetPermission === 'edit')
    .map((request) => request.documentId));
  const pendingRequestCount = (requestsData?.requests || []).filter((request) => request.status === 'pending').length;

  const requestEditAccess = async (doc: Document) => {
    try {
      const result = await api.accessRequests.submit(doc.id, 'edit');
      addToast(result.message, 'success');
      await refetchRequests();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not submit the access request.', 'error');
    }
  };

  const roleShortcuts = user?.role === 'owner'
    ? <>
        <button className="btn-vault-secondary px-3 py-2" onClick={() => onNavigate('access-requests')}><Key size={14} /> Review requests</button>
        <button className="btn-vault-primary px-3 py-2" onClick={() => onNavigate('upload')}><Upload size={14} /> Upload document</button>
      </>
    : user?.role === 'admin'
      ? <>
          <button className="btn-vault-secondary px-3 py-2" onClick={() => onNavigate('users')}><Users size={14} /> Manage users</button>
          <button className="btn-vault-secondary px-3 py-2" onClick={() => onNavigate('audit')}><Activity size={14} /> Audit log</button>
        </>
      : <button className="btn-vault-secondary px-3 py-2" onClick={() => onNavigate('my-requests')}><Key size={14} /> My requests{pendingRequestCount > 0 ? ` · ${pendingRequestCount} pending` : ''}</button>;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* View Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-mono uppercase tracking-wider mb-2 font-semibold">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            ENCRYPTED REPOSITORY
          </div>
          <h1 className="text-2xl lg:text-3xl font-display font-bold text-white tracking-tight">
            Authorized Documents
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Only documents granted to your account appear here. Search and category filters stay within this authorized list.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {roleShortcuts}
          <div className="relative">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
            <input
              className="vault-input pl-10 w-64 text-sm"
              placeholder="Filter by title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              id="docs-search"
              aria-label="Filter documents by title"
            />
          </div>
          <button className="btn-vault-secondary px-3 py-2" onClick={refetch} aria-label="Refresh repository" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-1" aria-label="Filter documents by category">
        {['', ...categories].map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              category === cat
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-semibold shadow-sm'
                : 'bg-slate-900/60 hover:bg-slate-800 text-slate-400 border border-slate-800'
            }`}
          >
            {cat === '' ? `All categories · ${docs.length}` : `${cat} · ${docs.filter((doc) => doc.category === cat).length}`}
          </button>
        ))}
        </div>
        <p className="text-slate-500 text-xs">Showing {visibleDocs.length} of {docs.length} authorized document{docs.length === 1 ? '' : 's'}</p>
      </div>

      {/* Content Table / Cards */}
      {loading ? (
        <div className="table-container p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="alert alert-danger" role="alert"><XCircle size={15} /><span>{error}</span><button className="btn btn-ghost btn-sm" onClick={refetch}>Retry</button></div>
      ) : visibleDocs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><FileText size={28} /></div>
          <h3>{docs.length === 0 ? 'No accessible documents' : 'No matching documents'}</h3>
          <p>{docs.length > 0 ? 'Try another title or category filter.' : user?.role === 'viewer' ? 'Ask the owner for a request link. It will take you to a form that sends an access request without showing the document.' : user?.role === 'owner' ? 'Upload a document to start managing access and requests.' : 'There are no documents granted to this account.'}</p>
          {docs.length === 0 && user?.role === 'viewer' && <button className="btn-vault-primary mt-4" onClick={() => onNavigate('my-requests')}><Key size={14} /> Request document access</button>}
          {docs.length === 0 && user?.role === 'owner' && <button className="btn-vault-primary mt-4" onClick={() => onNavigate('upload')}><Upload size={14} /> Upload a document</button>}
          {docs.length === 0 && user?.role === 'admin' && <div className="flex justify-center gap-2 mt-4"><button className="btn-vault-secondary" onClick={() => onNavigate('users')}><Users size={14} /> Manage users</button><button className="btn-vault-secondary" onClick={() => onNavigate('audit')}><Activity size={14} /> Review audit log</button></div>}
        </div>
      ) : (
        <div className="table-container shadow-xl">
          <table className="table" aria-label="Documents list">
            <thead>
              <tr>
                <th>Document Identifier</th>
                <th>Category</th>
                <th>Permission</th>
                <th>Owner Enclave</th>
                <th>Ciphertext Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibleDocs.map((doc) => (
                <tr key={doc.id} className="hover:bg-slate-800/40 transition-colors">
                  <td>
                    <button
                      className="flex items-center gap-2.5 text-left font-semibold text-white hover:text-emerald-400 transition-colors cursor-pointer group"
                      onClick={() => onNavigate('doc-detail', doc.id)}
                    >
                      <div className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-emerald-400 group-hover:border-emerald-500/40">
                        <FileText size={15} />
                      </div>
                      <span>{doc.title}</span>
                    </button>
                  </td>
                  <td><span className="vault-badge vault-badge-slate">{doc.category}</span></td>
                  <td><StatusBadge status={doc.effectivePermission || 'read'} /></td>
                  <td className="text-slate-400 text-xs font-mono">{doc.ownerEmail || '—'}</td>
                  <td className="text-slate-400 text-xs font-mono">{formatDate(doc.updatedAt)}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-2">
                      {user?.role === 'viewer' && doc.effectivePermission === 'read' && (
                        pendingEditRequests.has(doc.id)
                          ? <button className="btn-vault-secondary text-xs py-1.5 px-3" disabled aria-label={`Edit access request pending for ${doc.title}`}><Clock size={13} /> Pending</button>
                          : <button className="btn-vault-secondary text-xs py-1.5 px-3" onClick={() => requestEditAccess(doc)} aria-label={`Request edit access to ${doc.title}`}><Key size={13} /> Request edit</button>
                      )}
                      <button className="btn-vault-secondary text-xs py-1.5 px-3" onClick={() => onNavigate('doc-detail', doc.id)} aria-label={`Open ${doc.title}`}><Eye size={13} /> Open</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Document Detail View
// ============================================================

function DocumentDetailView({ docId, onBack }: { docId: string; onBack: () => void }) {
  const { user } = useAuth();
  const addToast = useToast();
  const [showGrantModal, setShowGrantModal] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [invitePermission, setInvitePermission] = useState<'read' | 'edit'>('read');
  const [inviteExpiry, setInviteExpiry] = useState(72);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [issuedInviteLink, setIssuedInviteLink] = useState<string | null>(null);
  const [issuedAccessRequestLink, setIssuedAccessRequestLink] = useState<string | null>(null);
  const [requestingEditAccess, setRequestingEditAccess] = useState(false);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const versionInputRef = useRef<HTMLInputElement>(null);

  const { data, loading, error, refetch: refetchDocument } = useAsync(
    () => api.documents.get(docId),
    [docId]
  );

  const doc = data?.document;
  const versions = data?.versions || [];
  const isOwner = user?.role === 'owner' && doc?.ownerId === user?.id;
  const { data: myRequestsData, refetch: refetchMyRequests } = useAsync(
    () => user?.role === 'viewer' ? api.accessRequests.listMine() : Promise.resolve({ requests: [] as AccessRequest[] }),
    [user?.role]
  );
  const editRequestPending = (myRequestsData?.requests || []).some((request) =>
    request.documentId === docId && request.targetPermission === 'edit' && request.status === 'pending'
  );
  const { data: grantsData, loading: grantsLoading, refetch: refetchGrants } = useAsync(
    () => isOwner ? api.grants.list(docId) : Promise.resolve({ grants: [], ownerId: '', ownerEmail: '' }),
    [docId, isOwner]
  );
  const grants = grantsData?.grants || [];
  const activeGrantCount = grants.filter((grant) => !grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()).length;
  const expiredGrantCount = grants.length - activeGrantCount;
  const canUploadVersion = doc?.effectivePermission === 'owner' || doc?.effectivePermission === 'edit';
  const { data: inviteData, loading: invitesLoading, refetch: refetchInvites } = useAsync(
    () => isOwner ? api.invites.list(docId) : Promise.resolve({ invites: [] as ShareInvite[] }),
    [docId, isOwner]
  );
  const invites = inviteData?.invites || [];

  const handleCreateInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreatingInvite(true);
    setIssuedInviteLink(null);
    try {
      const result = await api.invites.create(docId, recipientEmail.trim(), invitePermission, inviteExpiry);
      const loginUrl = new URL(window.location.pathname, window.location.origin);
      loginUrl.hash = `/login?invite=${encodeURIComponent(result.rawToken)}`;
      setIssuedInviteLink(loginUrl.toString());
      setRecipientEmail('');
      addToast('Invitation created. Copy and send the link to the invited address.', 'success');
      refetchInvites();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not create invitation.', 'error');
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleRevokeInvite = async (invite: ShareInvite) => {
    if (!confirm(`Revoke the invitation for ${invite.email}?`)) return;
    try {
      await api.invites.revoke(docId, invite.id);
      addToast('Invitation revoked.', 'success');
      refetchInvites();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not revoke invitation.', 'error');
    }
  };

  const copyInviteLink = async () => {
    if (!issuedInviteLink) return;
    try {
      await navigator.clipboard.writeText(issuedInviteLink);
      addToast('Invitation link copied.', 'success');
    } catch {
      addToast('Clipboard access is unavailable. Select and copy the link.', 'warning');
    }
  };

  const copyAccessRequestLink = async () => {
    const requestUrl = new URL(window.location.pathname, window.location.origin);
    requestUrl.hash = `/login?request=${encodeURIComponent(docId)}`;
    setIssuedAccessRequestLink(requestUrl.toString());
    try {
      await navigator.clipboard.writeText(requestUrl.toString());
      addToast('Request link copied. Share it with the viewer so they can ask you for access.', 'success');
    } catch {
      addToast('The request link is shown below. Select and copy it to share.', 'warning');
    }
  };

  const handleDownload = async () => {
    try {
      const { rawTicket } = await api.tickets.issue(docId);
      const { blob, filename } = await api.tickets.download(docId, rawTicket);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      addToast('Download started.', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Download failed', 'error');
    }
  };

  const handleVersionUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setUploadingVersion(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const result = await api.documents.addVersion(docId, formData);
      addToast(`Version ${result.version.versionNumber} uploaded successfully.`, 'success');
      await refetchDocument();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not upload this version.', 'error');
    } finally {
      input.value = '';
      setUploadingVersion(false);
    }
  };

  const copyVersionHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      addToast('SHA-256 checksum copied.', 'success');
    } catch {
      addToast('Clipboard access is unavailable. Select the checksum to copy it.', 'warning');
    }
  };

  const handleRequestEditAccess = async () => {
    setRequestingEditAccess(true);
    try {
      const result = await api.accessRequests.submit(docId, 'edit');
      addToast(result.message, 'info');
      await refetchMyRequests();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not submit the access request.', 'error');
    } finally {
      setRequestingEditAccess(false);
    }
  };

  const handleRevokeAll = async () => {
    if (!confirm('Revoke ALL grants on this document? This is immediate.')) return;
    try {
      const result = await api.grants.revokeAll(docId);
      addToast(`Revoked ${result.revokedCount} grant(s).`, 'success');
      refetchGrants();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    }
  };

  const handleRevokeGrant = async (userId: string, email: string) => {
    if (!confirm(`Revoke access for ${email}?`)) return;
    try {
      await api.grants.revoke(docId, userId);
      addToast(`Access revoked for ${email}.`, 'success');
      refetchGrants();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    }
  };

  const handleGenerateSuggestions = async () => {
    setLoadingSuggestions(true);
    try {
      const result = await api.suggestions.generate(docId);
      setSuggestions(result.suggestions);
      setShowSuggestions(true);
      addToast(`${result.suggestions.length} suggestion(s) from ${result.provider}.`, 'info');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Suggestions failed', 'error');
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleConfirmSuggestion = async (s: Suggestion, decision: 'accepted' | 'rejected') => {
    try {
      await api.suggestions.confirm(docId, {
        userId: s.userId,
        suggestedPermission: s.suggestedPermission,
        confirmedPermission: s.suggestedPermission,
        decision,
        aiRationale: s.rationale,
      });
      addToast(decision === 'accepted' ? `Grant issued to ${s.email}.` : `Suggestion rejected.`, decision === 'accepted' ? 'success' : 'info');
      if (decision === 'accepted') {
        setSuggestions((prev) => prev.filter((ss) => ss.userId !== s.userId));
        refetchGrants();
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  };

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="skeleton" style={{ height: 40, width: '60%' }} />
      <div className="skeleton" style={{ height: 200 }} />
    </div>
  );

  if (error || !doc) return (
    <div className="empty-state">
      <div className="empty-state-icon"><XCircle size={28} /></div>
      <h3>Document not found</h3>
      <p>This document doesn't exist or you don't have access. <button className="btn btn-ghost btn-sm" onClick={onBack}>Go back</button></p>
    </div>
  );

  return (
    <div className="document-detail-page space-y-6 animate-fade-in">
      {/* Breadcrumb */}
      <div className="document-detail-breadcrumb flex items-center gap-2 text-sm">
        <button className="btn-vault-ghost text-xs py-1 px-2.5" onClick={onBack}>
          ← Documents Enclave
        </button>
        <ChevronRight size={14} className="text-slate-600" />
        <span className="document-detail-breadcrumb-title text-white font-medium" title={doc.title}>{doc.title}</span>
      </div>

      <div className="document-detail-layout grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left column */}
        <div className="document-detail-main xl:col-span-7 space-y-6">
          {/* Document header card */}
          <div className="vault-card p-6">
            <div className="document-detail-header flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 pb-6 border-b border-slate-800">
              <div className="flex items-start gap-3.5">
                <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  <FileText size={22} />
                </div>
                <div className="document-detail-heading min-w-0">
                  <h2 className="document-detail-title text-xl font-display font-bold text-white">{doc.title}</h2>
                  <p className="document-detail-description text-slate-400 text-xs mt-1">{doc.description || 'Encrypted document ciphertext in zero-trust enclave.'}</p>
                </div>
              </div>
              <div className="document-detail-actions flex flex-wrap items-center gap-2">
                {user?.role === 'viewer' && doc.effectivePermission === 'read' && (
                  <button className="btn-vault-secondary text-xs py-2 px-3" onClick={handleRequestEditAccess} disabled={requestingEditAccess || editRequestPending}>
                    {requestingEditAccess ? <><RefreshCw size={13} className="animate-spin" /> Sending…</> : editRequestPending ? <><Clock size={13} /> Request pending</> : <><Key size={13} /> Request edit access</>}
                  </button>
                )}
                {isOwner && <button className="btn-vault-secondary text-xs py-2 px-3" onClick={copyAccessRequestLink}><Copy size={13} /> Copy request link</button>}
                {canUploadVersion && <>
                  <input ref={versionInputRef} className="document-version-file-input" type="file" accept=".pdf,.docx,.xlsx,.pptx,.txt,.csv,.png,.jpg,.jpeg" onChange={handleVersionUpload} aria-label="Choose a file for the new document version" />
                  <button className="btn-vault-secondary text-xs py-2 px-3" type="button" onClick={() => versionInputRef.current?.click()} disabled={uploadingVersion}>
                    {uploadingVersion ? <><RefreshCw size={13} className="animate-spin" /> Uploading…</> : <><Upload size={13} /> New version</>}
                  </button>
                </>}
                <button className="btn-vault-primary text-xs py-2 px-4 shadow-md shadow-emerald-950/40" onClick={handleDownload} id="btn-download">
                  <Download size={14} /> Download latest version
                </button>
              </div>
            </div>

            {isOwner && issuedAccessRequestLink && <div className="mb-5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <label htmlFor="document-access-request-link" className="block text-[10px] uppercase tracking-wider text-emerald-400 mb-2">Viewer request link · access is not granted until you approve</label>
              <div className="flex gap-2"><input id="document-access-request-link" readOnly value={issuedAccessRequestLink} className="vault-input min-w-0 flex-1 text-xs" onFocus={(event) => event.currentTarget.select()} /><button className="btn-vault-secondary px-2" type="button" onClick={copyAccessRequestLink} aria-label="Copy viewer request link"><Copy size={14} /></button></div>
            </div>}

            <div className="document-meta-grid grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="document-meta-item p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Category</p>
                <span className="vault-badge vault-badge-slate">{doc.category}</span>
              </div>
              <div className="document-meta-item p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Your Permission</p>
                <StatusBadge status={doc.effectivePermission || 'read'} />
              </div>
              <div className="document-meta-item p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Document owner</p>
                <p className="text-xs font-semibold text-slate-200 truncate">{doc.ownerName || doc.ownerEmail}</p>
                {doc.ownerName && <p className="text-[10px] font-mono text-slate-400 truncate">{doc.ownerEmail}</p>}
              </div>
            </div>
          </div>

          {/* Version history */}
          <div className="vault-card p-6">
            <div className="document-section-heading flex items-center justify-between mb-4">
              <div><h3 className="font-display font-bold text-white text-base">Version history</h3><p className="text-xs text-slate-400 mt-1">{versions.length} version{versions.length === 1 ? '' : 's'} · newest first</p>{canUploadVersion && <p className="document-version-help">PDF, Office, text, CSV, and image files · up to 15 MB</p>}</div>
              <span className="document-encryption-label"><ShieldCheck size={13} /> Encrypted at rest</span>
            </div>
            {versions.length === 0 ? (
              <div className="empty-state py-8"><div className="empty-state-icon"><FileText size={22} /></div><h3>No versions yet</h3><p>Uploaded document versions will be listed here.</p></div>
            ) : (
              <div className="document-version-list" aria-label="Document versions">
                {versions.map((version, index) => (
                  <article className="document-version-card" key={version.id}>
                    <div className="document-version-top"><div className="flex items-center gap-2"><span className="vault-badge vault-badge-emerald">v{version.versionNumber}</span>{index === 0 && <span className="document-current-badge">CURRENT</span>}</div><time>{formatDate(version.createdAt)}</time></div>
                    <h4 className="document-version-filename" title={version.originalFilename}>{version.originalFilename}</h4>
                    <div className="document-version-facts"><span>{formatBytes(version.fileSize)}</span><span>{version.mimeType}</span></div>
                    <details className="document-version-integrity"><summary>SHA-256 integrity checksum</summary><div><code>{version.sha256Hash}</code><button type="button" className="btn-vault-secondary" onClick={() => copyVersionHash(version.sha256Hash)}><Copy size={12} /> Copy</button></div></details>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column — Who can see this */}
        <div className="document-detail-aside xl:col-span-5 space-y-5">
          <div className="vault-card p-6 border-emerald-500/25 shadow-xl shadow-black/60 relative">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <h3 className="font-display font-bold text-white text-base flex items-center gap-2">
                <ShieldCheck size={18} className="text-emerald-400" />
                <span>Access & permissions</span>
              </h3>
              {isOwner && (
                <button className="btn-vault-secondary text-xs py-1.5 px-3" onClick={() => setShowGrantModal(true)} id="btn-grant">
                  <Plus size={13} /> Issue Grant
                </button>
              )}
            </div>

            <div className="document-access-summary">
              <span className="document-access-summary-icon"><Lock size={14} /></span>
              <p>{isOwner ? grantsLoading ? 'Loading current grants…' : `${activeGrantCount} active grant${activeGrantCount === 1 ? '' : 's'}${expiredGrantCount ? ` · ${expiredGrantCount} expired` : ''}. Only you can view or change this list.` : 'Your access is limited to the permission shown on this page. Grant details are visible only to the document owner.'}</p>
            </div>

            <div className="space-y-3">
              {/* Owner row */}
              <div className="grant-row">
                <div className="user-avatar text-xs shrink-0">
                  {(doc.ownerName || doc.ownerEmail || '').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{isOwner ? 'You' : doc.ownerName || doc.ownerEmail}</p>
                  <p className="text-[11px] text-slate-400 truncate">{doc.ownerEmail} · Full control</p>
                </div>
                <span className="vault-badge vault-badge-emerald">OWNER</span>
              </div>

              {grantsLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ height: 56, borderRadius: 8 }} />
                ))
              ) : grants.length === 0 ? (
                <p className="text-muted text-sm" style={{ textAlign: 'center', padding: 'var(--space-4)' }}>
                  {isOwner ? 'Nobody else — not even administrators.' : 'Grant details are visible to the document owner.'}
                </p>
              ) : (
                grants.map((g) => {
                  const expired = Boolean(g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now());
                  return <div key={g.id} className={`grant-row ${expired ? 'document-grant-expired' : ''}`}>
                    <div className="user-avatar" style={{ width: 28, height: 28, fontSize: '0.65rem' }}>{g.userEmail.slice(0, 2).toUpperCase()}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>{g.userEmail}</p>
                      {g.expiresAt && <p className="text-xs text-muted"><Clock size={10} style={{ display: 'inline' }} /> {expired ? 'Expired' : 'Expires'} {formatDate(g.expiresAt)}</p>}
                    </div>
                    {expired ? <span className="document-expired-badge">EXPIRED</span> : <StatusBadge status={g.permission} />}
                    {isOwner && <button className="btn btn-ghost btn-icon btn-sm" onClick={() => handleRevokeGrant(g.userId, g.userEmail)} title={`Revoke access for ${g.userEmail}`} aria-label={`Revoke access for ${g.userEmail}`}><X size={12} /></button>}
                  </div>;
                })
              )}

              {isOwner && grants.length > 0 && (
                <button className="btn btn-danger btn-sm w-full" onClick={handleRevokeAll} id="btn-revoke-all">
                  <XCircle size={14} /> Revoke All
                </button>
              )}

              {/* AI Suggestions */}
              {isOwner && (
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <button
                    className="btn btn-secondary btn-sm w-full"
                    onClick={handleGenerateSuggestions}
                    disabled={loadingSuggestions}
                    id="btn-ai-suggestions"
                  >
                    {loadingSuggestions
                      ? <><RefreshCw size={14} className="animate-spin" /> Analyzing…</>
                      : <><Sparkles size={14} /> AI Suggestions</>
                    }
                  </button>
                </div>
              )}
            </div>
          </div>

          {isOwner && (
            <div className="vault-card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display font-bold text-white text-base">Share invitation</h3>
                <span className="text-[10px] font-mono text-slate-500">RECIPIENT-BOUND</span>
              </div>
              <p className="text-xs text-slate-400 mb-4">Create a time-limited link for a specific email. The recipient must have a workspace account and sign in with that address to accept.</p>
              <form onSubmit={handleCreateInvite} className="space-y-3">
                <label className="block text-xs text-slate-400" htmlFor="invite-recipient">Recipient email</label>
                <input id="invite-recipient" type="email" required value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} className="vault-input w-full text-sm" placeholder="person@company.com" />
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-slate-400">Permission
                    <select value={invitePermission} onChange={(event) => setInvitePermission(event.target.value as 'read' | 'edit')} className="vault-input w-full mt-1 text-xs">
                      <option value="read">Read</option><option value="edit">Edit</option>
                    </select>
                  </label>
                  <label className="block text-xs text-slate-400">Expires in
                    <select value={inviteExpiry} onChange={(event) => setInviteExpiry(Number(event.target.value))} className="vault-input w-full mt-1 text-xs">
                      <option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option><option value={720}>30 days</option>
                    </select>
                  </label>
                </div>
                <button className="btn-vault-secondary w-full justify-center text-xs py-2" type="submit" disabled={creatingInvite}>
                  {creatingInvite ? <><RefreshCw size={13} className="animate-spin" /> Creating…</> : <><Plus size={13} /> Create invitation link</>}
                </button>
              </form>
              {issuedInviteLink && (
                <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
                  <label htmlFor="new-invite-link" className="block text-[10px] uppercase tracking-wider text-emerald-400 mb-2">Copy this link now</label>
                  <div className="flex gap-2">
                    <input id="new-invite-link" readOnly value={issuedInviteLink} className="vault-input min-w-0 flex-1 text-[10px]" onFocus={(event) => event.currentTarget.select()} />
                    <button className="btn-vault-secondary px-2" type="button" onClick={copyInviteLink} aria-label="Copy invitation link"><Copy size={14} /></button>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-2">This secret is only shown once. Revoke the invitation if the link is lost or shared incorrectly.</p>
                </div>
              )}
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between"><span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Recent invitations</span><button type="button" onClick={refetchInvites} className="text-[10px] text-slate-400 hover:text-white">Refresh</button></div>
                {invitesLoading ? <div className="skeleton h-10 w-full" /> : invites.length === 0 ? <p className="text-xs text-slate-500">No invitations created.</p> : invites.map((invite) => {
                  const expired = new Date(invite.expiresAt).getTime() <= Date.now();
                  const active = !invite.revokedAt && !invite.usedAt && !expired;
                  return <div key={invite.id} className="flex items-center gap-2 rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{invite.email}<small className="block text-[10px] text-slate-500">{invite.permission} · expires {formatDate(invite.expiresAt)}</small></span>
                    <StatusBadge status={invite.revokedAt ? 'denied' : invite.usedAt ? 'approved' : expired ? 'disabled' : 'pending'} />
                    {active && <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => handleRevokeInvite(invite)} aria-label={`Revoke invitation for ${invite.email}`}><X size={12} /></button>}
                  </div>;
                })}
              </div>
            </div>
          )}

          {/* AI Suggestions panel */}
          {showSuggestions && suggestions.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <Sparkles size={16} style={{ color: 'var(--color-warning)' }} />
                  AI Proposals
                </h3>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setShowSuggestions(false)} aria-label="Close suggestions">
                  <X size={14} />
                </button>
              </div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div className="alert alert-warning" style={{ fontSize: '0.75rem' }}>
                  <AlertTriangle size={14} />
                  <span>These are unconfirmed proposals. No access has been granted yet. You must confirm each one.</span>
                </div>
                {suggestions.map((s) => (
                  <div key={s.userId} style={{
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3)',
                  }}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="user-avatar" style={{ width: 24, height: 24, fontSize: '0.6rem' }}>
                        {s.email.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>{s.email}</p>
                      </div>
                      <StatusBadge status={s.suggestedPermission} />
                    </div>
                    <p className="text-xs text-muted mb-3">{s.rationale}</p>
                    <div className="flex gap-2">
                      <button
                        className="btn btn-primary btn-sm flex-1"
                        onClick={() => handleConfirmSuggestion(s, 'accepted')}
                      >
                        <CheckCircle size={12} /> Grant
                      </button>
                      <button
                        className="btn btn-ghost btn-sm flex-1"
                        onClick={() => handleConfirmSuggestion(s, 'rejected')}
                      >
                        <X size={12} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Grant Modal */}
      {showGrantModal && (
        <GrantModal
          docId={docId}
          onClose={() => setShowGrantModal(false)}
          onGranted={() => { refetchGrants(); setShowGrantModal(false); }}
        />
      )}
    </div>
  );
}

// ============================================================
// Grant Modal
// ============================================================

function GrantModal({ docId, onClose, onGranted }: { docId: string; onClose: () => void; onGranted: () => void }) {
  const addToast = useToast();
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<'read' | 'edit'>('read');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) { setError('User ID is required'); return; }
    setLoading(true);
    setError('');
    try {
      await api.grants.issue(docId, userId.trim(), permission, expiresAt || null);
      addToast('Grant issued successfully.', 'success');
      onGranted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue grant');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal aria-labelledby="grant-modal-title">
      <div className="modal">
        <div className="modal-header">
          <h3 className="modal-title" id="grant-modal-title">Issue Grant</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close modal"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label" htmlFor="grant-user-id">User ID (UUID)</label>
              <input id="grant-user-id" className="form-input" value={userId} onChange={(e) => setUserId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }} />
              <span className="form-hint">Find user IDs in the Users management page.</span>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="grant-permission">Permission</label>
              <select id="grant-permission" className="form-select" value={permission} onChange={(e) => setPermission(e.target.value as 'read' | 'edit')}>
                <option value="read">read — can view and download</option>
                <option value="edit">edit — can upload new versions</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="grant-expires">Expiry (optional)</label>
              <input id="grant-expires" type="datetime-local" className="form-input" value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)} />
              <span className="form-hint">Leave blank for a permanent grant.</span>
            </div>
            {error && <div className="alert alert-danger"><XCircle size={14} />{error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading} id="btn-confirm-grant">
              {loading ? <><RefreshCw size={14} className="animate-spin" /> Granting…</> : <><CheckCircle size={14} /> Issue Grant</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Upload View
// ============================================================

function UploadView({ onUploaded }: { onUploaded: () => void }) {
  const addToast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('General');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
    setError('');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Please select a file to upload.'); return; }
    if (!title.trim()) { setError('Title is required.'); return; }

    setUploading(true);
    setProgress(0);
    setError('');

    // Simulate progress
    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + 15, 85));
    }, 200);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    formData.append('category', category);

    try {
      await api.documents.upload(formData);
      clearInterval(progressInterval);
      setProgress(100);
      addToast('Document uploaded successfully!', 'success');
      setTimeout(() => { onUploaded(); }, 800);
    } catch (err) {
      clearInterval(progressInterval);
      setProgress(0);
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setError(msg);
      addToast(msg, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <div className="mb-6">
        <h2 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Upload Document</h2>
        <p className="text-muted text-sm mt-1">Files are encrypted at rest (AES-256-GCM). Extensions and magic bytes are validated server-side.</p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {/* Drop zone */}
        <div
          className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Upload file drop zone"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        >
          <div className="upload-zone-icon">
            <Upload size={24} />
          </div>
          {file ? (
            <div>
              <p style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{file.name}</p>
              <p className="text-sm text-muted">{formatBytes(file.size)}</p>
            </div>
          ) : (
            <div>
              <p style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Drop a file here, or click to browse</p>
              <p className="text-sm text-muted mt-1">PDF, DOCX, TXT, PNG, JPG, CSV — max 15 MB</p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
            id="file-upload-input"
            aria-label="Choose file"
          />
        </div>

        {/* Progress */}
        {uploading && (
          <div>
            <div className="flex justify-between text-xs text-muted mb-2">
              <span>Uploading…</span>
              <span>{progress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Document Metadata</h3>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="doc-title">Title *</label>
              <input id="doc-title" className="form-input" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="Document title…" maxLength={200} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="doc-description">Description</label>
              <textarea id="doc-description" className="form-textarea" value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description…" rows={3} maxLength={1000}
                style={{ resize: 'vertical' }} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="doc-category">Category</label>
              <select id="doc-category" className="form-select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="General">General</option>
                <option value="Finance">Finance</option>
                <option value="Engineering">Engineering</option>
                <option value="Legal">Legal</option>
              </select>
            </div>
          </div>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert">
            <XCircle size={16} /><span>{error}</span>
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button type="submit" id="btn-upload-submit" className="btn btn-primary btn-lg" disabled={uploading || !file}>
            {uploading
              ? <><RefreshCw size={16} className="animate-spin" /> Encrypting & uploading…</>
              : <><FileCheck size={16} /> Upload securely</>
            }
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================
// Admin Users View
// ============================================================

function UsersView() {
  const addToast = useToast();
  const { data, loading, error, refetch } = useAsync(() => api.admin.listUsers(), []);
  const users = data?.users || [];
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [activityUser, setActivityUser] = useState<{ id: string; name: string; email: string } | null>(null);
  const visibleUsers = users.filter((user) => {
    const matchesSearch = `${user.name} ${user.email}`.toLowerCase().includes(search.trim().toLowerCase());
    const matchesRole = !roleFilter || user.role === roleFilter;
    const isLocked = Boolean(user.lockedUntil && new Date(user.lockedUntil) > new Date());
    const status = user.isDisabled ? 'disabled' : isLocked ? 'locked' : 'active';
    return matchesSearch && matchesRole && (!statusFilter || status === statusFilter);
  });
  const { data: activityData, loading: activityLoading, error: activityError } = useAsync(
    () => activityUser ? api.admin.activityUser(activityUser.id) : Promise.resolve(null),
    [activityUser?.id]
  );

  const handleDisable = async (userId: string, email: string, disable: boolean) => {
    if (!confirm(`${disable ? 'Disable' : 'Enable'} ${email}?`)) return;
    try {
      await api.admin.updateStatus(userId, disable);
      addToast(`User ${disable ? 'disabled' : 'enabled'}.`, 'success');
      refetch();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  };

  const handleForceLogout = async (userId: string, email: string) => {
    if (!confirm(`Force-logout all sessions for ${email}?`)) return;
    try {
      const res = await api.admin.forceLogout(userId);
      addToast(`Revoked ${res.revokedSessionsCount} session(s) for ${email}.`, 'success');
      refetch();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  };

  const handleUnlock = async (userId: string, email: string) => {
    try {
      await api.admin.unlock(userId);
      addToast(`Account unlocked for ${email}.`, 'success');
      refetch();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Manage Users</h2>
          <p className="text-muted text-sm mt-1">Showing {visibleUsers.length} of {users.length} organization users</p>
        </div>
        <div className="flex gap-3">
          <button className="btn btn-ghost btn-icon" onClick={refetch} aria-label="Refresh users">
            <RefreshCw size={16} />
          </button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)} id="btn-create-user">
            <Plus size={16} /> Create User
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="relative flex-1" style={{ minWidth: 220, maxWidth: 420 }}>
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input className="form-input" style={{ paddingLeft: 36 }} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" aria-label="Search users" />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">Role<select className="form-select" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="Filter users by role"><option value="">All roles</option><option value="viewer">Viewers</option><option value="owner">Owners</option><option value="admin">Admins</option></select></label>
        <label className="flex items-center gap-2 text-xs text-slate-400">Status<select className="form-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter users by status"><option value="">All statuses</option><option value="active">Active</option><option value="locked">Locked</option><option value="disabled">Disabled</option></select></label>
        {(search || roleFilter || statusFilter) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setRoleFilter(''); setStatusFilter(''); }}>Clear filters</button>}
      </div>

      {error && <div className="alert alert-danger mb-4" role="alert"><XCircle size={15} />{error}<button className="btn btn-ghost btn-sm" onClick={refetch}>Retry</button></div>}

      {loading ? (
        <div className="table-container">
          <table className="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Sessions</th><th /></tr></thead>
            <tbody>{Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} cols={6} />)}</tbody>
          </table>
        </div>
      ) : (
        <div className="table-container">
          <table className="table" aria-label="Users list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Sessions</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => (
                <tr key={u.id}>
                  <td className="text-primary">{u.name}</td>
                  <td className="text-muted text-sm" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{u.email}</td>
                  <td><StatusBadge status={u.role} /></td>
                  <td>
                    {u.isDisabled
                      ? <span className="badge badge-danger">Disabled</span>
                      : u.lockedUntil && new Date(u.lockedUntil) > new Date()
                        ? <span className="badge badge-warning">Locked</span>
                        : <span className="badge badge-success">Active</span>
                    }
                  </td>
                  <td className="text-muted text-sm">{u.activeSessionsCount} active</td>
                  <td>
                    <div className="flex gap-1">
                      {u.isDisabled ? (
                        <button className="btn btn-success btn-sm" onClick={() => handleDisable(u.id, u.email, false)}
                          style={{ background: 'var(--color-success-subtle)', color: 'var(--color-success)', border: '1px solid rgba(16,185,129,0.2)' }}>
                          <Unlock size={12} /> Enable
                        </button>
                      ) : (
                        <button className="btn btn-danger btn-sm" onClick={() => handleDisable(u.id, u.email, true)}>
                          <Lock size={12} /> Disable
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => handleForceLogout(u.id, u.email)}>
                        <LogOut size={12} /> <span className="sr-only">Force logout {u.email}</span>
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setActivityUser({ id: u.id, name: u.name, email: u.email })} title={`View activity for ${u.email}`}>
                        <Activity size={12} /> Activity
                      </button>
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                        <button className="btn btn-ghost btn-sm" onClick={() => handleUnlock(u.id, u.email)} aria-label={`Unlock ${u.email}`} title={`Unlock ${u.email}`}>
                          <Unlock size={12} /> <span className="sr-only">Unlock {u.email}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!visibleUsers.length && <tr><td colSpan={6} className="text-muted text-sm" style={{ textAlign: 'center', padding: '2rem' }}>{users.length ? 'No users match these filters.' : 'No users are available.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={() => { refetch(); setShowCreate(false); }} />}
      {activityUser && (
        <div className="modal-overlay" role="dialog" aria-modal aria-labelledby="user-activity-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setActivityUser(null); }}>
          <div className="modal" style={{ width: 'min(760px, calc(100vw - 32px))' }}>
            <div className="modal-header">
              <div><h3 className="modal-title" id="user-activity-title">User activity</h3><p className="text-muted text-xs mt-1">{activityUser.name} · {activityUser.email}</p></div>
              <button className="btn btn-ghost btn-icon" onClick={() => setActivityUser(null)} aria-label="Close user activity"><X size={16} /></button>
            </div>
            <div className="modal-body">
              {activityLoading ? <div className="skeleton h-24 w-full" /> : activityError ? <div className="alert alert-danger"><XCircle size={14} />{activityError}</div> : activityData?.events.length ? (
                <div className="table-container">
                  <table className="table" aria-label="User activity events">
                    <thead><tr><th>When</th><th>Event</th><th>Action</th><th>Result</th><th>Details</th></tr></thead>
                    <tbody>{activityData.events.map((event) => <tr key={event.id}>
                      <td className="text-muted text-xs">{formatDate(event.created_at)}</td>
                      <td className="text-xs">{event.event_type}</td>
                      <td className="text-xs">{event.action}</td>
                      <td><StatusBadge status={event.status} /></td>
                      <td className="text-muted text-xs">{event.reason || event.target_id || '—'}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              ) : <div className="empty-state py-8"><div className="empty-state-icon"><Activity size={24} /></div><h3>No recorded activity</h3><p>Activity for this user will appear here.</p></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const addToast = useToast();
  const [form, setForm] = useState({ email: '', name: '', role: 'viewer', initialPassword: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.admin.createUser(form);
      addToast(`User ${form.email} created.`, 'success');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal aria-labelledby="create-user-modal-title">
      <div className="modal">
        <div className="modal-header">
          <h3 className="modal-title" id="create-user-modal-title">Create User</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close modal"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label" htmlFor="new-user-email">Email</label>
              <input id="new-user-email" type="email" className="form-input" required
                autoComplete="username"
                value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="new-user-name">Full Name</label>
              <input id="new-user-name" className="form-input" required minLength={2}
                autoComplete="name"
                value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="new-user-role">Role</label>
              <select id="new-user-role" className="form-select"
                value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                <option value="viewer">Viewer</option>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="new-user-password">Initial Password</label>
              <input id="new-user-password" type="password" className="form-input" required minLength={8}
                autoComplete="new-password"
                value={form.initialPassword} onChange={(e) => setForm((f) => ({ ...f, initialPassword: e.target.value }))} />
            </div>
            {error && <div className="alert alert-danger"><XCircle size={14} />{error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading} id="btn-confirm-create-user">
              {loading ? <><RefreshCw size={14} className="animate-spin" /> Creating…</> : <><Plus size={14} /> Create</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Audit Log View
// ============================================================

function AuditView() {
  const addToast = useToast();
  const [statusFilter, setStatusFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ isValid: boolean; totalRecords: number; message: string } | null>(null);

  const { data, loading, error, refetch } = useAsync(
    () => api.admin.audit({ page: String(page), pageSize: '50', ...(statusFilter ? { status: statusFilter } : {}), ...(eventTypeFilter ? { eventType: eventTypeFilter } : {}) }),
    [page, statusFilter, eventTypeFilter]
  );

  const events = data?.events || [];
  const pagination = data?.pagination;

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const result = await api.admin.verifyChain();
      setVerifyResult(result);
      addToast(result.isValid ? `Chain intact: ${result.totalRecords} records verified.` : `⚠️ Chain broken!`, result.isValid ? 'success' : 'error');
    } catch {
      addToast('Verification failed.', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const handleExport = async () => {
    try {
      await api.admin.exportCsv({ ...(statusFilter ? { status: statusFilter } : {}), ...(eventTypeFilter ? { eventType: eventTypeFilter } : {}) });
      addToast('CSV export downloaded.', 'success');
    } catch {
      addToast('Export failed.', 'error');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6" style={{ flexWrap: 'wrap', gap: 'var(--space-4)' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Audit Log</h2>
          <p className="text-muted text-sm mt-1">Tamper-evident hash-chained record of all events</p>
        </div>
        <div className="flex gap-3" style={{ flexWrap: 'wrap' }}>
          <select className="form-select" style={{ width: 175 }} value={eventTypeFilter}
            onChange={(e) => { setEventTypeFilter(e.target.value); setPage(1); }}
            id="audit-event-type-filter" aria-label="Filter by event type">
            <option value="">All event types</option>
            <option value="ACCESS_REQUEST">Access requests</option>
            <option value="ACCESS_DENIED">Access denials</option>
            <option value="AUTH_LOGIN">Sign-in activity</option>
            <option value="DOCUMENT_LIFECYCLE">Document activity</option>
            <option value="GRANT_LIFECYCLE">Permission grants</option>
            <option value="SHARE_LINK">Share links</option>
            <option value="USER_ADMIN">User administration</option>
            <option value="SECURITY_ALERT">Security alerts</option>
          </select>
          <select className="form-select" style={{ width: 140 }} value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            id="audit-status-filter" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="ALLOWED">Allowed</option>
            <option value="DENIED">Denied</option>
            <option value="ERROR">Error</option>
            <option value="INFO">Info</option>
          </select>
          <button className="btn btn-ghost btn-icon" onClick={refetch} aria-label="Refresh audit log"><RefreshCw size={16} /></button>
          <button className="btn btn-secondary" onClick={handleExport} id="btn-export-csv">
            <Download size={14} /> Export CSV
          </button>
          <button className="btn btn-secondary" onClick={handleVerify} disabled={verifying} id="btn-verify-chain">
            {verifying ? <><RefreshCw size={14} className="animate-spin" /> Verifying…</> : <><ShieldCheck size={14} /> Verify Chain</>}
          </button>
        </div>
      </div>

      {verifyResult && (
        <div className={`alert ${verifyResult.isValid ? 'alert-success' : 'alert-danger'} mb-6`}>
          {verifyResult.isValid ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
          <span>{verifyResult.message}</span>
        </div>
      )}

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertTriangle size={16} />
          <span>Could not load the audit log: {error}</span>
          <button className="btn btn-secondary btn-sm" onClick={refetch}>Retry</button>
        </div>
      ) : loading ? (
        <div className="table-container">
          <table className="table"><thead><tr><th>Seq</th><th>Time</th><th>Actor</th><th>Action</th><th>Status</th><th>Target</th></tr></thead>
            <tbody>{Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={6} />)}</tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table className="table" aria-label="Audit events">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-muted)' }}>No events</td></tr>
                ) : events.map((e) => (
                  <tr key={e.id}>
                    <td className="font-mono text-muted" style={{ fontSize: '0.75rem' }}>#{e.sequenceNumber}</td>
                    <td className="text-muted text-xs">{formatDate(e.createdAt)}</td>
                    <td style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.actorEmail || '—'}
                    </td>
                    <td className="text-primary text-sm">{e.action}</td>
                    <td><StatusBadge status={e.status} /></td>
                    <td className="text-muted text-xs" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.reason || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-muted">
                Showing {((page - 1) * 50) + 1}–{Math.min(page * 50, pagination.total)} of {pagination.total} events
              </span>
              <div className="flex gap-2">
                <button className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <button className="btn btn-secondary btn-sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// Dashboard View
// ============================================================

function DashboardView({ user, onNavigate }: { user: User; onNavigate: (view: View, docId?: string) => void }) {
  const { data: docsData, loading: docsLoading } = useAsync(() => api.documents.list(), []);
  const { data: dashData, loading: dashLoading } = useAsync(() =>
    user.role === 'admin' ? api.admin.dashboard() : Promise.resolve(null), [user.role]);
  const { data: accessRequestsData } = useAsync(() =>
    user.role === 'owner' ? api.accessRequests.listPending() : Promise.resolve(null), [user.role]);
  const { data: myRequestsData } = useAsync(() =>
    user.role === 'viewer' ? api.accessRequests.listMine() : Promise.resolve(null), [user.role]);
  const { data: chainData } = useAsync(() =>
    user.role === 'admin' ? api.admin.verifyChain() : Promise.resolve(null), [user.role]);

  const docs = docsData?.documents || [];
  const pendingRequests = accessRequestsData?.requests || [];
  const myRequests = myRequestsData?.requests || [];
  const myPendingRequests = myRequests.filter((request) => request.status === 'pending');
  const alerts = dashData?.alerts;
  const totalAlerts = alerts ? Object.values(alerts).reduce((sum, arr) => sum + arr.length, 0) : 0;
  const firstName = user.name.split(' ')[0];
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const workspace = user.email.split('@')[1]?.split('.')[0] || 'workspace';
  const recentDocs = [...docs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);

  return (
    <div className="dashboard-page">
      <div className="dashboard-welcome">
        <div><div className="eyebrow"><span className="eyebrow-dot" /> {workspace.toUpperCase()} WORKSPACE <span className="welcome-separator">/</span> {user.role.toUpperCase()}</div><h1>{greeting}, {firstName}.</h1><p>Your documents, permissions, and security activity in one place.</p></div>
        <div className="welcome-actions"><span className="welcome-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>{user.role === 'owner' && <><button className="button button-dark" type="button" onClick={() => onNavigate('access-requests')}><Key size={14} /> Requests{pendingRequests.length > 0 ? ` · ${pendingRequests.length}` : ''}</button><button className="button button-accent" type="button" onClick={() => onNavigate('upload')}><Plus size={15} /> Add a document</button></>}{user.role === 'viewer' && <button className="button button-accent" type="button" onClick={() => onNavigate('my-requests')}><Key size={14} /> My access requests</button>}</div>
      </div>

      <div className="dashboard-stats">
        <article className="stat-card"><div className="stat-top"><span>DOCUMENTS YOU CAN ACCESS</span><FileText size={17} /></div><strong>{docsLoading ? '—' : docs.length.toString().padStart(2, '0')}</strong><div className="stat-bottom"><span className="stat-pip" /> Scoped to your permissions</div></article>
        <article className="stat-card"><div className="stat-top"><span>{user.role === 'owner' ? 'REQUESTS TO REVIEW' : user.role === 'admin' ? 'SECURITY SIGNALS' : 'MY ACCESS REQUESTS'}</span>{user.role === 'admin' ? <Activity size={17} /> : <Key size={17} />}</div><strong>{user.role === 'owner' ? pendingRequests.length.toString().padStart(2, '0') : user.role === 'admin' ? (dashLoading ? '—' : totalAlerts.toString().padStart(2, '0')) : myRequestsData ? myPendingRequests.length.toString().padStart(2, '0') : '—'}</strong><div className="stat-bottom"><span className={`stat-pip ${user.role === 'admin' && totalAlerts > 0 || user.role === 'owner' && pendingRequests.length > 0 || user.role === 'viewer' && myPendingRequests.length > 0 ? 'pip-warn' : ''}`} />{user.role === 'owner' ? 'Awaiting an owner decision' : user.role === 'admin' ? (totalAlerts ? 'Needs your attention' : 'No unusual activity detected') : `${myPendingRequests.length} awaiting review · ${myRequests.length - myPendingRequests.length} decided`}</div></article>
        <article className="stat-card stat-card-accent"><div className="stat-top"><span>ACCESS POLICY</span><ShieldCheck size={17} /></div><strong>Enforced</strong><div className="stat-bottom"><span className="stat-pip" /> Checked each time a file is opened</div></article>
      </div>

      <div className="dashboard-content-grid">
        <section className="recent-panel">
          <div className="panel-heading"><div><span className="panel-kicker">YOUR SECURE LIBRARY</span><h2>Recently updated</h2></div><button className="panel-link" type="button" onClick={() => onNavigate('documents')}>View all <ArrowRight size={14} /></button></div>
          {docsLoading ? <div className="document-loading"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div> : recentDocs.length ? (
            <div className="recent-list">{recentDocs.map((doc, index) => <button className="recent-document" type="button" key={doc.id} onClick={() => onNavigate('doc-detail', doc.id)}><span className={`document-type-mark type-${index % 3}`}><FileText size={17} strokeWidth={1.7} /></span><span className="recent-document-main"><strong>{doc.title}</strong><small>{doc.category || 'General'} <i /> Updated {formatDate(doc.updatedAt)}</small></span><span className="permission-pill"><span /> {doc.effectivePermission || 'secured'}</span><ArrowUpRight className="document-open" size={16} /></button>)}</div>
          ) : <div className="dashboard-empty"><div className="empty-glyph"><FileCheck size={20} /></div><strong>Your secure library is ready.</strong><p>Documents shared with you will appear here, with access checked every time.</p>{user.role === 'owner' && <button className="panel-link" type="button" onClick={() => onNavigate('upload')}>Add your first document <ArrowRight size={14} /></button>}</div>}
          <div className="library-footer"><span><Lock size={12} /> CONTENT ENCRYPTED AT REST</span><span>{docs.length.toString().padStart(2, '0')} RECORDS IN VIEW</span></div>
        </section>

        <aside className="posture-panel">
          <div className="posture-top"><span className="posture-emblem"><Shield size={20} strokeWidth={1.5} /></span><span className="posture-live"><i /> ACTIVE</span></div>
          <span className="panel-kicker">TRUST POSTURE</span><h2>Your boundary<br />is in force.</h2><p>Every file request is evaluated against the current session and explicit workspace grants.</p>
          <div className="posture-rule" />
          <div className="posture-checks"><div><CheckCircle size={15} /><span>Identity verified</span><small>SESSION</small></div><div><CheckCircle size={15} /><span>Policy at stream time</span><small>LIVE</small></div><div><CheckCircle size={15} className={chainData?.isValid === false ? 'check-broken' : ''} /><span>{user.role === 'admin' && chainData ? (chainData.isValid ? 'Audit chain verified' : 'Audit chain needs review') : 'Actions become auditable'}</span><small>{user.role === 'admin' && chainData ? (chainData.isValid ? 'SHA-256' : 'CHECK') : 'LEDGER'}</small></div></div>
          <div className="posture-footer"><Fingerprint size={15} /><span>ZERO-TRUST BY DEFAULT</span><span className="posture-id">TV—{user.id.slice(0, 6).toUpperCase()}</span></div>
        </aside>
      </div>

      {user.role === 'owner' && pendingRequests.length > 0 && <section className="request-preview"><div className="panel-heading"><div><span className="panel-kicker">NEEDS YOUR DECISION</span><h2>Access requests <span className="request-count">{pendingRequests.length}</span></h2></div><button className="panel-link" type="button" onClick={() => onNavigate('access-requests')}>Review requests <ArrowRight size={14} /></button></div><div className="request-preview-row">{pendingRequests.slice(0, 3).map((request) => <div key={request.id}><span className="request-avatar">{request.requesterEmail.slice(0, 1).toUpperCase()}</span><span><strong>{request.requesterEmail}</strong><small>Requests {request.targetPermission} access to <b>{request.documentTitle || 'a document'}</b></small></span><span className="request-pending">PENDING</span></div>)}</div></section>}

      {user.role === 'viewer' && myRequests.length > 0 && <section className="request-preview"><div className="panel-heading"><div><span className="panel-kicker">YOUR ACCESS ACTIVITY</span><h2>Request updates</h2></div><button className="panel-link" type="button" onClick={() => onNavigate('my-requests')}>Open history <ArrowRight size={14} /></button></div><div className="request-preview-row">{myRequests.slice(0, 3).map((request) => <div key={request.id}><span className="request-avatar"><FileText size={14} /></span><span><strong>{request.documentTitle}</strong><small>{request.targetPermission} · {request.status === 'pending' ? 'Waiting for owner review' : `Reviewed ${request.reviewedAt ? formatDate(request.reviewedAt) : formatDate(request.createdAt)}`}</small></span><StatusBadge status={request.status} /></div>)}</div></section>}

      {user.role === 'admin' && alerts && totalAlerts > 0 && <section className="dashboard-alerts"><div className="panel-heading"><div><span className="panel-kicker">ADMINISTRATOR REVIEW</span><h2>Security signals</h2></div><span className="alert-count">{totalAlerts} to review</span></div>{Object.entries(alerts).flatMap(([key, items]) => (items as any[]).map((item: any, index) => <div className="dashboard-alert-row" key={`${key}-${index}`}><AlertTriangle size={15} /><span><strong>{item.label}</strong><small>{item.actorEmail || 'Workspace activity'}{item.latestAt ? ` · ${formatDate(item.latestAt)}` : ''}</small></span><span>{key.replace(/([A-Z])/g, ' $1')}</span></div>))}</section>}
    </div>
  );
}
// ============================================================
// Access Requests View
// ============================================================

function AccessRequestsView() {
  const addToast = useToast();
  const { data, loading, error, refetch } = useAsync(() => api.accessRequests.listOwned(), []);
  const requests = data?.requests || [];
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'denied'>('pending');
  const [search, setSearch] = useState('');
  const [reviewDraft, setReviewDraft] = useState<{ request: AccessRequest; decision: 'approve' | 'deny' } | null>(null);
  const [grantPermission, setGrantPermission] = useState<'read' | 'edit'>('read');
  const [grantExpiry, setGrantExpiry] = useState<'never' | '1d' | '7d' | '30d'>('never');
  const [reviewerNotes, setReviewerNotes] = useState('');
  const [savingReview, setSavingReview] = useState(false);

  const counts = {
    pending: requests.filter((request) => request.status === 'pending').length,
    approved: requests.filter((request) => request.status === 'approved').length,
    denied: requests.filter((request) => request.status === 'denied').length,
  };
  const visibleRequests = requests.filter((request) => {
    const matchesStatus = filter === 'all' || request.status === filter;
    const text = `${request.documentTitle} ${request.requesterName} ${request.requesterEmail} ${request.documentId}`.toLowerCase();
    return matchesStatus && text.includes(search.trim().toLowerCase());
  });

  const openReview = (request: AccessRequest, decision: 'approve' | 'deny') => {
    setReviewDraft({ request, decision });
    setGrantPermission(request.targetPermission);
    setGrantExpiry('never');
    setReviewerNotes('');
  };

  const handleReview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reviewDraft) return;
    const expiryDurations: Record<Exclude<typeof grantExpiry, 'never'>, number> = {
      '1d': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const expiresAt = grantExpiry === 'never' ? null : new Date(Date.now() + expiryDurations[grantExpiry]).toISOString();
    setSavingReview(true);
    try {
      const result = await api.accessRequests.review(
        reviewDraft.request.id,
        reviewDraft.decision,
        grantPermission,
        expiresAt,
        reviewerNotes.trim() || null
      );
      addToast(result.message, reviewDraft.decision === 'approve' ? 'success' : 'info');
      setReviewDraft(null);
      await refetch();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not record the decision.', 'error');
    } finally {
      setSavingReview(false);
    }
  };

  return (
    <div className="access-request-page animate-fade-in">
      <div className="access-request-header">
        <div><span className="panel-kicker">OWNER WORKSPACE</span><h1>Access Requests</h1><p>Review requests for documents you own, set a grant scope, and keep a record of each decision.</p></div>
        <button className="btn btn-ghost btn-icon" onClick={refetch} aria-label="Refresh access requests" title="Refresh"><RefreshCw size={16} /></button>
      </div>

      <div className="request-summary-grid" aria-label="Access request totals">
        <article className="request-summary-card"><span>Awaiting decision</span><strong>{loading ? '—' : counts.pending}</strong><small>Requests still in your queue</small></article>
        <article className="request-summary-card"><span>Approved</span><strong>{loading ? '—' : counts.approved}</strong><small>Access grants issued</small></article>
        <article className="request-summary-card"><span>Denied</span><strong>{loading ? '—' : counts.denied}</strong><small>Decision history retained</small></article>
      </div>

      <section className="request-panel">
        <div className="request-toolbar">
          <div className="request-filter-buttons" role="tablist" aria-label="Filter access requests">
            {(['pending', 'all', 'approved', 'denied'] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>
                {value === 'all' ? 'All requests' : value[0].toUpperCase() + value.slice(1)}{value === 'pending' ? ` · ${counts.pending}` : ''}
              </button>
            ))}
          </div>
          <label className="request-search"><Search size={15} aria-hidden /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search requester or document" aria-label="Search access requests" /></label>
        </div>

        {error && <div className="alert alert-danger" role="alert"><XCircle size={14} />{error}<button className="btn btn-ghost btn-sm" onClick={refetch}>Retry</button></div>}
        {loading ? <div className="request-history-list">{Array.from({ length: 3 }).map((_, index) => <div className="skeleton h-20 w-full" key={index} />)}</div> : visibleRequests.length === 0 ? (
          <div className="empty-state py-10"><div className="empty-state-icon"><CheckCircle size={26} /></div><h3>{requests.length === 0 ? 'No access requests yet' : 'No matching requests'}</h3><p>{requests.length === 0 ? 'Requests for your documents will appear here.' : 'Try another status or search term.'}</p></div>
        ) : (
          <div className="request-history-list">
            {visibleRequests.map((request) => (
              <article className="request-history-card" key={request.id}>
                <div className="request-history-top">
                  <span className="request-document-icon"><FileText size={17} /></span>
                  <div className="request-history-title"><strong>{request.documentTitle}</strong><span>{request.requesterName} · {request.requesterEmail}</span></div>
                  <StatusBadge status={request.status} />
                </div>
                <div className="request-history-meta"><span><Key size={13} /> Requests <b>{request.targetPermission}</b></span><span><Clock size={13} /> Sent {formatDate(request.createdAt)}</span>{request.reviewedAt && <span><CheckCircle size={13} /> Decided {formatDate(request.reviewedAt)}</span>}</div>
                {request.status === 'pending' ? (
                  <div className="request-history-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => openReview(request, 'approve')}><CheckCircle size={13} /> Review & approve</button>
                    <button className="btn btn-danger btn-sm" onClick={() => openReview(request, 'deny')}><XCircle size={13} /> Deny</button>
                  </div>
                ) : (
                  <div className="request-decision-note"><span>{request.reviewerName ? `Reviewed by ${request.reviewerName}` : 'Decision recorded'}</span>{request.reviewerNotes && <p>{request.reviewerNotes}</p>}{request.currentAccessStatus === 'active' && <small>Current grant: {request.currentGrantPermission}{request.currentGrantExpiresAt ? ` · expires ${formatDate(request.currentGrantExpiresAt)}` : ' · no expiry'}</small>}</div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {reviewDraft && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="access-review-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingReview) setReviewDraft(null); }}>
          <div className="modal">
            <div className="modal-header"><div><h2 className="modal-title" id="access-review-title">{reviewDraft.decision === 'approve' ? 'Approve access request' : 'Deny access request'}</h2><p className="text-muted text-xs mt-1">{reviewDraft.request.documentTitle} · {reviewDraft.request.requesterEmail}</p></div><button className="btn btn-ghost btn-icon" type="button" onClick={() => setReviewDraft(null)} disabled={savingReview} aria-label="Close review"><X size={16} /></button></div>
            <form onSubmit={handleReview}>
              <div className="modal-body space-y-4">
                {reviewDraft.decision === 'approve' && <>
                  <label className="form-group"><span className="form-label">Grant permission</span><select className="form-select" value={grantPermission} onChange={(event) => setGrantPermission(event.target.value as 'read' | 'edit')}><option value="read">Read only</option><option value="edit">Read and edit</option></select></label>
                  <label className="form-group"><span className="form-label">Grant expires</span><select className="form-select" value={grantExpiry} onChange={(event) => setGrantExpiry(event.target.value as typeof grantExpiry)}><option value="never">No expiry</option><option value="1d">In 24 hours</option><option value="7d">In 7 days</option><option value="30d">In 30 days</option></select></label>
                </>}
                <label className="form-group"><span className="form-label">Note to requester <span className="text-muted">(optional)</span></span><textarea className="form-input" maxLength={500} rows={3} value={reviewerNotes} onChange={(event) => setReviewerNotes(event.target.value)} placeholder={reviewDraft.decision === 'approve' ? 'Add context about this grant' : 'Explain what the requester can do next'} /></label>
              </div>
              <div className="modal-footer"><button type="button" className="btn btn-ghost" onClick={() => setReviewDraft(null)} disabled={savingReview}>Cancel</button><button type="submit" className={reviewDraft.decision === 'approve' ? 'btn btn-primary' : 'btn btn-danger'} disabled={savingReview}>{savingReview ? <><RefreshCw size={14} className="animate-spin" /> Saving…</> : reviewDraft.decision === 'approve' ? <><CheckCircle size={14} /> Issue grant</> : <><XCircle size={14} /> Record denial</>}</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function MyAccessRequestsView({ onOpenDocument, initialDocumentId }: { onOpenDocument: (documentId: string) => void; initialDocumentId?: string | null }) {
  const addToast = useToast();
  const [activeTab, setActiveTab] = useState<'catalog' | 'form' | 'history'>(initialDocumentId ? 'form' : 'catalog');
  const [documentReference, setDocumentReference] = useState(initialDocumentId || '');
  const [permission, setPermission] = useState<'read' | 'edit'>('read');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'denied'>('all');
  const [search, setSearch] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('');
  const [requestingDocId, setRequestingDocId] = useState<string | null>(null);
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);

  const { data, loading, error, refetch } = useAsync(() => api.accessRequests.listMine(), []);
  const { data: catalogData, loading: catalogLoading, error: catalogError, refetch: refetchCatalog } = useAsync(
    () => api.documents.catalog(),
    []
  );

  const requests = data?.requests || [];
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const approvedCount = requests.filter((r) => r.status === 'approved').length;
  const deniedCount = requests.filter((r) => r.status === 'denied').length;
  const visibleRequests = requests.filter((request) => {
    const matchesStatus = filter === 'all' || request.status === filter;
    const text = `${request.documentTitle} ${request.documentId} ${request.documentOwnerName || ''} ${request.documentOwnerEmail || ''}`.toLowerCase();
    return matchesStatus && text.includes(search.trim().toLowerCase());
  });

  const catalogDocs: CatalogDocument[] = catalogData?.documents || [];
  const catalogCategories = [...new Set(catalogDocs.map((d) => d.category).filter(Boolean))].sort();
  const visibleCatalog = catalogDocs.filter((d) => {
    const matchesCat = !catalogCategory || d.category === catalogCategory;
    const matchesSearch = !catalogSearch.trim() || d.title.toLowerCase().includes(catalogSearch.trim().toLowerCase());
    return matchesCat && matchesSearch;
  });

  // Track which documents already have a pending request by the viewer
  const pendingDocIds = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.documentId));

  const requestAccessFromCatalog = async (doc: CatalogDocument, perm: 'read' | 'edit' = 'read') => {
    setRequestingDocId(doc.id);
    try {
      const result = await api.accessRequests.submit(doc.id, perm);
      addToast(result.message, 'success');
      await refetch();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not submit the access request.', 'error');
    } finally {
      setRequestingDocId(null);
    }
  };

  const submitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const documentId = documentReference.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
    if (!documentId) {
      setFormError('Enter a valid document UUID or a document link containing its UUID.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const result = await api.accessRequests.submit(documentId, permission);
      addToast(result.message, 'success');
      setDocumentReference('');
      await refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not submit the request.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="access-request-page animate-fade-in">
      <div className="access-request-header">
        <div>
          <span className="panel-kicker">VIEWER WORKSPACE</span>
          <h1>My Access Requests</h1>
          <p>Browse available documents and request access, or track the status of your existing requests.</p>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={() => { refetch(); refetchCatalog(); }} aria-label="Refresh" title="Refresh"><RefreshCw size={16} /></button>
      </div>

      {/* Summary cards */}
      <div className="request-summary-grid" aria-label="My access request totals">
        <article className="request-summary-card">
          <span>Available documents</span>
          <strong>{catalogLoading ? '—' : catalogDocs.length}</strong>
          <small>In your organization</small>
        </article>
        <article className="request-summary-card">
          <span>Waiting for review</span>
          <strong>{loading ? '—' : pendingCount}</strong>
          <small>Pending with a document owner</small>
        </article>
        <article className="request-summary-card">
          <span>Decisions recorded</span>
          <strong>{loading ? '—' : approvedCount + deniedCount}</strong>
          <small>{approvedCount} approved · {deniedCount} denied</small>
        </article>
      </div>

      {/* Tab navigation */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--color-border)', marginBottom: '1.5rem' }}>
        {(
          [['catalog', 'Browse Documents', <FileText size={14} />],
           ['form', 'Request by ID', <Key size={14} />],
           ['history', `History · ${requests.length}`, <Clock size={14} />]] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '10px 16px', fontSize: '0.8125rem', fontWeight: 600,
              border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
              transition: 'all 0.15s',
              background: activeTab === id ? 'var(--color-surface-2)' : 'transparent',
              color: activeTab === id ? 'var(--color-accent)' : 'var(--color-text-muted)',
              borderBottom: activeTab === id ? '2px solid var(--color-accent)' : '2px solid transparent',
            }}
            aria-selected={activeTab === id}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {/* ── TAB: Browse Catalog ── */}
      {activeTab === 'catalog' && (
        <section className="request-panel" style={{ background: 'none', boxShadow: 'none', padding: 0 }}>
          {/* Filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '1rem', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 220px' }}>
              <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', pointerEvents: 'none' }} aria-hidden />
              <input
                style={{ paddingLeft: 36, width: '100%' }}
                className="vault-input"
                placeholder="Search documents…"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                aria-label="Search catalog"
              />
            </div>
            <select
              className="vault-input"
              style={{ flex: '0 0 180px' }}
              value={catalogCategory}
              onChange={(e) => setCatalogCategory(e.target.value)}
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {catalogCategories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
            </select>
            <button className="btn-vault-secondary" style={{ whiteSpace: 'nowrap' }} onClick={refetchCatalog} type="button">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>

          {catalogError && (
            <div className="alert alert-danger" role="alert"><XCircle size={14} />{catalogError}<button className="btn btn-ghost btn-sm" onClick={refetchCatalog}>Retry</button></div>
          )}

          {catalogLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 72, borderRadius: 10 }} />)}
            </div>
          ) : visibleCatalog.length === 0 ? (
            <div className="empty-state py-10">
              <div className="empty-state-icon"><FileText size={26} /></div>
              <h3>{catalogDocs.length === 0 ? 'No documents in workspace yet' : 'No matching documents'}</h3>
              <p>{catalogDocs.length === 0 ? 'Owners haven\'t uploaded any documents yet.' : 'Try a different search or category.'}</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {visibleCatalog.map((doc) => {
                const isPending = pendingDocIds.has(doc.id);
                const isRequesting = requestingDocId === doc.id;
                return (
                  <div
                    key={doc.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 16,
                      padding: '14px 18px',
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 10,
                      transition: 'border-color 0.15s',
                    }}
                  >
                    {/* File icon */}
                    <div style={{
                      width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                      background: doc.hasAccess ? 'rgba(52,211,153,0.12)' : 'var(--color-surface-3)',
                      border: `1px solid ${doc.hasAccess ? 'rgba(52,211,153,0.3)' : 'var(--color-border)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: doc.hasAccess ? 'var(--color-success)' : 'var(--color-text-muted)',
                    }}>
                      <FileText size={17} />
                    </div>

                    {/* Doc info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: '0.875rem' }}>{doc.title}</span>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px',
                          borderRadius: 99, letterSpacing: '0.03em',
                          background: 'var(--color-surface-3)', color: 'var(--color-text-muted)',
                          border: '1px solid var(--color-border)',
                        }}>{doc.category}</span>
                        {doc.hasAccess && (
                          <span style={{
                            fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px',
                            borderRadius: 99, background: 'rgba(52,211,153,0.15)',
                            color: 'var(--color-success)', border: '1px solid rgba(52,211,153,0.3)',
                          }}>
                            <ShieldCheck size={10} style={{ display: 'inline', marginRight: 3 }} />
                            {doc.myPermission === 'owner' ? 'You own this' : `${doc.myPermission} access`}
                          </span>
                        )}
                        {isPending && !doc.hasAccess && (
                          <span style={{
                            fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px',
                            borderRadius: 99, background: 'rgba(251,191,36,0.15)',
                            color: 'var(--color-warning)', border: '1px solid rgba(251,191,36,0.3)',
                          }}>
                            <Clock size={10} style={{ display: 'inline', marginRight: 3 }} /> Pending
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                        Owner: {doc.ownerName} · {doc.ownerEmail}
                        {doc.description && <span style={{ marginLeft: 8 }}>— {doc.description.slice(0, 60)}{doc.description.length > 60 ? '…' : ''}</span>}
                      </div>
                    </div>

                    {/* Action */}
                    <div style={{ flexShrink: 0 }}>
                      {doc.hasAccess ? (
                        doc.myPermission !== 'owner' ? (
                          <button
                            className="btn-vault-secondary"
                            style={{ fontSize: '0.75rem', padding: '6px 12px' }}
                            onClick={() => onOpenDocument(doc.id)}
                          >
                            <Eye size={13} /> Open
                          </button>
                        ) : null
                      ) : isPending ? (
                        <button className="btn-vault-secondary" style={{ fontSize: '0.75rem', padding: '6px 12px' }} disabled>
                          <Clock size={13} /> Pending
                        </button>
                      ) : (
                        <button
                          className="btn-vault-primary"
                          style={{ fontSize: '0.75rem', padding: '6px 14px' }}
                          disabled={isRequesting}
                          onClick={() => requestAccessFromCatalog(doc, 'read')}
                        >
                          {isRequesting ? <><RefreshCw size={13} className="animate-spin" /> Sending…</> : <><Key size={13} /> Request Access</>}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ── TAB: Request by Document ID ── */}
      {activeTab === 'form' && (
        <form onSubmit={submitRequest} className="request-panel request-create-panel">
          <div className="request-panel-heading">
            <span className="request-panel-icon"><Key size={17} /></span>
            <div>
              <h2>Request by document ID</h2>
              <p>{initialDocumentId ? "The owner's request link filled in the document for you. Submit below to send your request." : 'Paste the document ID or request link shared by its owner.'}</p>
            </div>
          </div>
          <div className="request-form-grid">
            <label className="request-search-field">
              <span>Document ID or link</span>
              <input aria-label="Document ID or link" value={documentReference} onChange={(e) => setDocumentReference(e.target.value)} placeholder="Paste the document ID or link" required />
            </label>
            <label className="request-search-field">
              <span>Permission needed</span>
              <select aria-label="Requested permission" value={permission} onChange={(e) => setPermission(e.target.value as 'read' | 'edit')}>
                <option value="read">Read access</option>
                <option value="edit">Edit access</option>
              </select>
            </label>
            <button type="submit" className="btn-vault-primary request-submit-button" disabled={submitting}>
              {submitting ? <><RefreshCw size={14} className="animate-spin" /> Sending…</> : <><Key size={14} /> Submit request</>}
            </button>
          </div>
          <p className="request-privacy-note"><ShieldCheck size={13} /> For privacy, the confirmation does not reveal whether a document ID exists in another workspace.</p>
          {formError && <div className="alert alert-danger" role="alert"><XCircle size={14} />{formError}</div>}
        </form>
      )}

      {/* ── TAB: Request History ── */}
      {activeTab === 'history' && (
        <section className="request-panel">
          <div className="request-panel-heading request-history-heading">
            <div><span className="panel-kicker">PRIVATE TO YOUR ACCOUNT</span><h2>Request history</h2></div>
            <span className="request-total">{loading ? 'Loading…' : `${requests.length} request${requests.length === 1 ? '' : 's'}`}</span>
          </div>
          <div className="request-toolbar">
            <div className="request-filter-buttons" role="tablist" aria-label="Filter my access requests">
              {(['all', 'pending', 'approved', 'denied'] as const).map((value) => {
                const count = value === 'all' ? requests.length : requests.filter((r) => r.status === value).length;
                return (
                  <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>
                    {value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1)} <span>{count}</span>
                  </button>
                );
              })}
            </div>
            <label className="request-search">
              <Search size={15} aria-hidden />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a document or owner" aria-label="Search my requests" />
            </label>
          </div>

          {error && <div className="alert alert-danger" role="alert"><XCircle size={14} />{error}<button className="btn btn-ghost btn-sm" onClick={refetch}>Retry</button></div>}
          {loading ? (
            <div className="request-history-list">{Array.from({ length: 3 }).map((_, i) => <div className="skeleton h-20 w-full" key={i} />)}</div>
          ) : visibleRequests.length === 0 ? (
            <div className="empty-state py-10">
              <div className="empty-state-icon"><Clock size={25} /></div>
              <h3>{requests.length === 0 ? 'No requests yet' : 'No matching requests'}</h3>
              <p>{requests.length === 0 ? 'Browse the catalog and request access to get started.' : 'Try another status or search term.'}</p>
              {requests.length === 0 && <button className="btn-vault-primary mt-4" onClick={() => setActiveTab('catalog')}><FileText size={14} /> Browse documents</button>}
            </div>
          ) : (
            <div className="request-history-list">
              {visibleRequests.map((request) => {
                const expanded = expandedRequest === request.id;
                const accessDescription = request.currentAccessStatus === 'active'
                  ? `Active ${request.currentGrantPermission || 'read'} grant${request.currentGrantExpiresAt ? ` · expires ${formatDate(request.currentGrantExpiresAt)}` : ' · no expiry'}`
                  : request.currentAccessStatus === 'expired'
                    ? `Grant expired ${request.currentGrantExpiresAt ? `on ${formatDate(request.currentGrantExpiresAt)}` : ''}`
                    : request.currentAccessStatus === 'unavailable'
                      ? 'Document is archived and unavailable'
                      : request.status === 'approved'
                        ? 'No active grant is attached to this request'
                        : request.status === 'denied' ? 'No access grant was issued' : 'Waiting for the document owner';
                return (
                  <article className="request-history-card" key={request.id}>
                    <div className="request-history-top">
                      <span className="request-document-icon"><FileText size={17} /></span>
                      <button className="request-history-title request-history-toggle" type="button" aria-expanded={expanded} onClick={() => setExpandedRequest(expanded ? null : request.id)}>
                        <strong>{request.documentTitle}</strong>
                        <span>{request.documentOwnerName || 'Document owner'} · {request.documentOwnerEmail || 'Workspace owner'}</span>
                      </button>
                      <StatusBadge status={request.status} />
                    </div>
                    <div className="request-history-meta">
                      <span><Key size={13} /> Requested <b>{request.targetPermission}</b></span>
                      <span><Clock size={13} /> Sent {formatDate(request.createdAt)}</span>
                      <span className={request.currentAccessStatus === 'active' ? 'request-access-active' : ''}>
                        <ShieldCheck size={13} /> {accessDescription}
                      </span>
                    </div>
                    {expanded && (
                      <div className="request-detail-grid">
                        <div><span>Request ID</span><code>{request.id}</code></div>
                        <div><span>Document ID</span><code>{request.documentId}</code></div>
                        <div><span>Owner</span><strong>{request.documentOwnerName || 'Workspace owner'}<small>{request.documentOwnerEmail}</small></strong></div>
                        <div><span>Decision</span><strong>{request.status === 'pending' ? 'Awaiting review' : `${request.status[0].toUpperCase()}${request.status.slice(1)}${request.reviewedAt ? ` · ${formatDate(request.reviewedAt)}` : ''}`}{request.reviewerName && <small>By {request.reviewerName}</small>}</strong></div>
                        {request.reviewerNotes && <div className="request-reviewer-note"><span>Owner note</span><p>{request.reviewerNotes}</p></div>}
                        <div className="request-detail-actions">
                          {request.currentAccessStatus === 'active' && !request.documentDeleted && (
                            <button className="btn-vault-primary" type="button" onClick={() => onOpenDocument(request.documentId)}><Eye size={13} /> Open document</button>
                          )}
                          <button className="btn-vault-secondary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(request.documentId); addToast('Document ID copied.', 'success'); } catch { addToast('Clipboard access is unavailable.', 'warning'); } }}><Copy size={13} /> Copy document ID</button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ============================================================
// Main App
// ============================================================

function AppShell({ initialUser, initialRequestDocumentId, onRequestLinkHandled }: { initialUser: User; initialRequestDocumentId?: string | null; onRequestLinkHandled: () => void }) {
  const [user, setUser] = useState<User>(initialUser);
  const [view, setView] = useState<View>(initialRequestDocumentId && initialUser.role === 'viewer' ? 'my-requests' : 'dashboard');
  const [activeDocId, setActiveDocId] = useState<string | undefined>();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [docs, setDocs] = useState<Document[]>([]);

  useEffect(() => {
    setUser(initialUser);
  }, [initialUser]);

  useEffect(() => {
    if (!initialRequestDocumentId) return;
    onRequestLinkHandled();
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#/`);
  }, []);

  // Fetch docs for command palette
  useEffect(() => {
    api.documents.list().then((r) => setDocs(r.documents)).catch(() => {});
  }, []);

  // Global keyboard shortcut: Ctrl+K / Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette((s) => !s);
      }
      if (e.key === 'Escape') setShowCommandPalette(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleNavigate = (v: View | string, docId?: string) => {
    setView(v as View);
    if (docId) setActiveDocId(docId);
  };

  const renderView = () => {
    switch (view) {
      case 'dashboard': return <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'documents': return <DocumentsView onNavigate={(v, id) => { setView(v); if (id) setActiveDocId(id); }} />;
      case 'doc-detail': return activeDocId
        ? <DocumentDetailView docId={activeDocId} onBack={() => setView('documents')} />
        : <DocumentsView onNavigate={(v, id) => { setView(v); if (id) setActiveDocId(id); }} />;
      case 'upload': return user.role === 'owner' ? <UploadView onUploaded={() => setView('documents')} /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'users': return user.role === 'admin' ? <UsersView /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'audit': return user.role === 'admin' ? <AuditView /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'access-requests': return user.role === 'owner' ? <AccessRequestsView /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'my-requests': return user.role === 'viewer' ? <MyAccessRequestsView initialDocumentId={initialRequestDocumentId} onOpenDocument={(id) => handleNavigate('doc-detail', id)} /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      default: return <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
    }
  };

  return (
    <div className="app-layout">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <Sidebar active={view} onNavigate={(v) => setView(v)} user={user} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <header className="app-header">
            <div className="flex items-center gap-3">
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setShowCommandPalette(true)}
                aria-label="Open command palette (Ctrl+K)"
                title="Command palette (Ctrl+K)"
                id="btn-command-palette"
              >
                <Search size={16} />
              </button>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                background: 'var(--color-bg-input)', border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)', padding: '6px 14px', cursor: 'pointer',
                fontSize: '0.8125rem', color: 'var(--color-text-muted)',
              }}
                onClick={() => setShowCommandPalette(true)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setShowCommandPalette(true); }}
                aria-label="Search (Ctrl+K)"
              >
                <span>Search cryptographic index…</span>
                <kbd className="kbd" style={{ marginLeft: 8 }}>Ctrl+K</kbd>
              </div>
            </div>
            <div className="header-account">
              <ThemeToggle />
              <span className="badge badge-accent" style={{ fontSize: '0.72rem' }}>{user.role}</span>
              <span className="header-account-email">{user.email}</span>
            </div>
          </header>

          <main className="app-main" id="main-content" role="main" tabIndex={-1}>
            {renderView()}
          </main>
        </div>

        {showCommandPalette && (
          <CommandPalette
            onClose={() => setShowCommandPalette(false)}
            onNavigate={(v, id) => { handleNavigate(v, id); setShowCommandPalette(false); }}
            documents={docs}
            user={user}
          />
        )}
    </div>
  );
}

// ============================================================
// Root
// ============================================================

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('trustvault-theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [publicPage, setPublicPage] = useState<'home' | 'login' | 'signup'>(() => {
    const route = window.location.hash.split('?')[0];
    if (route === '#/signup') return 'signup';
    return route === '#/login' ? 'login' : 'home';
  });
  const [requestDocumentId, setRequestDocumentId] = useState<string | null>(() =>
    new URLSearchParams(window.location.hash.split('?')[1] || '').get('request')
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('trustvault-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.title = 'TrustVault — Trust, built into every file';
    document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
  }, []);

  useEffect(() => {
    const syncPage = () => {
      const route = window.location.hash.split('?')[0];
      setPublicPage(route === '#/signup' ? 'signup' : route === '#/login' ? 'login' : 'home');
    };
    window.addEventListener('hashchange', syncPage);
    window.addEventListener('popstate', syncPage);
    return () => {
      window.removeEventListener('hashchange', syncPage);
      window.removeEventListener('popstate', syncPage);
    };
  }, []);

  const navigatePublic = useCallback((page: 'home' | 'login' | 'signup') => {
    const hash = page === 'home' ? '#/' : page === 'signup' ? '#/signup' : '#/login';
    if (window.location.hash !== hash) window.history.pushState({}, '', hash);
    setPublicPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Try to restore session on mount
  useEffect(() => {
    api.auth.me()
      .then((res) => {
        saveCsrfToken(res.csrfToken);
        setUser(res.user);
      })
      .catch(() => {})
      .finally(() => setBootstrapping(false));
  }, []);

  const logout = useCallback((): Promise<boolean> => {
    // Start the request while its CSRF token is still available, then leave the
    // workspace immediately so a failed or slow request cannot trap the user.
    const serverLogout = (async () => {
      try {
        await api.auth.logout();
        return true;
      } catch (initialError) {
        // A different tab can leave this tab with an older token. Refresh it
        // from the active session and retry once.
        if (initialError instanceof ApiError && initialError.statusCode === 403) {
          try {
            const session = await api.auth.me();
            saveCsrfToken(session.csrfToken);
            await api.auth.logout();
            return true;
          } catch (retryError) {
            console.warn('The server could not confirm logout after refreshing the session token:', retryError);
          }
        } else {
          console.warn('The server could not confirm logout:', initialError);
        }
        return false;
      } finally {
        clearCsrfToken();
      }
    })();

    setUser(null);
    return serverLogout;
  }, []);

  const inviteToken = new URLSearchParams(window.location.hash.split('?')[1] || '').get('invite');

  if (bootstrapping) {
    return (
      <div className="boot-screen">
        <BrandLockup />
        <p>RESTORING YOUR PRIVATE SESSION</p>
        <span className="boot-progress"><i /></span>
      </div>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme: () => setTheme((current) => current === 'dark' ? 'light' : 'dark') }}>
      <ToastProvider>
        <AuthContext.Provider value={{ user, setUser, logout }}>
          {user ? <AppShell initialUser={user} initialRequestDocumentId={requestDocumentId} onRequestLinkHandled={() => setRequestDocumentId(null)} /> : publicPage === 'home' ? (
            <PublicLanding onSignIn={() => navigatePublic('login')} onRequestAccess={() => navigatePublic('signup')} />
          ) : (
            <LoginPage onLogin={(u) => setUser(u)} inviteToken={inviteToken} requestDocumentId={requestDocumentId} mode={publicPage} onHome={() => navigatePublic('home')} onSwitchMode={(mode) => navigatePublic(mode)} />
          )}
        </AuthContext.Provider>
      </ToastProvider>
    </ThemeContext.Provider>
  );
}
