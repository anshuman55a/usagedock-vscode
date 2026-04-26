import * as fs from 'fs';
import type { MetricLine } from './types';
import { getClaudeCredentialsPath } from '../util/platform';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function refreshAccessToken(refreshTok: string): Promise<string> {
  const resp = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshTok,
      client_id: CLIENT_ID,
      scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (resp.status === 400 || resp.status === 401) {
    throw new Error('Session expired. Run `claude` to log in again.');
  }
  if (!resp.ok) {
    throw new Error(`Token refresh failed (HTTP ${resp.status})`);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (!body['access_token']) {
    throw new Error('No access token in refresh response');
  }
  return body['access_token'] as string;
}

async function fetchUsage(accessToken: string): Promise<any> {
  const resp = await fetch(USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken.trim()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'UsageDock',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Token expired. Run `claude` to log in again.');
  }
  if (!resp.ok) {
    throw new Error(`Usage request failed (HTTP ${resp.status})`);
  }
  return resp.json();
}

export async function probeClaude(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const credPath = getClaudeCredentialsPath();
  if (!credPath || !fs.existsSync(credPath)) {
    throw new Error('Not logged in. Run `claude` to authenticate.');
  }

  const raw = fs.readFileSync(credPath, 'utf-8');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth) {
    throw new Error('No OAuth credentials found. Run `claude` to authenticate.');
  }

  const accessToken = oauth.accessToken;
  if (!accessToken) {
    throw new Error('Not logged in. Run `claude` to authenticate.');
  }

  // Check if token needs refresh (5 min buffer)
  let token = accessToken;
  const expiresAt = oauth.expiresAt;
  if (expiresAt && Date.now() >= expiresAt - 300_000) {
    if (oauth.refreshToken) {
      try {
        token = await refreshAccessToken(oauth.refreshToken);
      } catch {
        // Fall through with existing token
      }
    }
  }

  const data = await fetchUsage(token);
  const plan = oauth.subscriptionType ? capitalize(oauth.subscriptionType) : undefined;
  const lines: MetricLine[] = [];

  // Session (5-hour window)
  if (data.five_hour?.utilization != null) {
    lines.push({
      type: 'progress',
      label: 'Session',
      used: data.five_hour.utilization,
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: data.five_hour.resets_at ?? null,
    });
  }

  // Weekly (7-day window)
  if (data.seven_day?.utilization != null) {
    lines.push({
      type: 'progress',
      label: 'Weekly',
      used: data.seven_day.utilization,
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: data.seven_day.resets_at ?? null,
    });
  }

  // Extra usage
  if (data.extra_usage?.is_enabled === true) {
    const used = data.extra_usage.used_credits ?? 0;
    const limit = data.extra_usage.monthly_limit ?? 0;
    if (limit > 0) {
      lines.push({
        type: 'progress',
        label: 'Extra usage',
        used: used / 100,
        limit: limit / 100,
        format: { kind: 'dollars' },
        resetsAt: null,
      });
    }
  }

  if (lines.length === 0) {
    lines.push({ type: 'badge', label: 'Status', text: 'No usage data', color: '#a3a3a3' });
  }

  return { plan, lines };
}
