import * as path from 'path';
import * as os from 'os';

/**
 * Platform-aware path helpers — ported from the Rust providers.
 */

export function getCursorDbPath(): string | null {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    return appdata
      ? path.join(appdata, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      : null;
  }
  if (process.platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  // macOS
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );
}

export function getWindsurfDbPaths(): string[] {
  const paths: string[] = [];
  let base: string | null = null;

  if (process.platform === 'win32') {
    base = process.env.APPDATA || null;
  } else if (process.platform === 'linux') {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  } else {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  }

  if (!base) {
    return paths;
  }

  paths.push(path.join(base, 'Windsurf', 'User', 'globalStorage', 'state.vscdb'));
  paths.push(path.join(base, 'Windsurf - Next', 'User', 'globalStorage', 'state.vscdb'));
  return paths;
}

export function getAntigravityDbPath(): string | null {
  let base: string | null = null;

  if (process.platform === 'win32') {
    base = process.env.APPDATA || null;
  } else if (process.platform === 'linux') {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  } else {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  }

  return base ? path.join(base, 'Antigravity', 'User', 'globalStorage', 'state.vscdb') : null;
}

export function getClaudeCredentialsPath(): string | null {
  const home = os.homedir();
  return home ? path.join(home, '.claude', '.credentials.json') : null;
}

export function getCodexAuthPaths(): string[] {
  const paths: string[] = [];
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    paths.push(path.join(codexHome, 'auth.json'));
    return paths;
  }
  const home = os.homedir();
  paths.push(path.join(home, '.config', 'codex', 'auth.json'));
  paths.push(path.join(home, '.codex', 'auth.json'));
  return paths;
}

export function getGhHostsPath(): string | null {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    return appdata ? path.join(appdata, 'GitHub CLI', 'hosts.yml') : null;
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'gh', 'hosts.yml');
}

export function getGhExecutablePath(): string | null {
  const fs = require('fs') as typeof import('fs');

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
    ];
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'GitHub CLI', 'gh.exe'));
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return null;
  }

  // Linux / macOS
  const candidates = ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}
