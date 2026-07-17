import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import { getVsCodeApi } from './vscode';
import { PROVIDER_ICONS } from './ProviderIcons';

const vscode = getVsCodeApi();

// Types matching the extension host
interface MetricFormat { kind: 'percent' | 'dollars' | 'count'; suffix?: string; }
interface ProgressLine { type: 'progress'; label: string; used: number; limit: number; format: MetricFormat; resetsAt?: string | null; }
interface TextLine { type: 'text'; label: string; value: string; }
interface BadgeLine { type: 'badge'; label: string; text: string; color?: string; }
type MetricLine = ProgressLine | TextLine | BadgeLine;
interface ProviderResult { id: string; name: string; icon: string; brandColor: string; plan?: string | null; lines: MetricLine[]; error?: string | null; }

type ThemeChoice = 'dark' | 'light' | 'auto';
const THEME_ORDER: ThemeChoice[] = ['dark', 'light', 'auto'];
const THEME_LABELS: Record<ThemeChoice, string> = { dark: 'Dark', light: 'Light', auto: 'Auto (VS Code)' };

function isVsCodeLight(): boolean {
  const kind = document.body.getAttribute('data-vscode-theme-kind') || document.body.className;
  return kind.includes('light');
}

const PROVIDER_STYLES: Record<string, { bg: string }> = {
  cursor: { bg: '#000000' }, claude: { bg: '#D97757' }, copilot: { bg: '#000000' }, codex: { bg: '#000000' }, windsurf: { bg: '#00B4D8' }, antigravity: { bg: '#6D5DF6' }, ollama: { bg: '#1a1a1a' },
};

function formatValue(used: number, limit: number, format: MetricFormat): string {
  switch (format.kind) {
    case 'percent': return `${Math.round(used)}%`;
    case 'dollars': return `$${used.toFixed(2)} / $${limit.toFixed(2)}`;
    case 'count': return `${Math.round(used)} / ${Math.round(limit)} ${format.suffix || ''}`;
    default: return `${used} / ${limit}`;
  }
}

function getProgressColor(pct: number): string {
  if (pct < 50) return '#22c55e';
  if (pct < 75) return '#f59e0b';
  if (pct < 90) return '#f97316';
  return '#ef4444';
}

function getDotColor(provider: ProviderResult): string {
  if (provider.error) return '#555';
  const prog = provider.lines.find((l) => l.type === 'progress');
  if (!prog || prog.type !== 'progress') return '#555';
  const pct = prog.limit > 0 ? Math.min((prog.used / prog.limit) * 100, 100) : 0;
  return getProgressColor(pct);
}

function timeUntilReset(isoStr: string): string {
  const trimmed = isoStr.trim();
  const numericReset = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  const resetMs = numericReset !== null ? (trimmed.length <= 10 ? numericReset * 1000 : numericReset) : new Date(trimmed).getTime();
  if (Number.isNaN(resetMs)) return 'reset time unavailable';
  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) return 'resetting...';
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (hours > 0) return `Resets in ${hours}h ${mins}m`;
  return `Resets in ${mins}m`;
}

