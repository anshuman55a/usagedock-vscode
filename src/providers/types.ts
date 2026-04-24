/**
 * Provider data types — mirrored from the Tauri backend (providers/mod.rs).
 */

export interface MetricFormat {
  kind: 'percent' | 'dollars' | 'count';
  suffix?: string;
}

export interface ProgressLine {
  type: 'progress';
  label: string;
  used: number;
  limit: number;
  format: MetricFormat;
  resetsAt?: string | null;
}

export interface TextLine {
  type: 'text';
  label: string;
  value: string;
}

export interface BadgeLine {
  type: 'badge';
  label: string;
  text: string;
  color?: string;
}

export type MetricLine = ProgressLine | TextLine | BadgeLine;

export interface ProviderResult {
  id: string;
  name: string;
  icon: string;
  brandColor: string;
  plan?: string | null;
  lines: MetricLine[];
  error?: string | null;
}

export interface ProviderMeta {
  id: string;
  name: string;
  icon: string;
  brandColor: string;
}
