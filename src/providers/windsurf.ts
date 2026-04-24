import * as fs from 'fs';
import { execSync } from 'child_process';
import type { MetricLine } from './types';
import { getWindsurfDbPaths } from '../util/platform';
import { readDbValue } from '../util/sqlite';

function loadApiKey(dbPath: string): string | null {
  const raw = readDbValue(dbPath, 'windsurfAuthStatus');
  if (!raw) { return null; }
  try {
    const auth = JSON.parse(raw);
    const key = auth?.apiKey;
    return key && typeof key === 'string' && key.length > 0 ? key : null;
  } catch { return null; }
}

interface LsDiscovery { ports: number[]; csrf: string; version: string; }

function extractFlag(cmd: string, flag: string): string | null {
  const parts = cmd.split(/\s+/);
  const eq = `${flag}=`;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === flag && i + 1 < parts.length) { return parts[i + 1]; }
    if (parts[i].startsWith(eq)) { return parts[i].slice(eq.length); }
  }
  return null;
}

function parseLsArgs(text: string): { port: number; csrf: string } | null {
  const port = extractFlag(text, '--extension_server_port');
  const csrf = extractFlag(text, '--csrf_token');
  if (!port || !csrf) { return null; }
  const portNum = parseInt(port, 10);
  return isNaN(portNum) ? null : { port: portNum, csrf };
}

function discoverLs(variant: string): LsDiscovery | null {
  if (process.platform === 'win32') { return discoverWindowsLs(variant); }
  if (process.platform === 'linux') { return discoverLinuxLs(variant); }
  return null;
}

function discoverWindowsLs(variant: string): LsDiscovery | null {
  try {
    const psPath = findPowershell();
    if (!psPath) { return null; }
    const script = `& { $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*language_server*' } | Select-Object ProcessId, CommandLine); if ($procs.Count -eq 0) { '[]' } else { $procs | ConvertTo-Json -Compress } }`;
    const raw = execSync(`"${psPath}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, { windowsHide: true, encoding: 'utf-8', timeout: 15_000 }).trim();

    const items = parseJsonItems(raw);
    for (const item of items) {
      const cmd = item.CommandLine;
      if (!cmd || typeof cmd !== 'string') { continue; }
      const ideName = (extractFlag(cmd, '--ide_name') || '').toLowerCase();
      if (ideName !== variant) { continue; }
      const args = parseLsArgs(cmd);
      if (!args) { continue; }
      const version = extractFlag(cmd, '--windsurf_version') || 'unknown';
      const pid = item.ProcessId;
      let ports = [args.port];
      if (pid != null) {
        try {
          const portScript = `& { $ports = @(Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort); if ($ports.Count -eq 0) { '[]' } else { $ports | ConvertTo-Json -Compress } }`;
          const portsRaw = execSync(`"${psPath}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${portScript.replace(/"/g, '\\"')}"`, { windowsHide: true, encoding: 'utf-8', timeout: 10_000 }).trim();
          const parsed = parseJsonItems(portsRaw).map((v: any) => typeof v === 'number' ? v : null).filter((v: any): v is number => v != null && v > 0 && v < 65536);
          if (!parsed.includes(args.port)) { parsed.push(args.port); }
          ports = [...new Set(parsed)];
        } catch { /* keep default ports */ }
      }
      return { ports, csrf: args.csrf, version };
    }
  } catch { /* discovery failed */ }
  return null;
}

function discoverLinuxLs(variant: string): LsDiscovery | null {
  try {
    const psPath = ['/usr/bin/ps', '/bin/ps'].find(p => fs.existsSync(p));
    if (!psPath) { return null; }
    const stdout = execSync(`"${psPath}" aux`, { encoding: 'utf-8', timeout: 5_000 });
    for (const line of stdout.split('\n')) {
      if (!line.includes('language_server')) { continue; }
      const ideName = (extractFlag(line, '--ide_name') || '').toLowerCase();
      if (ideName !== variant) { continue; }
      const args = parseLsArgs(line);
      if (!args) { continue; }
      return { ports: [args.port], csrf: args.csrf, version: 'unknown' };
    }
  } catch { /* discovery failed */ }
  return null;
}

