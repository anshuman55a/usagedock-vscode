import * as fs from 'fs';
import type { MetricLine } from './types';
import { getCursorDbPath } from '../util/platform';
import { readDbValue } from '../util/sqlite';

const BASE_URL = 'https://api2.cursor.sh';
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function centsToD(cents: number): number {
  return Math.round((cents / 100) * 100) / 100;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

async function refreshToken(refreshTok: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshTok,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (resp.status === 400 || resp.status === 401) {
    throw new Error('Token expired. Sign in via Cursor app.');
  }
  if (!resp.ok) {
    throw new Error(`Refresh failed (HTTP ${resp.status})`);
  }

  const body = await resp.json();
  if (body.shouldLogout === true) {
    throw new Error('Session expired. Sign in via Cursor app.');
  }
  if (!body.access_token) {
    throw new Error('No access token in refresh response');
  }
  return body.access_token;
}

async function connectPost(url: string, token: string): Promise<any> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Token expired. Sign in via Cursor app.');
  }
  if (!resp.ok) {
    throw new Error(`API error (HTTP ${resp.status})`);
  }
  return resp.json();
}

export async function probeCursor(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const dbPath = getCursorDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error('Cursor not installed or not signed in.');
  }

  const accessToken = readDbValue(dbPath, 'cursorAuth/accessToken');
  const refreshTok = readDbValue(dbPath, 'cursorAuth/refreshToken');

  let token: string;
  if (accessToken) {
    token = accessToken;
  } else if (refreshTok) {
    token = await refreshToken(refreshTok);
  } else {
    throw new Error('Not logged in. Sign in via Cursor app.');
  }

  // Fetch usage
  const usage = await connectPost(
    `${BASE_URL}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
    token,
  );

  // Fetch plan info
  let planLabel: string | undefined;
  try {
    const planData = await connectPost(
      `${BASE_URL}/aiserver.v1.DashboardService/GetPlanInfo`,
      token,
    );
    const planName = planData?.planInfo?.planName;
    if (planName) {
      planLabel = capitalize(planName);
    }
  } catch {
    // Non-critical — plan name is cosmetic
  }

  if (usage.enabled !== true && !usage.planUsage) {
    throw new Error('No active Cursor subscription.');
  }

  const lines: MetricLine[] = [];

  // Plan usage
  const pu = usage.planUsage;
  if (pu) {
    const limit = Number(pu.limit || 0);

    // Parse billing cycle reset
    const rawBillingEnd = usage.billingCycleEnd;
    let resetsAt: string | null = null;
    if (rawBillingEnd != null) {
      const ms = typeof rawBillingEnd === 'string' ? parseInt(rawBillingEnd, 10) : Number(rawBillingEnd);
      if (!isNaN(ms)) {
        resetsAt = msToIso(ms);
      }
    }

    if (limit > 0) {
      const totalSpend = pu.totalSpend != null ? Number(pu.totalSpend) : null;
      const remaining = pu.remaining != null ? Number(pu.remaining) : null;
      const used = totalSpend ?? (limit - (remaining ?? 0));

      lines.push({
        type: 'progress',
        label: 'Plan usage',
        used: centsToD(used),
        limit: centsToD(limit),
        format: { kind: 'dollars' },
        resetsAt,
      });
    }

    if (limit <= 0) {
      const totalUsed = pu.totalPercentUsed != null ? Number(pu.totalPercentUsed) : null;
      if (totalUsed != null) {
        lines.push({
          type: 'progress',
          label: 'Included usage',
          used: Math.min(Math.max(totalUsed, 0), 100),
          limit: 100,
          format: { kind: 'percent' },
          resetsAt,
        });
      }

      const autoUsed = pu.autoPercentUsed != null ? Number(pu.autoPercentUsed) : null;
      if (autoUsed != null && autoUsed > 0) {
        lines.push({
          type: 'progress',
          label: 'Auto',
          used: Math.min(Math.max(autoUsed, 0), 100),
          limit: 100,
          format: { kind: 'percent' },
          resetsAt,
        });
      }

      const apiUsed = pu.apiPercentUsed != null ? Number(pu.apiPercentUsed) : null;
      if (apiUsed != null && apiUsed > 0) {
        lines.push({
          type: 'progress',
          label: 'API',
          used: Math.min(Math.max(apiUsed, 0), 100),
          limit: 100,
          format: { kind: 'percent' },
          resetsAt,
        });
      }
    }
  }

  // On-demand spend limit
  const su = usage.spendLimitUsage;
  if (su) {
    const limit = Number(su.individualLimit ?? su.pooledLimit ?? 0);
    const remaining = Number(su.individualRemaining ?? su.pooledRemaining ?? 0);
    if (limit > 0) {
      lines.push({
        type: 'progress',
        label: 'On-demand',
        used: centsToD(limit - remaining),
        limit: centsToD(limit),
        format: { kind: 'dollars' },
        resetsAt: null,
      });
    }
  }

  if (lines.length === 0) {
    lines.push({ type: 'badge', label: 'Status', text: 'No usage data', color: '#a3a3a3' });
  }

  return { plan: planLabel, lines };
}
