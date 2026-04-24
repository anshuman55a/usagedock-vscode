import * as fs from 'fs';
import { execFile } from 'child_process';
import type { MetricLine } from './types';
import { getGhHostsPath, getGhExecutablePath } from '../util/platform';

const USAGE_URL = 'https://api.github.com/copilot_internal/user';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function loadTokenFromHostsFile(): string | null {
  const hostsPath = getGhHostsPath();
  if (!hostsPath || !fs.existsSync(hostsPath)) {
    return null;
  }
  const content = fs.readFileSync(hostsPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('oauth_token:')) {
      const token = trimmed.slice('oauth_token:'.length).trim();
      if (token) {
        return token;
      }
    }
  }
  return null;
}

function loadTokenFromGhCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ghPath = getGhExecutablePath();
    if (!ghPath) {
      reject(
        new Error(
          'No trusted GitHub CLI executable found. Install GitHub CLI and run `gh auth login` first.',
        ),
      );
      return;
    }

    const options: any = {};
    if (process.platform === 'win32') {
      options.windowsHide = true;
    }

    execFile(ghPath, ['auth', 'token', '--hostname', 'github.com'], options, (err, stdout) => {
      if (err) {
        reject(new Error('No GitHub token found. Run `gh auth login` first.'));
        return;
      }
      const token = stdout.trim();
      if (!token) {
        reject(new Error('No GitHub token found. Run `gh auth login` first.'));
        return;
      }
      resolve(token);
    });
  });
}

async function loadToken(): Promise<string> {
  const fileToken = loadTokenFromHostsFile();
  if (fileToken) {
    return fileToken;
  }
  return loadTokenFromGhCli();
}

async function fetchUsage(token: string): Promise<any> {
  const resp = await fetch(USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'X-Github-Api-Version': '2025-04-01',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Token invalid. Run `gh auth login` to re-authenticate.');
  }
  if (!resp.ok) {
    throw new Error(`Usage request failed (HTTP ${resp.status})`);
  }
  return resp.json();
}

export async function probeCopilot(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const token = await loadToken();
  const data = await fetchUsage(token);

  const lines: MetricLine[] = [];
  const plan = data.copilot_plan ? capitalize(data.copilot_plan) : undefined;

  // Paid tier: quota_snapshots
  if (data.quota_snapshots) {
    const premium = data.quota_snapshots.premium_interactions;
    if (premium?.percent_remaining != null) {
      const used = Math.min(Math.max(100 - premium.percent_remaining, 0), 100);
      lines.push({
        type: 'progress',
        label: 'Premium',
        used,
        limit: 100,
        format: { kind: 'percent' },
        resetsAt: data.quota_reset_date ?? null,
      });
    }

    const chat = data.quota_snapshots.chat;
    if (chat?.percent_remaining != null) {
      const used = Math.min(Math.max(100 - chat.percent_remaining, 0), 100);
      lines.push({
        type: 'progress',
        label: 'Chat',
        used,
        limit: 100,
        format: { kind: 'percent' },
        resetsAt: null,
      });
    }
  }

  // Free tier: limited_user_quotas
  if (data.limited_user_quotas && data.monthly_quotas) {
    const resetDate = data.limited_user_reset_date ?? null;

    const remaining = data.limited_user_quotas.chat;
    const total = data.monthly_quotas.chat;
    if (remaining != null && total != null && total > 0) {
      const used = total - remaining;
      const pct = Math.min(Math.max(Math.round((used / total) * 100), 0), 100);
      lines.push({
        type: 'progress',
        label: 'Chat',
        used: pct,
        limit: 100,
        format: { kind: 'percent' },
        resetsAt: resetDate,
      });
    }
  }

  if (lines.length === 0) {
    lines.push({ type: 'badge', label: 'Status', text: 'No usage data', color: '#a3a3a3' });
  }

  return { plan, lines };
}
