import type { ProviderMeta, ProviderResult } from './types';
import { probeCursor } from './cursor';
import { probeClaude } from './claude';
import { probeCopilot } from './copilot';
import { probeCodex } from './codex';
import { probeWindsurf } from './windsurf';

const PROVIDERS: ProviderMeta[] = [
  { id: 'cursor', name: 'Cursor', icon: 'cursor', brandColor: '#000000' },
  { id: 'claude', name: 'Claude', icon: 'claude', brandColor: '#D97757' },
  { id: 'copilot', name: 'Copilot', icon: 'copilot', brandColor: '#000000' },
  { id: 'codex', name: 'Codex', icon: 'codex', brandColor: '#000000' },
  { id: 'windsurf', name: 'Windsurf', icon: 'windsurf', brandColor: '#00B4D8' },
];

const PROBE_MAP: Record<string, () => Promise<{ plan?: string | null; lines: import('./types').MetricLine[] }>> = {
  cursor: probeCursor,
  claude: probeClaude,
  copilot: probeCopilot,
  codex: probeCodex,
  windsurf: probeWindsurf,
};

export function listProviders(): ProviderMeta[] {
  return PROVIDERS;
}

export async function probeSingle(id: string): Promise<ProviderResult> {
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) {
    return {
      id,
      name: id,
      icon: '',
      brandColor: '#666',
      lines: [],
      error: `Unknown provider: ${id}`,
    };
  }

  const probeFn = PROBE_MAP[id];
  if (!probeFn) {
    return { ...meta, lines: [], error: `No probe for provider: ${id}` };
  }

  try {
    const { plan, lines } = await probeFn();
    return { ...meta, plan, lines, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...meta, plan: null, lines: [], error: message };
  }
}

export async function probeAll(): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];
  for (const meta of PROVIDERS) {
    results.push(await probeSingle(meta.id));
  }
  return results;
}
