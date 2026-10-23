import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import {
  Shield, FileText, Users, BarChart3, Search, Upload,
  Lock, Unlock, LogOut, ChevronRight, AlertTriangle,
  CheckCircle, XCircle, Clock, Download, Eye,
  RefreshCw, Plus, X, ShieldCheck, Sparkles,
  FileCheck, Activity, Bell, Key,
  ArrowRight, ArrowUpRight, Sun, Moon, Fingerprint, Database,
} from 'lucide-react';
import './index.css';
import './redesign.css';
import {
  api, API_BASE_URL, saveCsrfToken, clearCsrfToken, ApiError,
  type User, type Document, type Suggestion,
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
  onClose, onNavigate, documents,
}: { onClose: () => void; onNavigate: (view: string, docId?: string) => void; documents: Document[] }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const commands = [
    { label: 'Dashboard', icon: <BarChart3 size={16} />, action: () => onNavigate('dashboard') },
    { label: 'My Documents', icon: <FileText size={16} />, action: () => onNavigate('documents') },
    { label: 'Upload Document', icon: <Upload size={16} />, action: () => onNavigate('upload') },
    { label: 'Audit Log', icon: <Activity size={16} />, action: () => onNavigate('audit') },
    { label: 'Manage Users', icon: <Users size={16} />, action: () => onNavigate('users') },
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

// ============================================================
// Demo identities
// ============================================================

const DEMO_PERSONAS = [
  { label: 'Acme Owner', email: 'owner@acme.com', role: 'Owner', desc: 'Owns Strategy & Roadmap' },
  { label: 'Acme Viewer', email: 'viewer@acme.com', role: 'Viewer', desc: 'Granted Strategy, Denied Roadmap' },
  { label: 'Acme Admin', email: 'admin@acme.com', role: 'Admin', desc: 'Manages Users, Zero Content Access' },
  { label: 'Stark Owner', email: 'owner@stark.com', role: 'Owner', desc: 'Isolated workspace: Stark Industries' },
  { label: 'Stark Viewer', email: 'viewer@stark.com', role: 'Viewer', desc: 'Arc Reactor access; budget denied' },
  { label: 'Stark Admin', email: 'admin@stark.com', role: 'Admin', desc: 'Manages Stark users and audit' },
];

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
              <div className="vault-card-head"><span><span className="live-pip" /> LIVE POLICY CHECK</span><span className="card-index">TV / 001</span></div>
              <div className="file-preview">
                <div className="file-glyph"><FileText size={20} strokeWidth={1.5} /></div>
                <div><strong>Northstar strategy</strong><small>Confidential · PDF · 4.8 MB</small></div>
                <span className="file-lock"><Lock size={14} /></span>
              </div>
              <div className="gate-flow"><span className="flow-line" /><div className="gate-icon"><Shield size={19} strokeWidth={1.6} /></div><span className="flow-line" /></div>
              <div className="decision-line"><div><small>DECISION</small><strong><i /> Authorized</strong></div><div className="decision-time">14 ms</div></div>
              <div className="ledger-line"><Fingerprint size={16} /><span>SEALED TO AUDIT LEDGER</span><span className="ledger-hash">a84c...09de</span></div>
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

function LoginPage({ onLogin, onQuickSwitch, mode, onHome, onSwitchMode }: {
  onLogin: (user: User) => void;
  onQuickSwitch: (email: string) => void;
  mode: 'login' | 'signup';
  onHome: () => void;
  onSwitchMode: (mode: 'login' | 'signup') => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [requestReady, setRequestReady] = useState(false);
  const addToast = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.auth.login(email.trim(), password);
      saveCsrfToken(res.csrfToken);
      onLogin(res.user);
      addToast(`Signed in as ${res.user.name}`, 'success');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'We could not verify those credentials.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleInviteRequest = (e: React.FormEvent) => {
    e.preventDefault();
    const subject = encodeURIComponent('TrustVault workspace access request');
    const body = encodeURIComponent(`Hello,

${name} (${email}) would like access to our TrustVault workspace.

Please let me know the next step.
`);
    window.location.href = `mailto:${encodeURIComponent(adminEmail)}?subject=${subject}&body=${body}`;
    setRequestReady(true);
  };

  return (
    <div className="auth-page">
      <header className="auth-header"><BrandLockup onClick={onHome} /><div className="auth-header-right"><span>Protected workspace access</span><ThemeToggle /></div></header>
      <main className="auth-layout">
        <section className="auth-story">
          <div className="eyebrow"><span className="eyebrow-dot" /> YOUR DOCUMENTS. YOUR RULES.</div>
          <h1>{mode === 'login' ? <>A quieter way<br />to <em>stay in control.</em></> : <>Start with the<br /><em>right invitation.</em></>}</h1>
          <p>{mode === 'login' ? 'Your workspace is ready when you are. Sign in to reach the files and people you have permission to see.' : 'TrustVault workspaces are provisioned by an administrator. Send them a note and they can set up your account.'}</p>
          <div className="auth-assurance"><div className="assurance-seal"><ShieldCheck size={21} strokeWidth={1.5} /></div><div><strong>Every session is accountable.</strong><span>Every request is authorized. Every outcome is recorded.</span></div></div>
          <div className="auth-coordinates"><span>TRUSTVAULT / ACCESS PORTAL</span><span>IDENTITY → POLICY → PROOF</span></div>
        </section>

        <section className="auth-form-wrap">
          <div className="auth-card">
            <div className="auth-mode-switch" role="tablist" aria-label="Account access options">
              <button className={mode === 'login' ? 'selected' : ''} type="button" onClick={() => { setError(''); onSwitchMode('login'); }} role="tab" aria-selected={mode === 'login'}>Sign in</button>
              <button className={mode === 'signup' ? 'selected' : ''} type="button" onClick={() => { setError(''); onSwitchMode('signup'); }} role="tab" aria-selected={mode === 'signup'}>Request an invite</button>
            </div>
            {mode === 'login' ? (
              <>
                <div className="auth-card-title"><span className="form-kicker">WELCOME BACK</span><h2>Enter your workspace.</h2><p>Use the email and password provided by your administrator.</p></div>
                <form onSubmit={handleSubmit} className="public-form">
                  <div className="public-field"><label htmlFor="login-email">Work email</label><input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="public-input" autoComplete="username" required /></div>
                  <div className="public-field"><div className="field-label-row"><label htmlFor="login-password">Password</label><span>Workspace credential</span></div><input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="public-input" autoComplete="current-password" required /></div>
                  {error && <div className="auth-error" role="alert"><XCircle size={15} /><span>{error}</span></div>}
                  <button type="submit" disabled={loading} className="button button-accent auth-submit">{loading ? <><RefreshCw size={16} className="animate-spin" /> Checking credentials</> : <>Continue securely <ArrowRight size={16} /></>}</button>
                </form>
                <div className="demo-access"><div className="demo-access-label"><span>EXPLORE A LIVE DEMO</span><span>TEST WORKSPACES</span></div><div className="demo-access-buttons">{DEMO_PERSONAS.map((persona) => <button type="button" key={persona.email} onClick={() => onQuickSwitch(persona.email)} title={`${persona.label} · ${persona.desc}`}><span className="demo-avatar">{persona.role.slice(0, 1)}</span><span>{persona.label}</span><ArrowUpRight size={12} /></button>)}</div></div>
                <div className="auth-foot"><Lock size={13} /><span>Sessions are private, scoped, and immediately revocable.</span></div>
              </>
            ) : (
              <>
                <div className="auth-card-title"><span className="form-kicker">REQUEST AN INVITATION</span><h2>Join your team.</h2><p>Accounts are created by your workspace administrator. We’ll prepare a request you can send them.</p></div>
                <form onSubmit={handleInviteRequest} className="public-form">
                  <div className="public-field"><label htmlFor="invite-name">Your name</label><input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="public-input" autoComplete="name" required /></div>
                  <div className="public-field"><label htmlFor="invite-email">Work email</label><input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="public-input" autoComplete="email" required /></div>
                  <div className="public-field"><label htmlFor="admin-email">Workspace administrator’s email</label><input id="admin-email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@company.com" className="public-input" required /></div>
                  <button type="submit" className="button button-accent auth-submit">Prepare access request <ArrowUpRight size={16} /></button>
                  {requestReady && <p className="request-note" role="status"><CheckCircle size={15} /> Your email app should open with the request ready to send.</p>}
                </form>
                <div className="auth-foot"><Lock size={13} /><span>No account is created until your administrator approves it.</span></div>
              </>
            )}
          </div>
          <button type="button" className="back-home" onClick={onHome}>← Back to TrustVault</button>
        </section>
      </main>
      <footer className="auth-footer"><span>TRUSTVAULT / SECURE ACCESS</span><span>ENCRYPTED IN TRANSIT · VERIFIED AT EVERY REQUEST</span></footer>
    </div>
  );
}
// ============================================================
// Sidebar + Layout
// ============================================================

type View = 'dashboard' | 'documents' | 'upload' | 'doc-detail' | 'users' | 'audit' | 'access-requests' | 'settings';

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
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const { data, loading, refetch } = useAsync(
    () => api.documents.list({ ...(search ? { search } : {}), ...(category ? { category } : {}) }),
    [search, category]
  );

  const docs = data?.documents || [];

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
            Documents filtered by kernel authorization. Inaccessible files never leak via search, count, or metadata.
          </p>
        </div>

        <div className="flex items-center gap-3">
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

      {/* Category Filter Pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {['', 'Finance', 'Engineering', 'Legal', 'General'].map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              category === cat
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-semibold shadow-sm'
                : 'bg-slate-900/60 hover:bg-slate-800 text-slate-400 border border-slate-800'
            }`}
          >
            {cat === '' ? 'All Enclaves' : cat}
          </button>
        ))}
      </div>

      {/* Content Table / Cards */}
      {loading ? (
        <div className="table-container p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-12 w-full" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><FileText size={28} /></div>
          <h3>No accessible documents</h3>
          <p>{search ? 'No files match your query in this scope.' : 'Zero explicit grants issued to this identity.'}</p>
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
              {docs.map((doc) => (
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
                    <button
                      className="btn-vault-secondary text-xs py-1.5 px-3"
                      onClick={() => onNavigate('doc-detail', doc.id)}
                      aria-label={`Open ${doc.title}`}
                    >
                      <Eye size={13} /> Open
                    </button>
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

  const { data, loading, error } = useAsync(
    () => api.documents.get(docId),
    [docId]
  );

  const { data: grantsData, loading: grantsLoading, refetch: refetchGrants } = useAsync(
    () => api.grants.list(docId),
    [docId]
  );

  const doc = data?.document;
  const versions = data?.versions || [];
  const grants = grantsData?.grants || [];
  const isOwner = user?.role === 'owner' && doc?.ownerId === user?.id;

  const handleDownload = async () => {
    try {
      const { rawTicket } = await api.tickets.issue(docId);
      // Navigate to download URL — the browser will trigger the download
      window.location.href = `${API_BASE_URL}/documents/${docId}/download?ticket=${encodeURIComponent(rawTicket)}`;
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Download failed', 'error');
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
    <div className="space-y-6 animate-fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <button className="btn-vault-ghost text-xs py-1 px-2.5" onClick={onBack}>
          ← Documents Enclave
        </button>
        <ChevronRight size={14} className="text-slate-600" />
        <span className="text-white font-medium">{doc.title}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left column */}
        <div className="lg:col-span-7 space-y-6">
          {/* Document header card */}
          <div className="vault-card p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 pb-6 border-b border-slate-800">
              <div className="flex items-start gap-3.5">
                <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                  <FileText size={22} />
                </div>
                <div>
                  <h2 className="text-xl font-display font-bold text-white">{doc.title}</h2>
                  <p className="text-slate-400 text-xs mt-1">{doc.description || 'Encrypted document ciphertext in zero-trust enclave.'}</p>
                </div>
              </div>
              <div>
                <button className="btn-vault-primary text-xs py-2 px-4 shadow-md shadow-emerald-950/40" onClick={handleDownload} id="btn-download">
                  <Download size={14} /> Download Secure Ticket
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Category</p>
                <span className="vault-badge vault-badge-slate">{doc.category}</span>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Your Permission</p>
                <StatusBadge status={doc.effectivePermission || 'read'} />
              </div>
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Owner Enclave</p>
                <p className="text-xs font-mono text-slate-300 truncate">{doc.ownerEmail}</p>
              </div>
            </div>
          </div>

          {/* Version history */}
          <div className="vault-card p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-bold text-white text-base">Version History & Recovery</h3>
              {isOwner && (
                <span className="text-[11px] font-mono text-emerald-400">Append-only ciphertext</span>
              )}
            </div>
            {versions.length === 0 ? (
              <p className="text-slate-500 text-xs py-4 text-center">No versions recorded.</p>
            ) : (
              <div className="table-container border-0 bg-transparent shadow-none">
                <table className="table" aria-label="Version history">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Filename</th>
                      <th>Size</th>
                      <th>MIME Type</th>
                      <th>Encrypted At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id}>
                        <td><span className="vault-badge vault-badge-emerald">v{v.versionNumber}</span></td>
                        <td className="text-white text-xs font-mono">{v.originalFilename}</td>
                        <td className="text-slate-400 text-xs font-mono">{formatBytes(v.fileSize)}</td>
                        <td><span className="vault-badge vault-badge-slate text-[10px]">{v.mimeType}</span></td>
                        <td className="text-slate-400 text-xs font-mono">{formatDate(v.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right column — Who can see this */}
        <div className="lg:col-span-5 space-y-5">
          <div className="vault-card p-6 border-emerald-500/25 shadow-xl shadow-black/60 relative">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <h3 className="font-display font-bold text-white text-base flex items-center gap-2">
                <ShieldCheck size={18} className="text-emerald-400" />
                <span>Who Can See This?</span>
              </h3>
              {isOwner && (
                <button className="btn-vault-secondary text-xs py-1.5 px-3" onClick={() => setShowGrantModal(true)} id="btn-grant">
                  <Plus size={13} /> Issue Grant
                </button>
              )}
            </div>

            <div className="space-y-3">
              {/* Owner row */}
              <div className="grant-row">
                <div className="user-avatar text-xs shrink-0">
                  {(doc.ownerEmail || '').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-white truncate font-mono">{doc.ownerEmail}</p>
                  <p className="text-[11px] text-slate-400">Document Owner — Full Control</p>
                </div>
                <span className="vault-badge vault-badge-emerald">OWNER</span>
              </div>

              {grantsLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ height: 56, borderRadius: 8 }} />
                ))
              ) : grants.length === 0 ? (
                <p className="text-muted text-sm" style={{ textAlign: 'center', padding: 'var(--space-4)' }}>
                  Nobody else — not even admins.
                </p>
              ) : (
                grants.map((g) => (
                  <div key={g.id} className="grant-row">
                    <div className="user-avatar" style={{ width: 28, height: 28, fontSize: '0.65rem' }}>
                      {g.userEmail.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>{g.userEmail}</p>
                      {g.expiresAt && (
                        <p className="text-xs text-muted">
                          <Clock size={10} style={{ display: 'inline' }} /> Expires {formatDate(g.expiresAt)}
                        </p>
                      )}
                    </div>
                    <StatusBadge status={g.permission} />
                    {isOwner && (
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => handleRevokeGrant(g.userId, g.userEmail)}
                        title={`Revoke access for ${g.userEmail}`}
                        aria-label={`Revoke access for ${g.userEmail}`}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))
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
  const { data, loading, refetch } = useAsync(() => api.admin.listUsers(), []);
  const users = data?.users || [];
  const [showCreate, setShowCreate] = useState(false);

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
          <p className="text-muted text-sm mt-1">{users.length} users in your organization</p>
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
              {users.map((u) => (
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
                        <LogOut size={12} />
                      </button>
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                        <button className="btn btn-ghost btn-sm" onClick={() => handleUnlock(u.id, u.email)}>
                          <Unlock size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={() => { refetch(); setShowCreate(false); }} />}
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
                value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="new-user-name">Full Name</label>
              <input id="new-user-name" className="form-input" required minLength={2}
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
  const [page, setPage] = useState(1);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ isValid: boolean; totalRecords: number; message: string } | null>(null);

  const { data, loading, refetch } = useAsync(
    () => api.admin.audit({ page: String(page), pageSize: '50', ...(statusFilter ? { status: statusFilter } : {}) }),
    [page, statusFilter]
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
      await api.admin.exportCsv();
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

      {loading ? (
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
  const { data: chainData } = useAsync(() =>
    user.role === 'admin' ? api.admin.verifyChain() : Promise.resolve(null), [user.role]);

  const docs = docsData?.documents || [];
  const pendingRequests = accessRequestsData?.requests || [];
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
        <div className="welcome-actions"><span className="welcome-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>{user.role === 'owner' && <button className="button button-accent" type="button" onClick={() => onNavigate('upload')}><Plus size={15} /> Add a document</button>}</div>
      </div>

      <div className="dashboard-stats">
        <article className="stat-card"><div className="stat-top"><span>DOCUMENTS YOU CAN ACCESS</span><FileText size={17} /></div><strong>{docsLoading ? '—' : docs.length.toString().padStart(2, '0')}</strong><div className="stat-bottom"><span className="stat-pip" /> Scoped to your permissions</div></article>
        <article className="stat-card"><div className="stat-top"><span>{user.role === 'owner' ? 'REQUESTS TO REVIEW' : user.role === 'admin' ? 'SECURITY SIGNALS' : 'WORKSPACE'}</span>{user.role === 'admin' ? <Activity size={17} /> : user.role === 'owner' ? <Key size={17} /> : <Database size={17} />}</div><strong>{user.role === 'owner' ? pendingRequests.length.toString().padStart(2, '0') : user.role === 'admin' ? (dashLoading ? '—' : totalAlerts.toString().padStart(2, '0')) : workspace.replace(/^./, (letter) => letter.toUpperCase())}</strong><div className="stat-bottom"><span className={`stat-pip ${user.role === 'admin' && totalAlerts > 0 || user.role === 'owner' && pendingRequests.length > 0 ? 'pip-warn' : ''}`} />{user.role === 'owner' ? 'Awaiting an owner decision' : user.role === 'admin' ? (totalAlerts ? 'Needs your attention' : 'No unusual activity detected') : 'Private by default'}</div></article>
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

      {user.role === 'admin' && alerts && totalAlerts > 0 && <section className="dashboard-alerts"><div className="panel-heading"><div><span className="panel-kicker">ADMINISTRATOR REVIEW</span><h2>Security signals</h2></div><span className="alert-count">{totalAlerts} to review</span></div>{Object.entries(alerts).flatMap(([key, items]) => (items as any[]).map((item: any, index) => <div className="dashboard-alert-row" key={`${key}-${index}`}><AlertTriangle size={15} /><span><strong>{item.label}</strong><small>{item.actorEmail || 'Workspace activity'}{item.latestAt ? ` · ${formatDate(item.latestAt)}` : ''}</small></span><span>{key.replace(/([A-Z])/g, ' $1')}</span></div>))}</section>}
    </div>
  );
}
// ============================================================
// Access Requests View
// ============================================================

function AccessRequestsView() {
  const addToast = useToast();
  const { data, loading, refetch } = useAsync(() => api.accessRequests.listPending(), []);
  const requests = data?.requests || [];

  const handleReview = async (reqId: string, decision: 'approve' | 'deny', permission: 'read' | 'edit' = 'read') => {
    try {
      await api.accessRequests.review(reqId, decision, permission);
      addToast(`Request ${decision === 'approve' ? 'approved' : 'denied'}.`, decision === 'approve' ? 'success' : 'info');
      refetch();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Access Requests</h2>
          <p className="text-muted text-sm mt-1">Pending requests for documents you own</p>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={refetch} aria-label="Refresh requests"><RefreshCw size={16} /></button>
      </div>

      {loading ? (
        <div className="table-container">
          <table className="table"><thead><tr><th>Document</th><th>Requester</th><th>Permission</th><th>Submitted</th><th /></tr></thead>
            <tbody>{Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} cols={5} />)}</tbody>
          </table>
        </div>
      ) : requests.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><CheckCircle size={28} /></div>
          <h3>No pending requests</h3>
          <p>All access requests have been reviewed.</p>
        </div>
      ) : (
        <div className="table-container">
          <table className="table" aria-label="Access requests">
            <thead>
              <tr><th>Document</th><th>Requester</th><th>Permission</th><th>Submitted</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="text-primary text-sm">{r.documentId}</td>
                  <td className="text-muted text-sm">{r.requesterEmail}</td>
                  <td><StatusBadge status={r.targetPermission} /></td>
                  <td className="text-muted text-sm">{formatDate(r.createdAt)}</td>
                  <td>
                    <div className="flex gap-2">
                      <button className="btn btn-primary btn-sm" onClick={() => handleReview(r.id, 'approve', r.targetPermission)} id={`btn-approve-${r.id}`}>
                        <CheckCircle size={12} /> Approve
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleReview(r.id, 'deny')} id={`btn-deny-${r.id}`}>
                        <XCircle size={12} /> Deny
                      </button>
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
// Main App
// ============================================================

function AppShell({ initialUser, onQuickSwitch }: { initialUser: User; onQuickSwitch: (email: string) => void }) {
  const [user, setUser] = useState<User>(initialUser);
  const [view, setView] = useState<View>('dashboard');
  const [activeDocId, setActiveDocId] = useState<string | undefined>();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [docs, setDocs] = useState<Document[]>([]);

  useEffect(() => {
    setUser(initialUser);
  }, [initialUser]);

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
      case 'upload': return <UploadView onUploaded={() => setView('documents')} />;
      case 'users': return user.role === 'admin' ? <UsersView /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'audit': return user.role === 'admin' ? <AuditView /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      case 'access-requests': return user.role === 'owner' ? <AccessRequestsView /> : <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
      default: return <DashboardView user={user} onNavigate={(v, id) => handleNavigate(v, id)} />;
    }
  };

  return (
    <div className="app-layout">
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
              {(user.email.endsWith('@acme.com') || user.email.endsWith('@stark.com')) && <select className="demo-switch-select" aria-label="Switch demo identity" value={user.email} onChange={(e) => onQuickSwitch(e.target.value)}>{DEMO_PERSONAS.map((persona) => <option key={persona.email} value={persona.email}>{persona.label}</option>)}</select>}
            </div>
          </header>

          <main className="app-main" id="main-content" role="main">
            {renderView()}
          </main>
        </div>

        {showCommandPalette && (
          <CommandPalette
            onClose={() => setShowCommandPalette(false)}
            onNavigate={(v, id) => { handleNavigate(v, id); setShowCommandPalette(false); }}
            documents={docs}
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
    if (window.location.hash === '#/signup') return 'signup';
    return window.location.hash === '#/login' ? 'login' : 'home';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('trustvault-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.title = 'TrustVault — Trust, built into every file';
    document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.remove();
  }, []);

  useEffect(() => {
    const syncPage = () => setPublicPage(window.location.hash === '#/signup' ? 'signup' : window.location.hash === '#/login' ? 'login' : 'home');
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
        // A different tab or a quick demo-account switch can leave this tab with
        // an older token. Refresh it from the active session and retry once.
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

  const handleQuickSwitch = useCallback(async (email: string) => {
    try {
      const res = await api.auth.login(email, 'TrustVault2026!#');
      saveCsrfToken(res.csrfToken);
      setUser(res.user);
    } catch (err) {
      console.error('Quick switch failed:', err);
    }
  }, []);

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
          {user ? <AppShell initialUser={user} onQuickSwitch={handleQuickSwitch} /> : publicPage === 'home' ? (
            <PublicLanding onSignIn={() => navigatePublic('login')} onRequestAccess={() => navigatePublic('signup')} />
          ) : (
            <LoginPage onLogin={(u) => setUser(u)} onQuickSwitch={handleQuickSwitch} mode={publicPage} onHome={() => navigatePublic('home')} onSwitchMode={(mode) => navigatePublic(mode)} />
          )}
        </AuthContext.Provider>
      </ToastProvider>
    </ThemeContext.Provider>
  );
}
