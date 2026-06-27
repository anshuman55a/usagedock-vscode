import * as vscode from 'vscode';
import type { ProviderResult } from '../providers/types';

let statusBarItem: vscode.StatusBarItem | null = null;
let cachedProviders: ProviderResult[] = [];

export function createStatusBar() {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'usagedock.cycleStatusBarProvider';
  statusBarItem.text = '$(zap) UsageDock';
  statusBarItem.tooltip = 'Click to load providers. Run "UsageDock: Refresh All Providers".';
  statusBarItem.show();
}

/**
 * Returns the provider ID currently selected for display.
 * Falls back to the first connected provider, or the first provider overall.
 */
function getSelectedProviderId(providers: ProviderResult[]): string {
  const config = vscode.workspace.getConfiguration('usagedock');
  const explicit = config.get<string>('statusBar.provider', '');

  // If the user has an explicit selection and it exists in the list, use it
  if (explicit && providers.some((p) => p.id === explicit)) {
    return explicit;
  }

  // Auto: first connected provider with progress data
  const connected = providers.find(
    (p) => !p.error && p.lines.some((l) => l.type === 'progress'),
  );
  if (connected) { return connected.id; }

  // Fallback: first provider in the list
  return providers.length > 0 ? providers[0].id : '';
}

/**
 * Cycles to the next provider and persists the choice.
 */
export function cycleProvider() {
  if (cachedProviders.length === 0) { return; }

  const currentId = getSelectedProviderId(cachedProviders);
  const currentIdx = cachedProviders.findIndex((p) => p.id === currentId);
  const nextIdx = (currentIdx + 1) % cachedProviders.length;
  const nextId = cachedProviders[nextIdx].id;

  const config = vscode.workspace.getConfiguration('usagedock');
  config.update('statusBar.provider', nextId, vscode.ConfigurationTarget.Global);

  // Re-render immediately
  updateStatusBar(cachedProviders);
}

/**
 * Format a single provider's usage summary as a short string.
 */
function providerUsageSummary(p: ProviderResult): string {
  if (p.error) { return p.error.slice(0, 60); }

  const progLines = p.lines.filter((l) => l.type === 'progress');
  if (progLines.length === 0) { return 'Connected'; }

  return progLines
    .map((l) => {
      if (l.type !== 'progress') { return ''; }
      const pct = l.limit > 0 ? Math.round((l.used / l.limit) * 100) : 0;
      return `${l.label} ${pct}%`;
    })
    .join(', ');
}

/**
 * Build the primary usage percentage string for a provider (status bar text).
 */
function providerPct(p: ProviderResult): string | null {
  const prog = p.lines.find((l) => l.type === 'progress');
  if (!prog || prog.type !== 'progress') { return null; }
  const pct = prog.limit > 0 ? Math.round((prog.used / prog.limit) * 100) : 0;
  return `${pct}%`;
}

export function updateStatusBar(providers: ProviderResult[]) {
  if (!statusBarItem) { return; }
  cachedProviders = providers;

  const config = vscode.workspace.getConfiguration('usagedock');
  if (!config.get<boolean>('statusBar.enabled', true)) {
    statusBarItem.hide();
    return;
  }

  if (providers.length === 0) {
    statusBarItem.text = '$(zap) UsageDock';
    statusBarItem.tooltip = 'No providers loaded';
    statusBarItem.show();
    return;
  }

  // Selected provider
  const selectedId = getSelectedProviderId(providers);
  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];
  const pct = providerPct(selected);

  if (selected.error) {
    statusBarItem.text = `$(zap) ${selected.name} · N/A`;
  } else if (pct) {
    statusBarItem.text = `$(zap) ${selected.name} · ${pct}`;
  } else {
    statusBarItem.text = `$(zap) ${selected.name}`;
  }

  // ── Rich Markdown tooltip ──
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportThemeIcons = true;

  // Selected provider detail
  const selIcon = selected.error ? '$(warning)' : '$(check)';
  md.appendMarkdown(`**${selIcon} ${selected.name}**`);
  if (selected.plan) {
    md.appendMarkdown(` — ${selected.plan}`);
  }
  md.appendMarkdown('\n\n');

  if (selected.error) {
    md.appendMarkdown(`$(error) ${selected.error.slice(0, 100)}\n\n`);
  } else {
    const progLines = selected.lines.filter((l) => l.type === 'progress');
    for (const l of progLines) {
      if (l.type !== 'progress') { continue; }
      const p = l.limit > 0 ? Math.round((l.used / l.limit) * 100) : 0;
      md.appendMarkdown(`$(dashboard) ${l.label}: **${p}%**\n\n`);
    }
    if (progLines.length === 0) {
      md.appendMarkdown('$(check) Connected\n\n');
    }
  }

  // Divider
  md.appendMarkdown('---\n\n');

  // Other providers compact
  const others = providers.filter((p) => p.id !== selected.id);
  if (others.length > 0) {
    for (const p of others) {
      const icon = p.error ? '$(warning)' : '$(check)';
      const summary = providerUsageSummary(p);
      md.appendMarkdown(`${icon} ${p.name}: ${summary}\n\n`);
    }
    md.appendMarkdown('---\n\n');
  }

  md.appendMarkdown('*Click to switch provider*');

  statusBarItem.tooltip = md;
  statusBarItem.show();
}

export function disposeStatusBar() {
  statusBarItem?.dispose();
  statusBarItem = null;
}
