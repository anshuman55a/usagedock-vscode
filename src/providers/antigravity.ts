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

interface ProtoFields {
  get(field: number): Buffer[];
  getVarint(field: number): number | null;
}

interface OAuthTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expirySeconds: number | null;
}

interface LsDiscovery {
  ports: number[];
  csrf: string;
  extensionPort?: number | null;
}

interface ModelConfig {
  label: string;
  remainingFraction: number;
  resetTime?: string | null;
  modelId?: string | null;
}

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

function readVarint(data: Buffer, start: number): [number, number] | null {
  let value = 0;
  let multiplier = 1;
  let pos = start;

  while (pos < data.length) {
    const byte = data[pos++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return [value, pos];
    }
    multiplier *= 128;
    if (multiplier > Number.MAX_SAFE_INTEGER / 128) {
      return null;
    }
  }

  return null;
}

function readProtoFields(data: Buffer): ProtoFields {
  const fields = new Map<number, Buffer[]>();
  const varints = new Map<number, number[]>();
  let pos = 0;

  while (pos < data.length) {
    const tag = readVarint(data, pos);
    if (!tag) {
      break;
    }
    pos = tag[1];

    const fieldNumber = Math.floor(tag[0] / 8);
    const wireType = tag[0] % 8;
    let value: Buffer | null = null;

    if (wireType === 0) {
      const varint = readVarint(data, pos);
      if (!varint) {
        break;
      }
      pos = varint[1];
      const existing = varints.get(fieldNumber) ?? [];
      existing.push(varint[0]);
      varints.set(fieldNumber, existing);
      value = Buffer.from(String(varint[0]));
    } else if (wireType === 1) {
      const end = pos + 8;
      if (end > data.length) {
        break;
      }
      value = data.subarray(pos, end);
      pos = end;
    } else if (wireType === 2) {
      const length = readVarint(data, pos);
      if (!length) {
        break;
      }
      pos = length[1];
      const end = pos + length[0];
      if (end > data.length) {
        break;
      }
      value = data.subarray(pos, end);
      pos = end;
    } else if (wireType === 5) {
      const end = pos + 4;
      if (end > data.length) {
        break;
      }
      value = data.subarray(pos, end);
      pos = end;
    } else {
      break;
    }

    const existing = fields.get(fieldNumber) ?? [];
    existing.push(value);
    fields.set(fieldNumber, existing);
  }

  return {
    get(field: number) {
      return fields.get(field) ?? [];
    },
    getVarint(field: number) {
      return varints.get(field)?.[0] ?? null;
    },
  };
}

function unwrapOAuthSentinel(base64Text: string): Buffer | null {
  const trimmed = base64Text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const outer = readProtoFields(Buffer.from(trimmed, 'base64'));
    const wrapperBytes = outer.get(1)[0];
    if (!wrapperBytes) {
      return null;
    }

    const wrapper = readProtoFields(wrapperBytes);
    const sentinel = wrapper.get(1)[0]?.toString('utf8') ?? null;
    const payload = wrapper.get(2)[0];
    if (sentinel !== OAUTH_TOKEN_SENTINEL || !payload) {
      return null;
    }

    const payloadFields = readProtoFields(payload);
    const innerText = payloadFields.get(1)[0]?.toString('utf8').trim();
    return innerText ? Buffer.from(innerText, 'base64') : null;
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

  const fields = readProtoFields(inner);
  const accessToken = fields.get(1)[0]?.toString('utf8') || null;
  const refreshToken = fields.get(3)[0]?.toString('utf8') || null;
  let expirySeconds: number | null = null;

  const expiryMessage = fields.get(4)[0];
  if (expiryMessage) {
    expirySeconds = readProtoFields(expiryMessage).getVarint(1);
  }

  return accessToken || refreshToken ? { accessToken, refreshToken, expirySeconds } : null;
}

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

