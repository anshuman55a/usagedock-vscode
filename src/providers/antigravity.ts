import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import type { MetricLine } from './types';
import { getAntigravityDbPath } from '../util/platform';
import { readDbValue } from '../util/sqlite';

const LS_SERVICE = 'exa.language_server_pb.LanguageServerService';
const CLOUD_CODE_URLS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];
const FETCH_MODELS_PATH = '/v1internal:fetchAvailableModels';
const GOOGLE_OAUTH_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken';
const OAUTH_TOKEN_SENTINEL = 'oauthTokenInfoSentinelKey';
const SETTINGS_KEY = 'antigravity';

const MODEL_BLACKLIST = new Set([
  'MODEL_CHAT_20706',
  'MODEL_CHAT_23310',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  'MODEL_GOOGLE_GEMINI_2_5_PRO',
  'MODEL_PLACEHOLDER_M19',
  'MODEL_PLACEHOLDER_M9',
  'MODEL_PLACEHOLDER_M12',
]);

interface OAuthTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expirySeconds: number | null;
}

interface LsDiscovery {
  /** All listening ports for the LS process (excluding the extension server port). */
  lsPorts: number[];
  /** The --csrf_token value (used for LS gRPC calls). */
  csrf: string;
  /** Fallback: the --extension_server_port itself. */
  extensionPort: number;
}

interface ModelConfig {
  label: string;
  remainingFraction: number;
  resetTime?: string | null;
  modelId?: string | null;
}

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

// ---------------------------------------------------------------------------
// Protobuf wire-format decoder (operates on binary strings, matching plugin.js)
// ---------------------------------------------------------------------------

interface ProtoField {
  type: number;
  value?: number;  // varint
  data?: string;   // length-delimited (binary string)
}

function readVarint(s: string, pos: number): { v: number; p: number } | null {
  let v = 0;
  let shift = 0;
  while (pos < s.length) {
    const b = s.charCodeAt(pos++);
    v += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) {
      return { v, p: pos };
    }
    shift += 7;
  }
  return null;
}

