import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';
import type { MetricLine } from './types';
import { getGhHostsPath, getGhExecutablePath } from '../util/platform';

const USAGE_URL = 'https://api.github.com/copilot_internal/user';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Token sources (ordered by preference) ─────────────────────────

/**
 * 1️⃣  VS Code's built-in GitHub authentication.
 *
 * If the user has GitHub Copilot authenticated inside VS Code, a session
 * with the `copilot` scope already exists. We ask for it silently first
 * (no UI at all), then with `createIfNone: false` which may show a small
 * consent banner but won't launch a full sign-in flow.
 */
async function loadTokenFromVscodeAuth(): Promise<string | null> {
  try {
    // Silent check — returns a session only if previously approved for this extension.
    let session = await vscode.authentication.getSession('github', ['copilot'], {
      silent: true,
    });

    if (!session) {
      // Non-silent, non-creating check — may show a small "Allow" banner if
      // a GitHub session exists but hasn't been consented for UsageDock yet.
      // Does NOT open a full sign-in dialog.
      session = await vscode.authentication.getSession('github', ['copilot'], {
        createIfNone: false,
      });
    }

    return session?.accessToken ?? null;
  } catch {
    // Authentication provider not available or user dismissed — not an error.
    return null;
  }
}

/**
 * 2️⃣  Read the oauth_token from GitHub CLI's hosts.yml config file.
 */
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

/**
 * 3️⃣  Shell out to `gh auth token` (requires GitHub CLI installed + authenticated).
 */
function loadTokenFromGhCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ghPath = getGhExecutablePath();
    if (!ghPath) {
      reject(new Error('GitHub CLI not found'));
      return;
    }

    const options: any = {};
    if (process.platform === 'win32') {
      options.windowsHide = true;
    }

    execFile(ghPath, ['auth', 'token', '--hostname', 'github.com'], options, (err, stdout) => {
      if (err) {
        reject(new Error('gh auth token failed'));
        return;
      }
      const token = String(stdout).trim();
      if (!token) {
        reject(new Error('gh returned empty token'));
        return;
      }
      resolve(token);
    });
  });
}

// ── Combined token loader ─────────────────────────────────────────

async function loadToken(): Promise<string> {
  // 1. VS Code's GitHub authentication (zero-friction for Copilot users)
  const vscodeToken = await loadTokenFromVscodeAuth();
  if (vscodeToken) {
    return vscodeToken;
  }

  // 2. GitHub CLI hosts.yml
  const fileToken = loadTokenFromHostsFile();
  if (fileToken) {
    return fileToken;
  }

  // 3. GitHub CLI executable
  try {
    return await loadTokenFromGhCli();
  } catch {
    // All methods exhausted
  }

  throw new Error(
    'Not authenticated. Sign in to GitHub in VS Code (Accounts menu) or run `gh auth login`.',
  );
}

// ── Usage API ─────────────────────────────────────────────────────

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
    throw new Error(
      'GitHub token invalid or lacks Copilot access. Sign in again via the VS Code Accounts menu.',
    );
  }
  if (!resp.ok) {
    throw new Error(`Usage request failed (HTTP ${resp.status})`);
  }
  return resp.json();
}

// ── Probe ─────────────────────────────────────────────────────────

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
