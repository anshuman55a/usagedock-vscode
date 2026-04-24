/**
 * VS Code webview API wrapper.
 */

interface VsCodeApi {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
}

let api: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    // @ts-expect-error — acquireVsCodeApi is injected by the VS Code webview host
    api = acquireVsCodeApi();
  }
  return api!;
}