function readFields(s: string): Record<number, ProtoField> {
  const fields: Record<number, ProtoField> = {};
  let pos = 0;
  while (pos < s.length) {
    const tag = readVarint(s, pos);
    if (!tag) {
      break;
    }
    pos = tag.p;
    const fieldNum = Math.floor(tag.v / 8);
    const wireType = tag.v % 8;
    if (wireType === 0) {
      const val = readVarint(s, pos);
      if (!val) {
        break;
      }
      fields[fieldNum] = { type: 0, value: val.v };
      pos = val.p;
    } else if (wireType === 1) {
      if (pos + 8 > s.length) {
        break;
      }
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(s, pos);
      if (!len) {
        break;
      }
      pos = len.p;
      if (pos + len.v > s.length) {
        break;
      }
      fields[fieldNum] = { type: 2, data: s.substring(pos, pos + len.v) };
      pos += len.v;
    } else if (wireType === 5) {
      if (pos + 4 > s.length) {
        break;
      }
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// SQLite credential reading — Antigravity wraps OAuth state in a
// double-base64 envelope:
//   b64(outer.f1 = wrapper{ f1=sentinel, f2=payload{ f1=b64(inner proto) } }).
// The inner base64 layer is the unusual part — it's a UTF-8 string field,
// not raw bytes.
// ---------------------------------------------------------------------------

function unwrapOAuthSentinel(base64Text: string): string | null {
  const trimmed = base64Text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const outer = readFields(Buffer.from(trimmed, 'base64').toString('binary'));
    if (!outer[1] || outer[1].type !== 2) {
      return null;
    }

    const wrapper = readFields(outer[1].data!);
    const sentinel = wrapper[1]?.type === 2 ? wrapper[1].data : null;
    const payload = wrapper[2]?.type === 2 ? wrapper[2].data : null;
    if (sentinel !== OAUTH_TOKEN_SENTINEL || !payload) {
      // Support the newer sentinel name as a fallback.
      if (sentinel !== 'authStateWithContextSentinelKey' || !payload) {
        return null;
      }
    }

    const payloadFields = readFields(payload);
    if (!payloadFields[1] || payloadFields[1].type !== 2) {
      return null;
    }

    const innerText = payloadFields[1].data!.trim();
    if (!innerText) {
      return null;
    }
    return Buffer.from(innerText, 'base64').toString('binary');
  } catch {
    return null;
  }
}

function loadOAuthTokens(dbPath: string): OAuthTokens | null {
  const raw = readDbValue(dbPath, OAUTH_TOKEN_KEY);
  if (!raw) {
    return null;
  }

  const inner = unwrapOAuthSentinel(raw);
  if (!inner) {
    return null;
  }

  const fields = readFields(inner);
  const accessToken = fields[1]?.type === 2 ? fields[1].data! : null;
  const refreshToken = fields[3]?.type === 2 ? fields[3].data! : null;
  let expirySeconds: number | null = null;
  if (fields[4]?.type === 2) {
    const ts = readFields(fields[4].data!);
    if (ts[1]?.type === 0) {
      expirySeconds = ts[1].value!;
    }
  }

  return accessToken || refreshToken ? { accessToken, refreshToken, expirySeconds } : null;
}

// ---------------------------------------------------------------------------
// LS discovery — find Antigravity language server processes on Windows/Linux.
//
// Key insight: the Antigravity LS exposes TWO servers on separate ports:
//   1. Extension server port (--extension_server_port) — NOT for gRPC calls
//   2. LS gRPC port — a DIFFERENT port the same process is listening on
//
// GetUserStatus must be called on the LS gRPC port (not the extension server
// port) using --csrf_token (not --extension_server_csrf_token).
// ---------------------------------------------------------------------------

function extractFlag(cmd: string, flag: string): string | null {
  const parts = cmd.split(/\s+/);
  const eq = `${flag}=`;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === flag && i + 1 < parts.length) {
      return parts[i + 1];
    }
    if (parts[i].startsWith(eq)) {
      return parts[i].slice(eq.length);
    }
  }
  return null;
}

function discoverLs(): LsDiscovery | null {
  if (process.platform === 'win32') {
    return discoverWindowsLs();
  }
  return discoverUnixLs();
}

function discoverWindowsLs(): LsDiscovery | null {
  const psPath = findPowershell();
  if (!psPath) {
    return null;
  }

  try {
    const script = `& { $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*antigravity*' } | Select-Object ProcessId, CommandLine); if ($procs.Count -eq 0) { '[]' } else { $procs | ConvertTo-Json -Compress } }`;
    const raw = execSync(`"${psPath}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();

    for (const item of parseJsonItems(raw)) {
      const cmd = item.CommandLine;
      if (!cmd || typeof cmd !== 'string') {
        continue;
      }

      const csrf = extractFlag(cmd, '--csrf_token');
      const extPortStr = extractFlag(cmd, '--extension_server_port');
      if (!csrf || !extPortStr) {
        continue;
      }

      const extensionPort = Number(extPortStr);
      if (!Number.isInteger(extensionPort) || extensionPort <= 0 || extensionPort >= 65536) {
        continue;
      }

      const pid = item.ProcessId;
      const lsPorts: number[] = [];

      // Discover all listening ports for this process.
      // The LS gRPC endpoint is on a different port than the extension server port.
      if (pid != null) {
        try {
          const portScript = `& { $ports = @(Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort); if ($ports.Count -eq 0) { '[]' } else { $ports | ConvertTo-Json -Compress } }`;
          const portsRaw = execSync(`"${psPath}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${portScript.replace(/"/g, '\\"')}"`, {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 10_000,
          }).trim();
          for (const parsed of parseJsonItems(portsRaw)) {
            const port = Number(parsed);
            if (Number.isInteger(port) && port > 0 && port < 65536 && port !== extensionPort) {
              lsPorts.push(port);
            }
          }
        } catch {
          // If port discovery fails, fall back to the extension port.
        }
      }

      return { lsPorts, csrf, extensionPort };
    }
  } catch {
    return null;
  }

  return null;
}

