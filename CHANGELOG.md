# Changelog

## 0.1.5

### UI Improvements
- Compact sidebar card layout: reduced provider icons to 24px, card padding to 8px, tighter margins throughout.
- Summary dots bar: colored dots above the card list give an at-a-glance usage health overview; clicking a dot scrolls to that provider's card.
- Single-metric providers now render their metric inline in the card header row, saving vertical space.
- Last-refreshed timestamp replaces the static status text ("Updated 2m ago"), updated every 30 seconds.
- Empty state now shows a "Refresh Now" CTA button instead of text-only instructions.
- Footer keyboard hint ("Press R to refresh") shown when providers are loaded.
- Compact error cards for unavailable providers now show the full error message (no truncation).

### Interactions
- Pressing `R` while the sidebar is focused refreshes all providers.
- Sidebar auto-refreshes on first open when no cached data is available (never shows empty on first use).
- `refreshOnOpen` setting now defaults to `true`.

### Visual Polish
- Progress bar shimmer animation plays once on load, not infinitely.
- Progress bar track height increased to 5px for better readability.

### Status Bar
- Status bar now shows the highest-usage metric for the selected provider (e.g. "Antigravity · Claude 60%").
- Status bar color reflects usage level: amber ≥50%, red ≥90%.
- Clicking the status bar item now opens a **quick-pick dropdown** to select which provider to display — replaces the blind cycle-through behavior.
- Removed the duplicate native refresh button from the sidebar title bar (webview refresh + R shortcut are sufficient).

### Ollama
- When an Ollama API key is set, the extension also queries the cloud `https://ollama.com/api/me` endpoint for richer account data (PascalCase fields: Plan, Name, Email).

### Marketplace & Release
- Improved discoverability: description updated, `categories` expanded, keywords reordered with highest-impact terms first.
- Added `.github/workflows/release.yml` for automated build + publish to VS Code Marketplace, Open VSX, and GitHub Releases on version tag push.


## 0.1.4

- Enhanced Ollama tracking: added cloud account usage from `/api/me` endpoint, showing session usage and weekly usage as progress bars when signed into an Ollama account.
- Added Ollama desktop SQLite DB reader (`db.sqlite`) to surface local message and session counts (today and all-time).
- Added `getOllamaDbPath()` with platform-aware paths for Windows, macOS, and Linux.

## 0.1.3

- Removed bundled Google OAuth client credentials from Antigravity support.
- Optional Antigravity token refresh now reads `USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID` and `USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET` from the environment.
- Switched Antigravity to use language-server quota first, then unified OAuth token plus Cloud Code metadata.
- Removed the earlier cached `antigravityAuthStatus` and manual quota fallback paths from the Antigravity provider.
- Made Antigravity prefer the local cached Model Quota data before language-server or network fallbacks.
- Bumped the VSIX version so VS Code installs a fresh extension copy with the Antigravity fix.
- Fixed Copilot Free quota parsing so `limited_user_quotas` is treated as remaining quota and chat usage renders as the used percentage.
- Added Inline Suggestions as a separate Copilot Free quota line and removed raw Copilot API response logging.

## 0.1.2

- Added Antigravity model quota tracking from the same non-generating metadata used by Antigravity settings.
- Kept quota checks read-only from a usage perspective: they fetch model quota metadata and do not run prompts or generations.
- Kept legacy manual Antigravity quota settings as a fallback when automatic quota metadata is unavailable.

## 0.1.1

- Added Marketplace-ready README content.
- Added missing command icon metadata for VS Code manifest validation.
- Packaged a slimmer VSIX by excluding development-only files.
- Kept UsageDock refresh behavior manual-first by default.

## 0.1.0

- Initial UsageDock VS Code extension release.
- Added sidebar usage panel and status bar summary.
- Added provider support for Cursor, Claude, GitHub Copilot, Codex, and Windsurf.
- Added configurable auto refresh, refresh-on-open, and status bar settings.
