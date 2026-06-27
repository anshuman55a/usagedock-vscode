## UsageDock VS Code Extension

`usagedock-vscode` is a VS Code extension that monitors AI coding tool usage across multiple providers. It runs inside the VS Code extension host and renders usage data in a sidebar webview.

### Architecture

- **Extension host**: Standard VS Code extension entry point in `src/extension.ts`.
- **Providers**: Each provider (Cursor, Claude, Copilot, Codex, Windsurf, Antigravity, Ollama) has its own probe in `src/providers/`.
- **Webview**: React-based sidebar panel in `src/views/`, communicates via `postMessage`.
- **SQLite**: Uses `better-sqlite3` for reading local provider databases (Cursor, Windsurf, Ollama desktop DB).
- **Build**: esbuild bundles the extension; webview is built separately.

### Provider-specific notes

- Cursor free-tier usage is supported. Cursor may return `planUsage.totalPercentUsed`, `autoPercentUsed`, `apiPercentUsed`, and `billingCycleEnd` without paid-plan dollar limits; this should render as included usage instead of `No usage data`.
- Copilot currently depends on GitHub CLI auth. `gh auth login` must be available for the provider to work.
- Codex and Copilot reset timing surfaced in the UI after backend/frontend timestamp alignment fixes.
- Claude is expected to work from code review, but live validation requires a real Claude-authenticated machine.
- Ollama supports both local and cloud usage monitoring. The `/api/me` endpoint returns basic account info for free plans; actual usage percentages require the settings page scraper fallback with an API key.

### Windsurf and Antigravity notes

Windsurf and Antigravity providers discover the local language server process via:
- **Windows**: PowerShell `Get-CimInstance Win32_Process` to find `language_server` processes, then `Get-NetTCPConnection` for port enumeration.
- **Linux/macOS**: `ps aux` output parsing.

Key rules:
- Do not select a candidate port just because a request can be sent to it.
- The correct endpoint selection rule is: only accept a candidate when `GetUserStatus` succeeds on that port and scheme.
- Trusted HTTPS is tried first; plain HTTP localhost fallback is required when the LS doesn't present a trusted cert.
- CSRF tokens extracted from process command lines are validated as alphanumeric strings (`/^[A-Za-z0-9_\-]{8,128}$/`).
- PowerShell paths are resolved from `WINDIR`/`SystemRoot` and validated against the expected `WindowsPowerShell\v1.0\powershell.exe` pattern.

### Current security status

- Security hardening has been applied:
  - `rejectUnauthorized` is only disabled for plain HTTP, not HTTPS connections
  - CSRF tokens from process discovery are validated for format
  - PowerShell path is pattern-validated before execution
  - API keys are format-validated before sending to external endpoints
  - Ollama URL is scheme-validated (`http:`/`https:` only)
  - CSP nonce uses `crypto.randomBytes` (not `Math.random`)
  - JSON parse calls on credential files have error boundaries
  - Webview `msg.id` is validated against the known provider ID set
  - Settings page HTML scraping uses bounded regex and response size caps
  - Server log reads are capped at 2 MB to prevent extension host blocking
- Open tradeoff: The Windsurf/Antigravity localhost fallback allows plain HTTP on loopback because the local LS may not present a trusted cert.

### Build and release

- Build the extension bundle: `node scripts/build-extension.mjs`
- Type check: `node node_modules/typescript/bin/tsc --noEmit`
- Package VSIX: `npx vsce package`
- The extension uses `better-sqlite3` as a native module; `sql.js` was removed as dead weight.

### Important implementation notes

- The Antigravity provider's Google OAuth client ID/secret are read from environment variables (`USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID`, `USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET`). These are intentionally NOT bundled in the extension source.
- All network requests use `AbortSignal.timeout()` to prevent hanging fetches.
- The webview CSP uses nonce-protected `script-src` and tightly scoped `localResourceRoots`.
- Provider data flows through the VS Code `postMessage` channel, not from the web.
- `refreshInFlight` deduplication prevents concurrent overlapping refresh storms.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