function parseLsArgs(text: string): { port: number; csrf: string } | null {
  const port = extractFlag(text, '--extension_server_port');
  const csrf = extractFlag(text, '--csrf_token');
  if (!port || !csrf) {
    return null;
  }
  const portNum = Number(port);
  return Number.isInteger(portNum) && portNum > 0 && portNum < 65536 ? { port: portNum, csrf } : null;
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
      const args = parseLsArgs(cmd);
      if (!args) {
        continue;
      }

      const pid = item.ProcessId;
      const ports = new Set<number>([args.port]);
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
            if (Number.isInteger(port) && port > 0 && port < 65536) {
              ports.add(port);
            }
          }
        } catch {
          // Keep the command-line port.
        }
      }

      return { ports: [...ports], csrf: args.csrf, extensionPort: args.port };
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
      const args = parseLsArgs(line);
      if (args) {
        return { ports: [args.port], csrf: args.csrf, extensionPort: args.port };
      }
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

function requestLocalJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, acceptAnyStatus = false): Promise<any | true> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const bodyText = JSON.stringify(body ?? {});
    const req = client.request({
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
    }, (res) => {
      let responseText = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseText += chunk; });
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
    });
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

async function findWorkingPort(discovery: LsDiscovery): Promise<{ port: number; scheme: 'https' | 'http' } | null> {
  for (const port of discovery.ports) {
    if (await probePort('https', port, discovery.csrf)) {
      return { port, scheme: 'https' };
    }
    if (await probePort('http', port, discovery.csrf)) {
      return { port, scheme: 'http' };
    }
  }

  return discovery.extensionPort ? { port: discovery.extensionPort, scheme: 'http' } : null;
}

async function callLs(port: number, scheme: 'https' | 'http', csrf: string, method: string, body: unknown): Promise<any | null> {
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

  let data = await callLs(found.port, found.scheme, discovery.csrf, 'GetUserStatus', { metadata });
  const hasUserStatus = Boolean(data?.userStatus);
  if (!hasUserStatus) {
    data = await callLs(found.port, found.scheme, discovery.csrf, 'GetCommandModelConfigs', { metadata });
  }

  const configs = hasUserStatus
    ? data?.userStatus?.cascadeModelConfigData?.clientModelConfigs
    : data?.clientModelConfigs;
  if (!Array.isArray(configs)) {
    return null;
  }

  const lines = buildModelLines(configs.map((config: any) => ({
    label: typeof config?.label === 'string' ? config.label : '',
    remainingFraction: Number(config?.quotaInfo?.remainingFraction),
    resetTime: typeof config?.quotaInfo?.resetTime === 'string' ? config.quotaInfo.resetTime : null,
    modelId: typeof config?.modelOrAlias?.model === 'string' ? config.modelOrAlias.model : null,
  })).filter((config: ModelConfig) => config.label && !MODEL_BLACKLIST.has(config.modelId || '')));

  if (lines.length === 0) {
    return null;
  }

  let plan: string | null = null;
  if (hasUserStatus) {
    const userTierName = data?.userStatus?.userTier?.name;
    const planName = data?.userStatus?.planStatus?.planInfo?.planName;
    plan = typeof userTierName === 'string' && userTierName.trim()
      ? userTierName.trim()
      : typeof planName === 'string' && planName.trim()
        ? planName.trim()
        : null;
  }

  return { plan, lines };
}

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

    const data = await resp.json() as { access_token?: string; expires_in?: number };
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
      resetTime: typeof model?.quotaInfo?.resetTime === 'string' ? model.quotaInfo.resetTime : null,
      modelId,
    });
  }
  return configs;
}

export async function probeAntigravity(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const config = vscode.workspace.getConfiguration('usagedock');
  if (!config.get<boolean>(`${SETTINGS_KEY}.enabled`, true)) {
    throw new Error('Enable Antigravity quota tracking in UsageDock settings.');
  }

  const dbPath = getAntigravityDbPath();
  const dbTokens = dbPath && fs.existsSync(dbPath) ? loadOAuthTokens(dbPath) : null;

  const lsResult = await probeLs();
  if (lsResult) {
    return lsResult;
  }

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
