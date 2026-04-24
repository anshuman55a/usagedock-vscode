import { useState, useEffect, useCallback, type CSSProperties } from 'react';
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

const PROVIDER_STYLES: Record<string, { bg: string }> = {
  cursor: { bg: '#000000' }, claude: { bg: '#D97757' }, copilot: { bg: '#000000' }, codex: { bg: '#000000' }, windsurf: { bg: '#00B4D8' },
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

/* ─── Provider Card ─── */

function ProviderCard({ provider, onRefresh, isRefreshing }: { provider: ProviderResult; onRefresh: () => void; isRefreshing: boolean }) {
  const style = PROVIDER_STYLES[provider.id] || { bg: '#666' };
  const IconComponent = PROVIDER_ICONS[provider.id];
  const accent = provider.brandColor || style.bg;
  const progressLineCount = provider.lines.filter((l) => l.type === 'progress').length;
  const sharedResetLabel = provider.error ? null : getSharedResetLabel(provider.lines);
  const caption = provider.error ? 'Connection needs attention' : isRefreshing ? 'Refreshing usage...' : sharedResetLabel ? sharedResetLabel : provider.lines.length === 0 ? 'Waiting for usage signals' : null;
  const cardStyle = { '--provider-accent': accent, '--provider-accent-soft': `${accent}20` } as CSSProperties;

  return (
    <div className={`provider-card ${provider.error ? 'provider-card-error' : ''} ${progressLineCount > 1 ? 'provider-card-dense-metrics' : ''}`} style={cardStyle}>
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
            {caption && <div className="provider-caption">{caption}</div>}
          </div>
        </div>
        <button className={`btn-icon provider-refresh ${isRefreshing ? 'spinning' : ''}`} onClick={onRefresh} title="Refresh" aria-label={`Refresh ${provider.name}`}>
          <RefreshIcon />
        </button>
      </div>

      {isRefreshing && (
        <div className="provider-loading"><div className="skeleton" style={{ width: '100%', marginBottom: 6 }} /><div className="skeleton" style={{ width: '60%' }} /></div>
      )}

      {!isRefreshing && provider.error && (
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

/* ─── Main App ─── */

function App() {
  const [providers, setProviders] = useState<ProviderResult[]>([]);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [showUnavailable, setShowUnavailable] = useState(false);

  const availableProviders = providers.filter((p) => !p.error && p.lines.length > 0);
  const unavailableProviders = providers.filter((p) => p.error || p.lines.length === 0);
  const connectedCount = availableProviders.length;
  const statusText = isLoading ? 'Refreshing local usage' : providers.length === 0 ? 'Waiting for connected tools' : `${connectedCount} of ${providers.length} providers reporting`;

  const refreshAll = useCallback(() => { vscode.postMessage({ type: 'refreshAll' }); }, []);
  const refreshSingle = useCallback((id: string) => { vscode.postMessage({ type: 'refreshSingle', id }); }, []);
  const openSettings = useCallback(() => { vscode.postMessage({ type: 'openSettings' }); }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'providerResults') { setProviders(msg.providers); }
      if (msg.type === 'loading') { setIsLoading(msg.loading); }
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

  useEffect(() => {
    if (availableProviders.length === 0 && unavailableProviders.length > 0) {
      setShowUnavailable(true);
    }
  }, [availableProviders.length, unavailableProviders.length]);

  return (
    <div className="app-shell">
      <div className="header">
        <div className="header-mark"><BoltIcon /></div>
        <span className="header-product">UsageDock</span>
        <div className={`header-status ${isLoading ? 'header-status-live' : ''}`}>
          <span className="header-status-dot" />
          <span>{statusText}</span>
        </div>
        <div className="header-actions">
          <button className="btn-icon settings-button" onClick={openSettings} title="Open UsageDock settings" aria-label="Open UsageDock settings">
            <SettingsIcon />
          </button>
          <button className={`btn-icon refresh-all ${isLoading ? 'spinning' : ''}`} onClick={refreshAll} title="Refresh all" aria-label="Refresh all providers">
            <RefreshIcon />
          </button>
        </div>
      </div>

      <div className="provider-list">
        {availableProviders.map((p) => <ProviderCard key={p.id} provider={p} onRefresh={() => refreshSingle(p.id)} isRefreshing={refreshing.has(p.id)} />)}

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
                {unavailableProviders.map((p) => <ProviderCard key={p.id} provider={p} onRefresh={() => refreshSingle(p.id)} isRefreshing={refreshing.has(p.id)} />)}
              </div>
            )}
          </section>
        )}

        {!isLoading && providers.length === 0 && (
          <div className="empty-state"><BoltIcon /><p>No usage loaded yet.<br />Use Refresh All, or enable refresh on open in UsageDock settings.</p></div>
        )}
      </div>
    </div>
  );
}

export default App;
