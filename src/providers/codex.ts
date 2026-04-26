import * as fs from 'fs';
import type { MetricLine } from './types';
import { getCodexAuthPaths } from '../util/platform';

const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function loadAuth(): any {
  for (const p of getCodexAuthPaths()) {
    if (fs.existsSync(p)) {
      const auth = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (auth?.tokens?.access_token) { return auth; }
    }
  }
  throw new Error('Not logged in. Run `codex` to authenticate.');
}

async function refreshToken(tok: string): Promise<string> {
  const body = `grant_type=refresh_token&client_id=${encodeURIComponent(CLIENT_ID)}&refresh_token=${encodeURIComponent(tok)}`;
  const resp = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 400 || resp.status === 401) { throw new Error('Session expired. Run `codex` to log in again.'); }
  if (!resp.ok) { throw new Error(`Token refresh failed (HTTP ${resp.status})`); }
  const d = await resp.json() as Record<string, unknown>;
  if (!d['access_token']) { throw new Error('No access token in refresh response'); }
  return d['access_token'] as string;
}

export async function probeCodex(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const auth = loadAuth();
  const tokens = auth.tokens;
  let token: string = tokens.access_token;
  if (tokens.refresh_token) {
    try { token = await refreshToken(tokens.refresh_token); } catch { /* use existing */ }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'UsageDock',
  };
  if (tokens.account_id) { headers['ChatGPT-Account-Id'] = tokens.account_id; }

  const resp = await fetch(USAGE_URL, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
  if (resp.status === 401 || resp.status === 403) { throw new Error('Token expired. Run `codex` to log in again.'); }
  if (!resp.ok) { throw new Error(`Usage request failed (HTTP ${resp.status})`); }

  const rh: Record<string, string> = {};
  for (const k of ['x-codex-primary-used-percent', 'x-codex-secondary-used-percent', 'x-codex-credits-balance']) {
    const v = resp.headers.get(k); if (v) { rh[k] = v; }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await resp.json() as any;
  const lines: MetricLine[] = [];

  const sessionPct = rh['x-codex-primary-used-percent'] ? parseFloat(rh['x-codex-primary-used-percent']) : data?.rate_limit?.primary_window?.used_percent ?? null;
  if (sessionPct != null) {
    const ra = data?.rate_limit?.primary_window?.reset_at;
    lines.push({ type: 'progress', label: 'Session', used: sessionPct, limit: 100, format: { kind: 'percent' }, resetsAt: ra != null ? String(ra) : null });
  }

  const weeklyPct = rh['x-codex-secondary-used-percent'] ? parseFloat(rh['x-codex-secondary-used-percent']) : data?.rate_limit?.secondary_window?.used_percent ?? null;
  if (weeklyPct != null) {
    const ra = data?.rate_limit?.secondary_window?.reset_at;
    lines.push({ type: 'progress', label: 'Weekly', used: weeklyPct, limit: 100, format: { kind: 'percent' }, resetsAt: ra != null ? String(ra) : null });
  }

  const credits = rh['x-codex-credits-balance'] ? parseFloat(rh['x-codex-credits-balance']) : data?.credits?.balance ?? null;
  if (credits != null) {
    lines.push({ type: 'progress', label: 'Credits', used: Math.min(Math.max(1000 - credits, 0), 1000), limit: 1000, format: { kind: 'count', suffix: 'credits' }, resetsAt: null });
  }

  const plan = data.plan_type ? capitalize(data.plan_type) : undefined;
  if (lines.length === 0) { lines.push({ type: 'badge', label: 'Status', text: 'No usage data', color: '#a3a3a3' }); }
  return { plan, lines };
}