function discoverUnixLs(): LsDiscovery | null {
  const psPath = ['/usr/bin/ps', '/bin/ps'].find((p) => fs.existsSync(p));
  if (!psPath) {
    return null;
  }

  try {
    const stdout = execSync(`"${psPath}" aux`, { encoding: 'utf8', timeout: 5_000 });
    for (const line of stdout.split('\n')) {
      if (!line.includes('language_server') || !line.toLowerCase().includes('antigravity')) {
        continue;
      }
      const csrf = extractFlag(line, '--csrf_token');
      const extPortStr = extractFlag(line, '--extension_server_port');
      if (!csrf || !extPortStr) {
        continue;
      }
      const extensionPort = Number(extPortStr);
      if (!Number.isInteger(extensionPort) || extensionPort <= 0 || extensionPort >= 65536) {
        continue;
      }
      // On Linux/macOS, just try the extension port as fallback;
      // lsPorts could be discovered via `lsof` but keep it simple for now.
      return { lsPorts: [], csrf, extensionPort };
    }
  } catch {
    return null;
  }

  return null;
}

function findPowershell(): string | null {
  for (const envKey of ['WINDIR', 'SystemRoot']) {
    const root = process.env[envKey];
    if (!root) {
      continue;
    }
    for (const sub of ['System32', 'Sysnative']) {
      const candidate = `${root}\\${sub}\\WindowsPowerShell\\v1.0\\powershell.exe`;
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function parseJsonItems(raw: string): any[] {
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) {
      return value;
    }
    return value == null ? [] : [value];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Local HTTP helpers for LS calls
// ---------------------------------------------------------------------------

function requestLocalJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  acceptAnyStatus = false,
): Promise<any | true> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const bodyText = JSON.stringify(body ?? {});
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(bodyText).toString(),
        },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let responseText = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseText += chunk;
        });
        res.on('end', () => {
          if (acceptAnyStatus) {
            resolve(true);
            return;
          }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`LS returned HTTP ${status}`));
            return;
          }
          try {
            resolve(responseText ? JSON.parse(responseText) : {});
          } catch {
            reject(new Error('LS returned invalid JSON.'));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('LS request timed out.'));
    });
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
}