function getSharedResetLabel(lines: MetricLine[]): string | null {
  const resetValues = lines.filter((l): l is ProgressLine => l.type === 'progress' && Boolean(l.resetsAt)).map((l) => l.resetsAt as string);
  if (resetValues.length === 0) return null;
  const unique = [...new Set(resetValues)];
  return unique.length === 1 ? timeUntilReset(unique[0]) : null;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

/* ─── Metric components ─── */

function ProgressMetric({ line, hideReset }: { line: ProgressLine; hideReset?: boolean }) {
  const pct = line.limit > 0 ? Math.min((line.used / line.limit) * 100, 100) : 0;
  const color = getProgressColor(pct);
  return (
    <div className="progress-metric">
      <div className="progress-header">
        <span className="progress-label">{line.label}</span>
        <span className="progress-value">{formatValue(line.used, line.limit, line.format)}</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}cc, ${color})` }} />
      </div>
      {!hideReset && line.resetsAt && <span className="progress-subtitle">{timeUntilReset(line.resetsAt)}</span>}
    </div>
  );
}

function BadgeMetric({ line }: { line: BadgeLine }) {
  const color = line.color || '#7da88c';
  return (
    <div className="badge-line">
      <span className="badge-label">{line.label}</span>
      <span className="badge-chip" style={{ color, borderColor: `${color}40` }}>{line.text}</span>
    </div>
  );
}

function TextMetric({ line }: { line: TextLine }) {
  return (
    <div className="text-metric">
      <span className="text-label">{line.label}</span>
      <span className="text-value">{line.value}</span>
    </div>
  );
}

/* ─── SVG icons ─── */

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.38 1.07V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.07-.38H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .38-1.07V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.35.69.6 1 .29.24.67.38 1.07.38H21a2 2 0 1 1 0 4h-.09c-.4 0-.78.14-1.07.38-.25.31-.46.64-.6 1Z" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13.5 1.5 5 13h5l-1.5 9.5L19 10h-5.25L13.5 1.5Z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
    </svg>
  );
}

function AutoThemeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

/* ─── Inline single metric (displayed in header row) ─── */

function InlineMetric({ line }: { line: ProgressLine }) {
  const pct = line.limit > 0 ? Math.min((line.used / line.limit) * 100, 100) : 0;
  const color = getProgressColor(pct);
  return (
    <div className="inline-metric">
      <span className="inline-metric-value" style={{ color }}>{formatValue(line.used, line.limit, line.format)}</span>
      <div className="inline-metric-bar">
        <div className="inline-metric-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/* ─── Provider Card ─── */

function ProviderCard({ provider, onRefresh, isRefreshing, compact }: { provider: ProviderResult; onRefresh: () => void; isRefreshing: boolean; compact?: boolean }) {
  const style = PROVIDER_STYLES[provider.id] || { bg: '#666' };
  const IconComponent = PROVIDER_ICONS[provider.id];
  const accent = provider.brandColor || style.bg;
  const progressLines = provider.lines.filter((l): l is ProgressLine => l.type === 'progress');
  const isSingleMetric = progressLines.length === 1 && provider.lines.length === 1;
  const sharedResetLabel = provider.error ? null : getSharedResetLabel(provider.lines);
  const caption = provider.error
    ? (compact ? null : 'Connection needs attention')
    : isRefreshing ? 'Refreshing...'
    : sharedResetLabel ? sharedResetLabel
    : provider.lines.length === 0 ? 'Waiting for signals' : null;

  const cardClasses = [
    'provider-card',
    provider.error ? 'provider-card-error' : '',
    progressLines.length > 1 ? 'provider-card-dense-metrics' : '',
    isSingleMetric && !provider.error ? 'provider-card-inline' : '',
    compact && provider.error ? 'provider-card-compact-error' : '',
  ].filter(Boolean).join(' ');

  const cardStyle = { '--provider-accent': accent, '--provider-accent-soft': `${accent}20` } as CSSProperties;

  return (
    <div className={cardClasses} style={cardStyle}>
      <div className="provider-card-header">
        <div className="provider-info">
          <div className="provider-icon" style={{ background: style.bg }}>
            {IconComponent ? <IconComponent /> : '?'}
          </div>
          <div className="provider-copy">
            <div className="provider-name-row">
              <div className="provider-name">{provider.name}</div>
              {provider.plan && <div className="provider-plan">{provider.plan}</div>}
            </div>
            {compact && provider.error && (
              <span className="compact-error-hint" title={provider.error}>{provider.error}</span>
            )}
            {caption && !compact && <div className="provider-caption">{caption}</div>}
            {!compact && !provider.error && !caption && null}
          </div>
        </div>

        {/* Inline single metric */}
        {isSingleMetric && !provider.error && !isRefreshing && (
          <InlineMetric line={progressLines[0]} />
        )}

        <button className={`btn-icon provider-refresh ${isRefreshing ? 'spinning' : ''}`} onClick={onRefresh} title="Refresh" aria-label={`Refresh ${provider.name}`}>
          <RefreshIcon />
        </button>
      </div>

      {isRefreshing && (
        <div className="provider-loading"><div className="skeleton" style={{ width: '100%', marginBottom: 4 }} /><div className="skeleton" style={{ width: '60%' }} /></div>
      )}

      {!isRefreshing && provider.error && !compact && (
        <div className="provider-error"><div className="error-msg"><AlertIcon /><span>{provider.error}</span></div></div>
      )}

      {!isRefreshing && !provider.error && provider.lines.length > 0 && (
        <div className="metric-lines">
          {provider.lines.map((line, i) => {
            switch (line.type) {
              case 'progress': return <ProgressMetric key={i} line={line} hideReset={!!sharedResetLabel} />;
              case 'text': return <TextMetric key={i} line={line} />;
              case 'badge': return <BadgeMetric key={i} line={line} />;
              default: return null;
            }
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Summary Dots ─── */

function SummaryDots({ providers, onDotClick }: { providers: ProviderResult[]; onDotClick: (id: string) => void }) {
  if (providers.length === 0) return null;
  return (
    <div className="summary-dots">
      {providers.map((p) => (
        <button
          key={p.id}
          className={`summary-dot ${!p.error && p.lines.length > 0 ? 'summary-dot-active' : ''}`}
          style={{ background: getDotColor(p), color: getDotColor(p) }}
          onClick={() => onDotClick(p.id)}
          title={`${p.name}: ${p.error ? 'unavailable' : p.lines.filter((l) => l.type === 'progress').map((l) => l.type === 'progress' ? `${Math.round(l.used)}%` : '').join(', ') || 'connected'}`}
          aria-label={p.name}
        />
      ))}
    </div>
  );
}

/* ─── Main App ─── */

function App() {
  const [providers, setProviders] = useState<ProviderResult[]>([]);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [lastRefreshMs, setLastRefreshMs] = useState<number | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>('dark');
  const [vsCodeLight, setVsCodeLight] = useState(() => isVsCodeLight());
  const [, setTick] = useState(0);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const resolvedTheme: 'dark' | 'light' = theme === 'auto' ? (vsCodeLight ? 'light' : 'dark') : theme;

  const availableProviders = providers.filter((p) => !p.error && p.lines.length > 0);
  const unavailableProviders = providers.filter((p) => p.error || p.lines.length === 0);
  const connectedCount = availableProviders.length;

  const statusText = isLoading
    ? 'Refreshing...'
    : lastRefreshMs
      ? `Updated ${timeAgo(lastRefreshMs)}`
      : providers.length === 0
        ? 'Waiting for data'
        : `${connectedCount}/${providers.length} connected`;

  const refreshAll = useCallback(() => { vscode.postMessage({ type: 'refreshAll' }); }, []);
  const refreshSingle = useCallback((id: string) => { vscode.postMessage({ type: 'refreshSingle', id }); }, []);
  const openSettings = useCallback(() => { vscode.postMessage({ type: 'openSettings' }); }, []);

  const scrollToProvider = useCallback((id: string) => {
    cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(prev) + 1) % THEME_ORDER.length];
      vscode.postMessage({ type: 'setTheme', theme: next });
      return next;
    });
  }, []);

  // Track VS Code theme kind changes (relevant in "auto" mode)
  useEffect(() => {
    const observer = new MutationObserver(() => setVsCodeLight(isVsCodeLight()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'providerResults') {
        setProviders(msg.providers);
        setLastRefreshMs(Date.now());
      }
      if (msg.type === 'loading') { setIsLoading(msg.loading); }
      if (msg.type === 'theme' && THEME_ORDER.includes(msg.theme)) { setTheme(msg.theme); }
      if (msg.type === 'refreshing') {
        setRefreshing((prev) => {
          const next = new Set(prev);
          if (msg.refreshing) { next.add(msg.id); } else { next.delete(msg.id); }
          return next;
        });
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Update "Updated Xm ago" every 30s
  useEffect(() => {
    if (!lastRefreshMs) return;
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, [lastRefreshMs]);

  // Auto-expand unavailable section when no providers are connected
  useEffect(() => {
    if (availableProviders.length === 0 && unavailableProviders.length > 0) {
      setShowUnavailable(true);
    }
  }, [availableProviders.length, unavailableProviders.length]);

  // Keyboard shortcut: R to refresh
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        refreshAll();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [refreshAll]);

  return (
    <div className="app-shell" data-theme={resolvedTheme}>
      <div className="header">
        <div className="header-mark"><BoltIcon /></div>
        <span className="header-product">UsageDock</span>
        <div className={`header-status ${isLoading ? 'header-status-live' : ''}`}>
          <span className="header-status-dot" />
          <span>{statusText}</span>
        </div>
        <div className="header-actions">
          <button
            className="btn-icon theme-toggle"
            onClick={cycleTheme}
            title={`Theme: ${THEME_LABELS[theme]} — click to change`}
            aria-label={`Theme: ${THEME_LABELS[theme]}. Click to switch.`}
          >
            {theme === 'auto' ? <AutoThemeIcon /> : theme === 'light' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="btn-icon settings-button" onClick={openSettings} title="Open UsageDock settings" aria-label="Open UsageDock settings">
            <SettingsIcon />
          </button>
          <button className={`btn-icon refresh-all ${isLoading ? 'spinning' : ''}`} onClick={refreshAll} title="Refresh all" aria-label="Refresh all providers">
            <RefreshIcon />
          </button>
        </div>
      </div>

      {providers.length > 0 && <SummaryDots providers={providers} onDotClick={scrollToProvider} />}

      <div className="provider-list">
        {availableProviders.map((p) => (
          <div key={p.id} ref={(el) => { cardRefs.current[p.id] = el; }}>
            <ProviderCard provider={p} onRefresh={() => refreshSingle(p.id)} isRefreshing={refreshing.has(p.id)} />
          </div>
        ))}

        {!isLoading && unavailableProviders.length > 0 && (
          <section className={`provider-collapse ${showUnavailable ? 'provider-collapse-open' : ''}`}>
            <button className="provider-collapse-toggle" type="button" onClick={() => setShowUnavailable((v) => !v)} aria-expanded={showUnavailable}>
              <div className="provider-collapse-copy">
                <span className="provider-collapse-title">Unavailable providers</span>
                <span className="provider-collapse-caption">{unavailableProviders.length} hidden until needed</span>
              </div>
              <div className="provider-collapse-action">
                <span className="provider-collapse-count">{unavailableProviders.length}</span>
                <ChevronDownIcon className="provider-collapse-icon" />
              </div>
            </button>
            {showUnavailable && (
              <div className="provider-collapse-body">
                {unavailableProviders.map((p) => (
                  <div key={p.id} ref={(el) => { cardRefs.current[p.id] = el; }}>
                    <ProviderCard provider={p} onRefresh={() => refreshSingle(p.id)} isRefreshing={refreshing.has(p.id)} compact />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {!isLoading && providers.length === 0 && (
          <div className="empty-state">
            <BoltIcon />
            <p>No usage loaded yet.</p>
            <button className="empty-cta" onClick={refreshAll}>
              <RefreshIcon /> Refresh Now
            </button>
          </div>
        )}
      </div>

      {providers.length > 0 && (
        <div className="app-footer">
          <span className="footer-hint">Press <kbd>R</kbd> to refresh</span>
        </div>
      )}
    </div>
  );
}

export default App;
