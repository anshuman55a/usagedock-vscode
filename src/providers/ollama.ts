import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { MetricLine } from './types';
import { getOllamaDbPath } from '../util/platform';
import Database from 'better-sqlite3';

// ── Helpers ───────────────────────────────────────────────────────

function getOllamaBaseUrl(): string {
  return (
    vscode.workspace
      .getConfiguration('usagedock')
      .get<string>('ollama.url', 'http://localhost:11434')
      .replace(/\/$/, '')
  );
}

function getOllamaApiKey(): string {
  return (
    vscode.workspace
      .getConfiguration('usagedock')
      .get<string>('ollama.apiKey', '')
      .trim()
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(0)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = getOllamaApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Validates that an API key looks like a plausible token before sending it externally. */
function isValidApiKey(key: string): boolean {
  return typeof key === 'string' && key.length >= 8 && key.length <= 256 && /^[\w\-.:+=/]+$/.test(key);
}

async function ollamaGet(url: string): Promise<{ body: any; resp: Response }> {
  const resp = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(),
    signal: AbortSignal.timeout(5_000),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Ollama auth failed (HTTP ${resp.status}). Check usagedock.ollama.apiKey.`);
  }
  if (!resp.ok) {
    throw new Error(`Ollama request failed (HTTP ${resp.status})`);
  }
  return { body: await resp.json(), resp };
}

async function ollamaPost(url: string, payload: any = {}): Promise<any | null> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      return null;
    }
    return resp.json();
  } catch {
    return null;
  }
}

// ── Rate-limit header parsing (cloud Ollama-compatible services) ──

interface RateLimitBucket {
  label: string;
  limit: number;
  remaining: number;
  resetAt: string | null;
}

function parseRateLimitHeaders(resp: Response): RateLimitBucket[] {
  const buckets: RateLimitBucket[] = [];
  const h = (name: string) => resp.headers.get(name);

  const tryParseInt = (...names: string[]): number | null => {
    for (const n of names) {
      const v = h(n);
      if (v != null) {
        const num = parseInt(v, 10);
        if (!Number.isNaN(num)) {
          return num;
        }
      }
    }
    return null;
  };

  const tryGetString = (...names: string[]): string | null => {
    for (const n of names) {
      const v = h(n);
      if (v != null && v.trim()) {
        return v.trim();
      }
    }
    return null;
  };

  const reqLimit = tryParseInt('x-ratelimit-limit-requests', 'ratelimit-limit', 'x-ratelimit-limit');
  const reqRemaining = tryParseInt('x-ratelimit-remaining-requests', 'ratelimit-remaining', 'x-ratelimit-remaining');
  if (reqLimit != null && reqRemaining != null && reqLimit > 0) {
    buckets.push({
      label: 'Requests',
      limit: reqLimit,
      remaining: reqRemaining,
      resetAt: tryGetString('x-ratelimit-reset-requests', 'ratelimit-reset', 'x-ratelimit-reset'),
    });
  }

  const tokLimit = tryParseInt('x-ratelimit-limit-tokens');
  const tokRemaining = tryParseInt('x-ratelimit-remaining-tokens');
  if (tokLimit != null && tokRemaining != null && tokLimit > 0) {
    buckets.push({
      label: 'Tokens',
      limit: tokLimit,
      remaining: tokRemaining,
      resetAt: tryGetString('x-ratelimit-reset-tokens'),
    });
  }

  return buckets;
}

function resetToIso(reset: string): string | null {
  if (/^\d{4}-\d{2}/.test(reset)) {
    return reset;
  }
  if (/^\d{8,}$/.test(reset)) {
    return new Date(parseInt(reset, 10) * 1000).toISOString();
  }
  const m = reset.match(/(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    const ms =
      ((parseInt(m[1] || '0', 10) * 24 + parseInt(m[2] || '0', 10)) * 60 +
        parseInt(m[3] || '0', 10)) *
        60000 +
      parseFloat(m[4] || '0') * 1000;
    if (ms > 0) {
      return new Date(Date.now() + ms).toISOString();
    }
  }
  return null;
}

// ── Cloud account usage via /api/me ───────────────────────────────
//
// When signed in, Ollama returns session/weekly usage percentages
// and reset times directly from the local /api/me endpoint.

interface CloudUsage {
  plan: string | null;
  accountName: string | null;
  accountEmail: string | null;
  sessionUsed: number | null;   // percent used — only on paid plans
  sessionReset: string | null;
  weeklyUsed: number | null;
  weeklyReset: string | null;
}

function extractFloat(obj: any, ...keys: string[]): number | null {
  for (const k of keys) {
    const lk = k.toLowerCase();
    for (const [key, val] of Object.entries(obj)) {
      if (key.toLowerCase() === lk || key.toLowerCase().replace(/_/g, '') === lk.replace(/_/g, '')) {
        const n = typeof val === 'number' ? val : typeof val === 'string' ? parseFloat(val) : NaN;
        if (!Number.isNaN(n)) {
          return n;
        }
      }
    }
  }
  return null;
}

function extractUsageFromPayload(payload: any): { used: number | null; reset: string | null } {
  if (typeof payload === 'number') {
    return { used: payload, reset: null };
  }
  if (typeof payload === 'string') {
    const n = parseFloat(payload.replace(/%$/, ''));
    return { used: Number.isNaN(n) ? null : n, reset: null };
  }
  if (payload && typeof payload === 'object') {
    const used = extractFloat(payload, 'used', 'usage', 'value', 'percent', 'pct', 'used_percent');
    let reset: string | null = null;
    for (const k of ['reset_at', 'resets_at', 'reset_time', 'reset']) {
      const lk = k.toLowerCase();
      for (const [key, val] of Object.entries(payload)) {
        if (key.toLowerCase() === lk && typeof val === 'string' && val.trim()) {
          reset = val.trim();
          break;
        }
      }
      if (reset) break;
    }
    // seconds_to_reset / reset_in
    if (!reset) {
      const seconds = extractFloat(payload, 'reset_in', 'reset_in_seconds', 'resets_in', 'seconds_to_reset');
      if (seconds != null && seconds > 0) {
        reset = new Date(Date.now() + seconds * 1000).toISOString();
      }
    }
    return { used, reset };
  }
  return { used: null, reset: null };
}

async function fetchCloudUsage(base: string): Promise<CloudUsage> {
  const result: CloudUsage = { plan: null, accountName: null, accountEmail: null, sessionUsed: null, sessionReset: null, weeklyUsed: null, weeklyReset: null };

  // Try local /api/me first (always available when Ollama is running)
  const localMe = await ollamaPost(`${base}/api/me`);

  // If we have an API key, also try the cloud endpoint which returns richer data
  const rawApiKey = getOllamaApiKey() || process.env.OLLAMA_API_KEY || '';
  const apiKey = isValidApiKey(rawApiKey) ? rawApiKey : '';
  let cloudMe: any = null;
  if (apiKey) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch('https://ollama.com/api/me', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: '{}',
        signal: ctrl.signal,
      });
      if (res.ok) {
        cloudMe = await res.json();
      }
    } catch { /* cloud unreachable — use local data */ } finally {
      clearTimeout(timeout);
    }
  }

  // Prefer cloud response (PascalCase: Plan, Name, Email) over local (lowercase)
  const me = cloudMe || localMe;
  if (!me || typeof me !== 'object') {
    return result;
  }

  // Extract account info — handle both PascalCase (cloud) and lowercase (local)
  const getString = (obj: any, ...keys: string[]): string | null => {
    for (const k of keys) {
      const val = obj[k];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return null;
  };

  result.plan = getString(me, 'Plan', 'plan');
  result.accountName = getString(me, 'Name', 'name');
  result.accountEmail = getString(me, 'Email', 'email');

  // Look for session/weekly usage in multiple possible locations
  const sources = [me, me.usage, me.cloud_usage, me.quota, me.Usage, me.CloudUsage, me.Quota].filter(Boolean);
  const sessionKeys = ['session_usage', 'sessionusage', 'usage_5h', 'usagefivehour', 'five_hour_usage', 'SessionUsage', 'FiveHourUsage'];
  const weeklyKeys = ['weekly_usage', 'weeklyusage', 'usage_1d', 'usageoneday', 'daily_usage', 'WeeklyUsage', 'DailyUsage'];

  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of sessionKeys) {
      const lk = k.toLowerCase().replace(/_/g, '');
      for (const [key, val] of Object.entries(src)) {
        if (key.toLowerCase().replace(/_/g, '') === lk && result.sessionUsed == null) {
          const { used, reset } = extractUsageFromPayload(val);
          if (used != null) {
            result.sessionUsed = used;
            result.sessionReset = reset;
          }
        }
      }
    }
    for (const k of weeklyKeys) {
      const lk = k.toLowerCase().replace(/_/g, '');
      for (const [key, val] of Object.entries(src)) {
        if (key.toLowerCase().replace(/_/g, '') === lk && result.weeklyUsed == null) {
          const { used, reset } = extractUsageFromPayload(val);
          if (used != null) {
            result.weeklyUsed = used;
            result.weeklyReset = reset;
          }
        }
      }
    }
  }

  return result;
}

// ── Desktop DB usage stats ────────────────────────────────────────

interface DesktopStats {
  messagesToday: number;
  sessionsToday: number;
  totalMessages: number;
  totalChats: number;
  cachedPlan: string | null;
}

function queryCount(db: Database.Database, sql: string): number {
  try {
    const row = db.prepare(sql).get() as Record<string, number> | undefined;
    if (!row) { return 0; }
    // better-sqlite3 returns column by its exact name — use alias 'c'
    return row['c'] ?? row['COUNT(*)'] ?? Object.values(row)[0] ?? 0;
  } catch {
    return 0;
  }
}

function fetchDesktopStats(): DesktopStats | null {
  const dbPath = getOllamaDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const stats: DesktopStats = {
      messagesToday: queryCount(db, "SELECT COUNT(*) as c FROM messages WHERE date(created_at)=date('now','localtime')"),
      sessionsToday: queryCount(db, "SELECT COUNT(*) as c FROM chats WHERE date(created_at)=date('now','localtime')"),
      totalMessages: queryCount(db, 'SELECT COUNT(*) as c FROM messages'),
      totalChats: queryCount(db, 'SELECT COUNT(*) as c FROM chats'),
      cachedPlan: null,
    };

    // Try to read cached user plan
    try {
      const row = db.prepare('SELECT plan FROM users LIMIT 1').get() as { plan: string } | undefined;
      if (row?.plan?.trim()) {
        stats.cachedPlan = row.plan.trim();
      }
    } catch { /* users table may not exist in older versions */ }

    return stats;
  } catch (err) {
    console.error('UsageDock: Ollama desktop DB read failed:', err);
    return null;
  } finally {
    db?.close();
  }
}

// ── Server log parsing ───────────────────────────────────────────
// Parses GIN-format lines from Ollama server logs to count requests.
// Format: [GIN] 2026/06/01 - 09:57:34 | 200 |  4.108573s | 127.0.0.1 | POST "/api/chat"

interface ServerLogStats {
  requestsToday: number;
  requests5h: number;
  requests24h: number;
  chatRequestsToday: number;
  generateRequestsToday: number;
}

const GIN_RE = /^\[GIN\]\s+(\d{4}\/\d{2}\/\d{2})\s+-\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(\d+)\s+\|[^|]*\|\s+[^|]*\|\s+\w+\s+"([^"]+)"/;
const INFERENCE_PATHS = new Set(['/api/chat', '/api/generate', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages']);

function getOllamaLogDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const base = (localAppData && path.isAbsolute(localAppData)) ? localAppData : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Ollama');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), '.ollama', 'logs');
  }
  // Linux: systemd journal is typical, but some installs use ~/.ollama/logs
  return path.join(os.homedir(), '.ollama', 'logs');
}

function fetchServerLogStats(): ServerLogStats | null {
  const logDir = getOllamaLogDir();
  if (!fs.existsSync(logDir)) { return null; }

  // Find server-*.log files
  let logFiles: string[];
  try {
    logFiles = fs.readdirSync(logDir)
      .filter(f => /^server-?\d*\.log$/i.test(f))
      .map(f => path.join(logDir, f));
  } catch {
    return null;
  }
  if (logFiles.length === 0) { return null; }

  const now = new Date();
  const todayStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const stats: ServerLogStats = {
    requestsToday: 0,
    requests5h: 0,
    requests24h: 0,
    chatRequestsToday: 0,
    generateRequestsToday: 0,
  };

  for (const file of logFiles) {
    let content: string;
    try {
      // Read only the tail of large logs to avoid blocking the extension host
      const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB
      const stat = fs.statSync(file);
      if (stat.size <= MAX_LOG_BYTES) {
        content = fs.readFileSync(file, 'utf8');
      } else {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(MAX_LOG_BYTES);
          fs.readSync(fd, buf, 0, MAX_LOG_BYTES, stat.size - MAX_LOG_BYTES);
          content = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch { continue; }

    for (const line of content.split('\n')) {
      const match = GIN_RE.exec(line);
      if (!match) { continue; }

      const [, dateStr, timeStr, , urlPath] = match;
      if (!INFERENCE_PATHS.has(urlPath)) { continue; }

      // Parse timestamp
      const ts = new Date(`${dateStr.replace(/\//g, '-')}T${timeStr}`);
      if (isNaN(ts.getTime())) { continue; }

      if (ts >= twentyFourHoursAgo) {
        stats.requests24h++;
      }
      if (ts >= fiveHoursAgo) {
        stats.requests5h++;
      }
      if (dateStr === todayStr) {
        stats.requestsToday++;
        if (urlPath === '/api/chat' || urlPath === '/v1/chat/completions') {
          stats.chatRequestsToday++;
        } else if (urlPath === '/api/generate' || urlPath === '/v1/completions') {
          stats.generateRequestsToday++;
        }
      }
    }
  }

  if (stats.requestsToday === 0 && stats.requests24h === 0) {
    return null;
  }
  return stats;
}

// ── Cloud settings page scraper ──────────────────────────────────
// Fetches usage percentages by scraping https://ollama.com/settings.
// Reads API key from extension setting (usagedock.ollama.apiKey) or OLLAMA_API_KEY env.
// This mirrors the Go reference: fetchCloudUsageFromSettingsPage()

interface SettingsPageUsage {
  sessionUsed: number | null;
  sessionReset: string | null;
  weeklyUsed: number | null;
  weeklyReset: string | null;
}

async function fetchSettingsPageUsage(): Promise<SettingsPageUsage | null> {
  const rawKey = getOllamaApiKey() || process.env.OLLAMA_API_KEY || '';
  const apiKey = isValidApiKey(rawKey) ? rawKey : '';
  if (!apiKey) { return null; }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://ollama.com/settings', {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: ctrl.signal,
    });

    if (res.status !== 200) { return null; }

    // Cap response size to prevent OOM from unexpectedly large pages
    const MAX_HTML_BYTES = 512 * 1024;
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_HTML_BYTES) { return null; }
    const html = await res.text();
    if (html.length > MAX_HTML_BYTES) { return null; }

    const result: SettingsPageUsage = { sessionUsed: null, sessionReset: null, weeklyUsed: null, weeklyReset: null };

    // Regex matching: "Session usage</span><span...>0.5% used</span>"
    const usageRe = /(Session usage|Weekly usage)\s*<\/span>\s*<span[^>]*>\s*([0-9]+(?:\.[0-9]+)?)%\s*used\s*<\/span>/gi;
    let m: RegExpExecArray | null;
    while ((m = usageRe.exec(html)) !== null) {
      const label = m[1].toLowerCase();
      const value = parseFloat(m[2]);
      if (label === 'session usage') { result.sessionUsed = value; }
      else if (label === 'weekly usage') { result.weeklyUsed = value; }
    }

    // Parse reset times safely — avoid catastrophic backtracking by using
    // indexOf + bounded substring instead of [\s\S]*? across the full HTML.
    const htmlLower = html.toLowerCase();
    for (const label of ['session usage', 'weekly usage'] as const) {
      const idx = htmlLower.indexOf(label);
      if (idx === -1) continue;
      // Only search within 2000 chars after the label for the data-time attribute
      const slice = html.substring(idx, idx + 2000);
      const dtMatch = /data-time="([^"]{1,64})"/.exec(slice);
      if (!dtMatch) continue;
      // Validate extracted timestamp is a real date before using it
      const parsed = new Date(dtMatch[1]);
      if (isNaN(parsed.getTime())) continue;
      const iso = parsed.toISOString();
      if (label === 'session usage') { result.sessionReset = iso; }
      else { result.weeklyReset = iso; }
    }

    if (result.sessionUsed != null || result.weeklyUsed != null) {
      return result;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Probe ─────────────────────────────────────────────────────────

export async function probeOllama(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const base = getOllamaBaseUrl();

  // 1. Version — liveness check
  let version = '';
  let rateLimits: RateLimitBucket[] = [];
  try {
    const { body, resp } = await ollamaGet(`${base}/api/version`);
    version = (body as any).version ?? '';
    rateLimits = parseRateLimitHeaders(resp);
  } catch {
    throw new Error(`Ollama not running at ${base}. Start Ollama and try again.`);
  }

  // 2. Running models (/api/ps)
  let runningModels: any[] = [];
  try {
    const { body, resp } = await ollamaGet(`${base}/api/ps`);
    runningModels = (body as any).models ?? [];
    if (rateLimits.length === 0) {
      rateLimits = parseRateLimitHeaders(resp);
    }
  } catch { /* non-fatal */ }

  // 3. Available models (/api/tags)
  let availableCount = 0;
  try {
    const { body, resp } = await ollamaGet(`${base}/api/tags`);
    availableCount = ((body as any).models ?? []).length;
    if (rateLimits.length === 0) {
      rateLimits = parseRateLimitHeaders(resp);
    }
  } catch { /* non-fatal */ }

  // 4. Cloud account usage (/api/me) — session & weekly usage bars
  const cloud = await fetchCloudUsage(base);

  // 5. Desktop DB stats (messages, sessions)
  const desktop = fetchDesktopStats();

  // 6. Server log stats (request counts from GIN logs)
  const logStats = fetchServerLogStats();

  // 7. Cloud settings page scraper — gets usage % when /api/me doesn't have it
  //    Uses API key from extension settings (Usagedock > Ollama: Api Key)
  if (cloud.sessionUsed == null && cloud.weeklyUsed == null) {
    const settingsUsage = await fetchSettingsPageUsage();
    if (settingsUsage) {
      cloud.sessionUsed = settingsUsage.sessionUsed;
      cloud.sessionReset = settingsUsage.sessionReset;
      cloud.weeklyUsed = settingsUsage.weeklyUsed;
      cloud.weeklyReset = settingsUsage.weeklyReset;
    }
  }

  // ── Build metric lines ─────────────────────────────────────────
  const lines: MetricLine[] = [];
  const isCloud = rateLimits.length > 0;
  const plan = cloud.plan || desktop?.cachedPlan || null;

  // Status badge
  const versionLabel = version ? `Running (v${version})` : 'Running';
  lines.push({ type: 'badge', label: 'Server', text: versionLabel, color: '#4ade80' });

  // ── Account info (from /api/me) ────────────────────────────────
  if (cloud.accountName || cloud.accountEmail) {
    const accountLabel = cloud.accountName || cloud.accountEmail!;
    lines.push({ type: 'text', label: 'Account', value: accountLabel });
  }

  // ── Cloud usage bars (from /api/me — paid plans only) ──────────
  if (cloud.sessionUsed != null) {
    lines.push({
      type: 'progress',
      label: 'Session usage',
      used: Math.min(Math.max(cloud.sessionUsed, 0), 100),
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: cloud.sessionReset,
    });
  }

  if (cloud.weeklyUsed != null) {
    lines.push({
      type: 'progress',
      label: 'Weekly usage',
      used: Math.min(Math.max(cloud.weeklyUsed, 0), 100),
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: cloud.weeklyReset,
    });
  }

  // Free plan: no usage bars available from API — show informational note
  if (cloud.accountName != null && cloud.sessionUsed == null && cloud.weeklyUsed == null && !isCloud) {
    lines.push({ type: 'badge', label: 'Usage', text: 'No limits on free plan', color: '#22c55e' });
  }

  // ── Rate-limit usage bars (cloud-hosted services: Groq, etc.) ──
  for (const bucket of rateLimits) {
    const used = bucket.limit - bucket.remaining;
    const pct = Math.min(Math.max(Math.round((used / bucket.limit) * 100), 0), 100);
    lines.push({
      type: 'progress',
      label: bucket.label,
      used: pct,
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: bucket.resetAt ? resetToIso(bucket.resetAt) : null,
    });
  }

  // ── Model count ────────────────────────────────────────────────
  const loadedCount = runningModels.length;
  const countText =
    availableCount > 0
      ? `${loadedCount} loaded · ${availableCount} available`
      : loadedCount > 0
        ? `${loadedCount} loaded`
        : 'No models loaded';
  lines.push({ type: 'text', label: 'Models', value: countText });

  // ── Per-loaded-model details ───────────────────────────────────
  for (const m of runningModels) {
    const name: string = m.name ?? m.model ?? 'unknown';
    const vram: number | null = typeof m.size_vram === 'number' ? m.size_vram : null;
    const size: number | null = typeof m.size === 'number' ? m.size : null;
    const paramSize: string | null = m.details?.parameter_size ?? null;
    const quant: string | null = m.details?.quantization_level ?? null;

    const parts: string[] = [];
    if (vram != null && vram > 0) {
      parts.push(`${formatBytes(vram)} VRAM`);
    } else if (size != null && size > 0) {
      parts.push(formatBytes(size));
    }
    if (paramSize) { parts.push(paramSize); }
    if (quant) { parts.push(quant); }

    lines.push({ type: 'text', label: name, value: parts.length > 0 ? parts.join(' · ') : '' });
  }

  // ── Desktop DB stats ───────────────────────────────────────────
  if (desktop) {
    if (desktop.messagesToday > 0) {
      lines.push({ type: 'text', label: 'Today', value: `${desktop.messagesToday} msgs · ${desktop.sessionsToday} sessions` });
    }
    if (desktop.totalMessages > 0) {
      lines.push({ type: 'text', label: 'All time', value: `${desktop.totalMessages} msgs · ${desktop.totalChats} chats` });
    }
  }

  // ── Server log request counts ──────────────────────────────────
  if (logStats) {
    const logParts: string[] = [];
    if (logStats.requestsToday > 0) {
      logParts.push(`${logStats.requestsToday} today`);
    }
    if (logStats.requests5h > 0) {
      logParts.push(`${logStats.requests5h} last 5h`);
    }
    if (logStats.requests24h > 0 && logStats.requests24h !== logStats.requestsToday) {
      logParts.push(`${logStats.requests24h} last 24h`);
    }
    if (logParts.length > 0) {
      lines.push({ type: 'text', label: 'Requests', value: logParts.join(' · ') });
    }
    // Chat vs generate breakdown
    if (logStats.chatRequestsToday > 0 || logStats.generateRequestsToday > 0) {
      const breakdown: string[] = [];
      if (logStats.chatRequestsToday > 0) { breakdown.push(`${logStats.chatRequestsToday} chat`); }
      if (logStats.generateRequestsToday > 0) { breakdown.push(`${logStats.generateRequestsToday} generate`); }
      lines.push({ type: 'text', label: 'Breakdown', value: breakdown.join(' · ') });
    }
  }

  // Purely local, not signed in, no models, no data at all — generic hint
  if (!isCloud && !cloud.accountName && loadedCount === 0 && availableCount === 0 && !desktop?.totalMessages && !logStats) {
    lines.push({ type: 'badge', label: 'Hint', text: 'Local Ollama has no usage limits', color: '#a3a3a3' });
  }

  return { plan, lines };
}