async function probePort(scheme: string, port: number, csrf: string): Promise<boolean> {
  try {
    await requestLocalJson(
      `${scheme}://127.0.0.1:${port}/${LS_SERVICE}/GetUnleashData`,
      {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
      },
      {
        context: {
          properties: {
            devMode: 'false',
            extensionVersion: 'unknown',
            ide: 'antigravity',
            ideVersion: 'unknown',
            os: process.platform,
          },
        },
      },
      5_000,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

async function findWorkingPort(
  discovery: LsDiscovery,
): Promise<{ port: number; scheme: 'https' | 'http' } | null> {
  // First try all discovered LS ports (these are NOT the extension server port).
  for (const port of discovery.lsPorts) {
    for (const scheme of ['http', 'https'] as const) {
      if (await probePort(scheme, port, discovery.csrf)) {
        return { port, scheme };
      }
    }
  }

  // Fall back to the extension server port itself.
  for (const scheme of ['http', 'https'] as const) {
    if (await probePort(scheme, discovery.extensionPort, discovery.csrf)) {
      return { port: discovery.extensionPort, scheme };
    }
  }

  return null;
}

async function callLs(
  port: number,
  scheme: 'https' | 'http',
  csrf: string,
  method: string,
  body: unknown,
): Promise<any | null> {
  try {
    return await requestLocalJson(
      `${scheme}://127.0.0.1:${port}/${LS_SERVICE}/${method}`,
      {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
      },
      body,
      10_000,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LS probe — try GetUserStatus then GetCommandModelConfigs
// ---------------------------------------------------------------------------

async function probeLs(): Promise<{ plan?: string | null; lines: MetricLine[] } | null> {
  const discovery = discoverLs();
  if (!discovery) {
    return null;
  }

  const found = await findWorkingPort(discovery);
  if (!found) {
    return null;
  }

  const metadata = {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    ideVersion: 'unknown',
    locale: 'en',
  };

  let data = await callLs(found.port, found.scheme, discovery.csrf, 'GetUserStatus', {
    metadata,
  });
  const hasUserStatus = Boolean(data?.userStatus);
  if (!hasUserStatus) {
    data = await callLs(found.port, found.scheme, discovery.csrf, 'GetCommandModelConfigs', {
      metadata,
    });
  }

  const configs = hasUserStatus
    ? data?.userStatus?.cascadeModelConfigData?.clientModelConfigs
    : data?.clientModelConfigs;
  if (!Array.isArray(configs)) {
    return null;
  }

  const lines = buildModelLines(
    configs
      .map((config: any) => ({
        label: typeof config?.label === 'string' ? config.label : '',
        remainingFraction: Number(config?.quotaInfo?.remainingFraction),
        resetTime:
          typeof config?.quotaInfo?.resetTime === 'string' ? config.quotaInfo.resetTime : null,
        modelId:
          typeof config?.modelOrAlias?.model === 'string' ? config.modelOrAlias.model : null,
      }))
      .filter(
        (config: ModelConfig) => config.label && !MODEL_BLACKLIST.has(config.modelId || ''),
      ),
  );

  if (lines.length === 0) {
    return null;
  }

  let plan: string | null = null;
  if (hasUserStatus) {
    const userTierName = data?.userStatus?.userTier?.name;
    const planName = data?.userStatus?.planStatus?.planInfo?.planName;
    plan =
      typeof userTierName === 'string' && userTierName.trim()
        ? userTierName.trim()
        : typeof planName === 'string' && planName.trim()
          ? planName.trim()
          : null;
  }

  return { plan, lines };
}

// ---------------------------------------------------------------------------
// Model line helpers
// ---------------------------------------------------------------------------

function normalizeLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function poolLabel(normalizedLabel: string): string {
  const lower = normalizedLabel.toLowerCase();
  if (lower.includes('gemini') && lower.includes('pro')) {
    return 'Gemini Pro';
  }
  if (lower.includes('gemini') && lower.includes('flash')) {
    return 'Gemini Flash';
  }
  return 'Claude';
}

function modelSortKey(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('gemini') && lower.includes('pro')) {
    return `0a_${label}`;
  }
  if (lower.includes('gemini')) {
    return `0b_${label}`;
  }
  if (lower.includes('claude') && lower.includes('opus')) {
    return `1a_${label}`;
  }
  if (lower.includes('claude')) {
    return `1b_${label}`;
  }
  return `2_${label}`;
}

function buildModelLines(configs: ModelConfig[]): MetricLine[] {
  const deduped = new Map<string, ModelConfig>();
  for (const config of configs) {
    const label = typeof config.label === 'string' ? config.label.trim() : '';
    if (!label) {
      continue;
    }
    const fraction = Number.isFinite(config.remainingFraction) ? config.remainingFraction : 0;
    const pool = poolLabel(normalizeLabel(label));
    const next: ModelConfig = {
      label: pool,
      remainingFraction: fraction,
      resetTime: config.resetTime ?? null,
    };
    const existing = deduped.get(pool);
    if (!existing || next.remainingFraction < existing.remainingFraction) {
      deduped.set(pool, next);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => modelSortKey(a.label).localeCompare(modelSortKey(b.label)))
    .map((model) => {
      const clamped = Math.max(0, Math.min(1, model.remainingFraction));
      return {
        type: 'progress',
        label: model.label,
        used: Math.round((1 - clamped) * 100),
        limit: 100,
        format: { kind: 'percent' },
        resetsAt: model.resetTime || null,
      };
    });
}

// ---------------------------------------------------------------------------
// Cloud Code API (token-based fallback when LS is not running)
// ---------------------------------------------------------------------------

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken) {
    return null;
  }

  const clientId = process.env.USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  try {
    const resp = await fetch(GOOGLE_OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return null;
    }

    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      return null;
    }

    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    cachedAccessToken = {
      token: data.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
    return data.access_token;
  } catch {
    return null;
  }
}

function loadCachedToken(): string | null {
  if (!cachedAccessToken || cachedAccessToken.expiresAtMs <= Date.now()) {
    cachedAccessToken = null;
    return null;
  }
  return cachedAccessToken.token;
}

async function probeCloudCode(token: string): Promise<any | null | { _authFailed: true }> {
  for (const baseUrl of CLOUD_CODE_URLS) {
    try {
      const resp = await fetch(`${baseUrl}${FETCH_MODELS_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity',
        },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });

      if (resp.status === 401 || resp.status === 403) {
        return { _authFailed: true };
      }
      if (resp.ok) {
        return resp.json();
      }
    } catch {
      // Try the next Cloud Code endpoint.
    }
  }
  return null;
}

function parseCloudCodeModels(data: any): ModelConfig[] {
  const models = data?.models;
  if (!models || typeof models !== 'object') {
    return [];
  }

  const configs: ModelConfig[] = [];
  for (const [key, model] of Object.entries(models) as [string, any][]) {
    if (!model || typeof model !== 'object' || model.isInternal) {
      continue;
    }
    const modelId = typeof model.model === 'string' ? model.model : key;
    if (MODEL_BLACKLIST.has(modelId)) {
      continue;
    }
    const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : '';
    if (!displayName) {
      continue;
    }
    configs.push({
      label: displayName,
      remainingFraction: Number(model?.quotaInfo?.remainingFraction),
      resetTime:
        typeof model?.quotaInfo?.resetTime === 'string' ? model.quotaInfo.resetTime : null,
      modelId,
    });
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Main probe entry point
// ---------------------------------------------------------------------------

export async function probeAntigravity(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const config = vscode.workspace.getConfiguration('usagedock');
  if (!config.get<boolean>(`${SETTINGS_KEY}.enabled`, true)) {
    throw new Error('Enable Antigravity quota tracking in UsageDock settings.');
  }

  const dbPath = getAntigravityDbPath();
  const dbTokens = dbPath && fs.existsSync(dbPath) ? loadOAuthTokens(dbPath) : null;

  // --- Strategy 1: LS probe (returns model data directly, no token needed) ---
  const lsResult = await probeLs();
  if (lsResult) {
    return lsResult;
  }

  // --- Strategy 2: Cloud Code API with tokens from the DB ---
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error('Antigravity not installed or not signed in.');
  }

  const tokens: string[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (dbTokens?.accessToken && (!dbTokens.expirySeconds || dbTokens.expirySeconds > nowSeconds)) {
    tokens.push(dbTokens.accessToken);
  }

  const cached = loadCachedToken();
  if (cached && !tokens.includes(cached)) {
    tokens.push(cached);
  }

  if (tokens.length === 0 && !dbTokens?.refreshToken) {
    throw new Error('Start Antigravity and try again.');
  }

  let cloudData: any | null = null;
  let sawAuthFailure = false;
  for (const token of tokens) {
    const nextData = await probeCloudCode(token);
    if (nextData && !nextData._authFailed) {
      cloudData = nextData;
      break;
    }
    if (nextData?._authFailed) {
      sawAuthFailure = true;
    }
  }

  if (!cloudData && dbTokens?.refreshToken && (sawAuthFailure || tokens.length === 0)) {
    const refreshed = await refreshAccessToken(dbTokens.refreshToken);
    if (refreshed) {
      const nextData = await probeCloudCode(refreshed);
      if (nextData && !nextData._authFailed) {
        cloudData = nextData;
      }
    }
  }

  if (cloudData) {
    const lines = buildModelLines(parseCloudCodeModels(cloudData));
    if (lines.length > 0) {
      return { plan: null, lines };
    }
  }

  throw new Error('Start Antigravity and try again.');
}
