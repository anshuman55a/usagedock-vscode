import * as fs from 'fs';
import * as vscode from 'vscode';
import type { MetricLine } from './types';
import { getOllamaDbPath } from '../util/platform';
import { readDbValue } from '../util/sqlite';
import initSqlJs, { type Database } from 'sql.js';
import * as path from 'path';

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
  sessionUsed: number | null;   // percent used
  sessionReset: string | null;  // ISO or relative reset time
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
  const result: CloudUsage = { plan: null, sessionUsed: null, sessionReset: null, weeklyUsed: null, weeklyReset: null };

  const me = await ollamaPost(`${base}/api/me`);
  if (!me || typeof me !== 'object') {
    return result;
  }

  // Plan name
  if (typeof me.plan === 'string' && me.plan.trim()) {
    result.plan = me.plan.trim();
  }

  // Look for session/weekly usage in multiple possible locations
  const sources = [me, me.usage, me.cloud_usage, me.quota].filter(Boolean);
  const sessionKeys = ['session_usage', 'sessionusage', 'usage_5h', 'usagefivehour', 'five_hour_usage'];
  const weeklyKeys = ['weekly_usage', 'weeklyusage', 'usage_1d', 'usageoneday', 'daily_usage'];

  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of sessionKeys) {
      const lk = k.toLowerCase();
      for (const [key, val] of Object.entries(src)) {
        if (key.toLowerCase().replace(/_/g, '') === lk.replace(/_/g, '') && result.sessionUsed == null) {
          const { used, reset } = extractUsageFromPayload(val);
          if (used != null) {
            result.sessionUsed = used;
            result.sessionReset = reset;
          }
        }
      }
    }
    for (const k of weeklyKeys) {
      const lk = k.toLowerCase();
      for (const [key, val] of Object.entries(src)) {
        if (key.toLowerCase().replace(/_/g, '') === lk.replace(/_/g, '') && result.weeklyUsed == null) {
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

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSql(): ReturnType<typeof initSqlJs> {
  if (!sqlPromise) {
    const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    if (fs.existsSync(wasmPath)) {
      sqlPromise = initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    } else {
      sqlPromise = initSqlJs();
    }
  }
  return sqlPromise;
}

function queryCount(db: Database, sql: string): number {
  try {
    const result = db.exec(sql);
    const val = result[0]?.values[0]?.[0];
    return typeof val === 'number' ? val : 0;
  } catch {
    return 0;
  }
}

async function fetchDesktopStats(): Promise<DesktopStats | null> {
  const dbPath = getOllamaDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    return null;
  }

  let db: Database | null = null;
  try {
    const SQL = await getSql();
    db = new SQL.Database(fs.readFileSync(dbPath));

    const stats: DesktopStats = {
      messagesToday: queryCount(db, "SELECT COUNT(*) FROM messages WHERE date(created_at)=date('now','localtime')"),
      sessionsToday: queryCount(db, "SELECT COUNT(*) FROM chats WHERE date(created_at)=date('now','localtime')"),
      totalMessages: queryCount(db, 'SELECT COUNT(*) FROM messages'),
      totalChats: queryCount(db, 'SELECT COUNT(*) FROM chats'),
      cachedPlan: null,
    };

    // Try to read cached user plan
    try {
      const userResult = db.exec('SELECT plan FROM users LIMIT 1');
      const plan = userResult[0]?.values[0]?.[0];
      if (typeof plan === 'string' && plan.trim()) {
        stats.cachedPlan = plan.trim();
      }
    } catch { /* users table may not exist in older versions */ }

    return stats;
  } catch {
    return null;
  } finally {
    db?.close();
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
  const desktop = await fetchDesktopStats();

  // ── Build metric lines ─────────────────────────────────────────
  const lines: MetricLine[] = [];
  const isCloud = rateLimits.length > 0;
  const plan = cloud.plan || desktop?.cachedPlan || null;

  // Status badge
  const versionLabel = version ? `Running (v${version})` : 'Running';
  lines.push({ type: 'badge', label: 'Server', text: versionLabel, color: '#4ade80' });

  // ── Cloud usage bars (from /api/me) ────────────────────────────
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
    if (paramSize) {
      parts.push(paramSize);
    }
    if (quant) {
      parts.push(quant);
    }

    lines.push({ type: 'text', label: name, value: parts.length > 0 ? parts.join(' · ') : '' });
  }

  // ── Desktop DB stats ───────────────────────────────────────────
  if (desktop) {
    if (desktop.messagesToday > 0) {
      lines.push({ type: 'text', label: 'Today', value: `${desktop.messagesToday} messages · ${desktop.sessionsToday} sessions` });
    } else if (desktop.totalMessages > 0) {
      lines.push({ type: 'text', label: 'All time', value: `${desktop.totalMessages} messages · ${desktop.totalChats} chats` });
    }
  }

  // If purely local with nothing interesting, show a hint
  if (!isCloud && cloud.sessionUsed == null && loadedCount === 0 && availableCount === 0 && !desktop?.totalMessages) {
    lines.push({ type: 'badge', label: 'Hint', text: 'Local Ollama has no usage limits', color: '#a3a3a3' });
  }

  return { plan, lines };
}
