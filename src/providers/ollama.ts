import * as vscode from 'vscode';
import type { MetricLine } from './types';

// ── Helpers ───────────────────────────────────────────────────────

function getOllamaBaseUrl(): string {
  return (
    vscode.workspace
      .getConfiguration('usagedock')
      .get<string>('ollama.url', 'http://localhost:11434')
      .replace(/\/$/, '') // strip trailing slash
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

/**
 * Fetch JSON from an Ollama endpoint, returning both the body and
 * the raw Response so we can inspect rate-limit headers.
 */
async function ollamaFetchRaw(url: string): Promise<{ body: any; resp: Response }> {
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
  const body = await resp.json();
  return { body, resp };
}

// ── Rate-limit header parsing ─────────────────────────────────────
//
// Cloud Ollama-compatible services (Groq, Together AI, OpenRouter, etc.)
// attach standard rate-limit headers to every response:
//
//   x-ratelimit-limit-requests      / x-ratelimit-remaining-requests      / x-ratelimit-reset-requests
//   x-ratelimit-limit-tokens        / x-ratelimit-remaining-tokens        / x-ratelimit-reset-tokens
//
// Some use shortened forms without the "x-" prefix or the "-requests"/"-tokens" suffix.

interface RateLimitBucket {
  label: string;
  limit: number;
  remaining: number;
  resetAt: string | null;  // ISO timestamp or duration string
}

function parseRateLimitHeaders(resp: Response): RateLimitBucket[] {
  const buckets: RateLimitBucket[] = [];
  const h = (name: string) => resp.headers.get(name);

  // Helper: try multiple header name variants
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

  // Request limits
  const reqLimit = tryParseInt(
    'x-ratelimit-limit-requests',
    'ratelimit-limit',
    'x-ratelimit-limit',
  );
  const reqRemaining = tryParseInt(
    'x-ratelimit-remaining-requests',
    'ratelimit-remaining',
    'x-ratelimit-remaining',
  );
  if (reqLimit != null && reqRemaining != null && reqLimit > 0) {
    const resetStr = tryGetString(
      'x-ratelimit-reset-requests',
      'ratelimit-reset',
      'x-ratelimit-reset',
    );
    buckets.push({
      label: 'Requests',
      limit: reqLimit,
      remaining: reqRemaining,
      resetAt: resetStr,
    });
  }

  // Token limits
  const tokLimit = tryParseInt(
    'x-ratelimit-limit-tokens',
  );
  const tokRemaining = tryParseInt(
    'x-ratelimit-remaining-tokens',
  );
  if (tokLimit != null && tokRemaining != null && tokLimit > 0) {
    const resetStr = tryGetString(
      'x-ratelimit-reset-tokens',
    );
    buckets.push({
      label: 'Tokens',
      limit: tokLimit,
      remaining: tokRemaining,
      resetAt: resetStr,
    });
  }

  return buckets;
}

/**
 * Convert a rate-limit reset value to an ISO timestamp.
 * It may already be an ISO date, a Unix timestamp, or a duration like "1m30s" / "2h".
 */
function resetToIso(reset: string): string | null {
  // Already an ISO date?
  if (/^\d{4}-\d{2}/.test(reset)) {
    return reset;
  }
  // Unix timestamp (seconds)?
  if (/^\d{8,}$/.test(reset)) {
    return new Date(parseInt(reset, 10) * 1000).toISOString();
  }
  // Duration like "1m30.5s", "2h", "45s", "1d2h3m"
  const durationRx = /(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/;
  const m = reset.match(durationRx);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    const days = parseInt(m[1] || '0', 10);
    const hours = parseInt(m[2] || '0', 10);
    const mins = parseInt(m[3] || '0', 10);
    const secs = parseFloat(m[4] || '0');
    const ms = ((days * 24 + hours) * 60 + mins) * 60000 + secs * 1000;
    if (ms > 0) {
      return new Date(Date.now() + ms).toISOString();
    }
  }
  return null;
}

// ── Probe ─────────────────────────────────────────────────────────

export async function probeOllama(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const base = getOllamaBaseUrl();

  // 1. Version — also serves as the liveness check.
  let version = '';
  let rateLimits: RateLimitBucket[] = [];
  try {
    const { body, resp } = await ollamaFetchRaw(`${base}/api/version`);
    version = (body as any).version ?? '';
    // Capture rate-limit headers from this first response
    rateLimits = parseRateLimitHeaders(resp);
  } catch {
    throw new Error(`Ollama not running at ${base}. Start Ollama and try again.`);
  }

  // 2. Running models (`/api/ps`)
  let runningModels: any[] = [];
  try {
    const { body, resp } = await ollamaFetchRaw(`${base}/api/ps`);
    runningModels = (body as any).models ?? [];
    // If version response had no rate-limit headers, try from ps
    if (rateLimits.length === 0) {
      rateLimits = parseRateLimitHeaders(resp);
    }
  } catch {
    // Non-fatal — old Ollama versions may not have /api/ps
  }

  // 3. Available models (`/api/tags`)
  let availableCount = 0;
  try {
    const { body, resp } = await ollamaFetchRaw(`${base}/api/tags`);
    availableCount = ((body as any).models ?? []).length;
    // Try rate-limit headers from tags if still empty
    if (rateLimits.length === 0) {
      rateLimits = parseRateLimitHeaders(resp);
    }
  } catch {
    // Non-fatal
  }

  // ── Build metric lines ─────────────────────────────────────────
  const lines: MetricLine[] = [];
  const isCloud = rateLimits.length > 0;

  // Status badge
  const versionLabel = version ? `Running (v${version})` : 'Running';
  lines.push({ type: 'badge', label: 'Server', text: versionLabel, color: '#4ade80' });

  // ── Rate-limit usage bars (cloud services only) ────────────────
  for (const bucket of rateLimits) {
    const used = bucket.limit - bucket.remaining;
    const pct = Math.min(Math.max(Math.round((used / bucket.limit) * 100), 0), 100);
    const resetIso = bucket.resetAt ? resetToIso(bucket.resetAt) : null;

    lines.push({
      type: 'progress',
      label: bucket.label,
      used: pct,
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: resetIso,
    });
  }

  // ── Model count summary ────────────────────────────────────────
  const loadedCount = runningModels.length;
  const countText =
    availableCount > 0
      ? `${loadedCount} loaded · ${availableCount} available`
      : loadedCount > 0
        ? `${loadedCount} loaded`
        : 'No models loaded';
  lines.push({ type: 'text', label: 'Models', value: countText });

  // Per-loaded-model detail lines
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

    const detail = parts.length > 0 ? parts.join(' · ') : '';
    lines.push({ type: 'text', label: name, value: detail });
  }

  // If the server is local with no rate limits and no models, add a hint
  if (!isCloud && loadedCount === 0 && availableCount === 0) {
    lines.push({
      type: 'badge',
      label: 'Hint',
      text: 'Local Ollama has no usage limits',
      color: '#a3a3a3',
    });
  }

  return { plan: null, lines };
}