function findPowershell(): string | null {
  for (const envKey of ['WINDIR', 'SystemRoot']) {
    const root = process.env[envKey];
    if (!root) { continue; }
    for (const sub of ['System32', 'Sysnative']) {
      const p = `${root}\\${sub}\\WindowsPowerShell\\v1.0\\powershell.exe`;
      if (fs.existsSync(p)) { return p; }
    }
  }
  return null;
}

function parseJsonItems(raw: string): any[] {
  try {
    const val = JSON.parse(raw);
    if (Array.isArray(val)) { return val; }
    if (val == null) { return []; }
    return [val];
  } catch { return []; }
}

async function callGetUserStatus(port: number, scheme: string, csrf: string, apiKey: string, ideName: string, version: string): Promise<any> {
  const url = `${scheme}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const body = JSON.stringify({ metadata: { apiKey, ideName, ideVersion: version, extensionName: ideName, extensionVersion: version, locale: 'en' } });

  // For localhost with self-signed certs, Node's fetch won't work with invalid certs by default.
  // We use the http/https modules for more control when needed.
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) { throw new Error(`LS returned HTTP ${resp.status}`); }
  return resp.json();
}

async function tryUserStatusCandidates(discovery: LsDiscovery, apiKey: string, ideName: string, includeHttp: boolean): Promise<any | null> {
  const schemes = includeHttp ? ['https', 'http'] : ['https'];
  for (const port of discovery.ports) {
    for (const scheme of schemes) {
      try {
        return await callGetUserStatus(port, scheme, discovery.csrf, apiKey, ideName, discovery.version);
      } catch { /* try next */ }
    }
  }
  return null;
}

export async function probeWindsurf(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const dbPaths = getWindsurfDbPaths();
  let apiKey: string | null = null;
  let variantName = 'windsurf';

  for (let i = 0; i < dbPaths.length; i++) {
    if (fs.existsSync(dbPaths[i])) {
      const key = loadApiKey(dbPaths[i]);
      if (key) { apiKey = key; variantName = i === 0 ? 'windsurf' : 'windsurf-next'; break; }
    }
  }
  if (!apiKey) { throw new Error('Windsurf not installed or not signed in.'); }

  const discovery = discoverLs(variantName);
  if (!discovery) { throw new Error('Windsurf language server not running. Start Windsurf and try again.'); }

  // Try trusted HTTPS first, then fall back to HTTP on loopback
  let data = await tryUserStatusCandidates(discovery, apiKey, variantName, false);
  if (!data) { data = await tryUserStatusCandidates(discovery, apiKey, variantName, true); }
  if (!data) { throw new Error('Could not connect to Windsurf language server.'); }

  const userStatus = data.userStatus;
  if (!userStatus) { throw new Error('No user status in LS response.'); }

  const planStatus = userStatus.planStatus || {};
  const planInfo = planStatus.planInfo || {};
  const plan = planInfo.planName || undefined;
  const planEnd = planStatus.planEnd || null;
  const lines: MetricLine[] = [];

  const promptTotal = planStatus.availablePromptCredits;
  const promptUsed = planStatus.usedPromptCredits ?? 0;
  if (promptTotal != null && promptTotal > 0) {
    lines.push({ type: 'progress', label: 'Prompt credits', used: promptUsed / 100, limit: promptTotal / 100, format: { kind: 'count', suffix: 'credits' }, resetsAt: planEnd });
  }

  const flexTotal = planStatus.availableFlexCredits;
  const flexUsed = planStatus.usedFlexCredits ?? 0;
  if (flexTotal != null && flexTotal > 0) {
    lines.push({ type: 'progress', label: 'Flex credits', used: flexUsed / 100, limit: flexTotal / 100, format: { kind: 'count', suffix: 'credits' }, resetsAt: null });
  }

  if (lines.length === 0) {
    lines.push({ type: 'badge', label: 'Credits', text: 'Unlimited', color: '#22c55e' });
  }
  return { plan, lines };
}
