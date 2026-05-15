# Changelog

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
