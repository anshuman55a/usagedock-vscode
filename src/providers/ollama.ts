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

async function ollamaFetch(url: string): Promise<any> {
  const apiKey = getOllamaApiKey();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(5_000), // 5 s — may be remote
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Ollama auth failed (HTTP ${resp.status}). Check usagedock.ollama.apiKey.`);
  }
  if (!resp.ok) {
    throw new Error(`Ollama request failed (HTTP ${resp.status})`);
  }
  return resp.json();
}

// ── Probe ─────────────────────────────────────────────────────────

export async function probeOllama(): Promise<{ plan?: string | null; lines: MetricLine[] }> {
  const base = getOllamaBaseUrl();

  // 1. Version — also serves as the liveness check.
  //    If Ollama is not running this fetch will reject; the engine wraps it in a try/catch
  //    and surfaces the card as unavailable.
  let version = '';
  try {
    const v = await ollamaFetch(`${base}/api/version`) as { version?: string };
    version = v.version ?? '';
  } catch {
    throw new Error(`Ollama not running at ${base}. Start Ollama and try again.`);
  }

  // 2. Running models (`/api/ps`)
  let runningModels: any[] = [];
  try {
    const ps = await ollamaFetch(`${base}/api/ps`) as { models?: any[] };
    runningModels = ps.models ?? [];
  } catch {
    // Non-fatal — old Ollama versions may not have /api/ps; just show 0 loaded
  }

  // 3. Available models (`/api/tags`)
  let availableCount = 0;
  try {
    const tags = await ollamaFetch(`${base}/api/tags`) as { models?: any[] };
    availableCount = (tags.models ?? []).length;
  } catch {
    // Non-fatal
  }

  // ── Build metric lines ─────────────────────────────────────────
  const lines: MetricLine[] = [];

  // Status badge
  const versionLabel = version ? `Running (v${version})` : 'Running';
  lines.push({ type: 'badge', label: 'Server', text: versionLabel, color: '#4ade80' });

  // Model count summary
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

    // Build detail string:  "4.9 GB VRAM · 7.2B · Q4_0"
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
    lines.push({
      type: 'text',
      label: name,
      value: detail,
    });
  }

  return { plan: null, lines };
}
