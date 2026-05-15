# UsageDock for VS Code

Keep your AI coding usage visible without leaving the editor.

UsageDock adds a compact local usage monitor for Cursor, Claude, GitHub Copilot, Codex, Windsurf, Antigravity, and Ollama directly inside VS Code. It reads supported local auth state and usage signals where allowed, then presents them in a focused sidebar view and status bar summary.

No UsageDock account. No hosted dashboard. No provider credentials sent to a UsageDock backend.

## Why Use It

- **Editor-native usage glance**: Check AI coding limits from the VS Code Activity Bar.
- **Local-first by design**: UsageDock reads local provider state on your machine.
- **Multi-provider view**: Cursor, Claude, Copilot, Codex, and Windsurf in one place.
- **Manual-first refresh**: Usage does not refresh on open by default. You control when scans run.
- **Configurable auto refresh**: Enable periodic refresh only if you want it.
- **Status bar signal**: See connected provider count and a headline usage metric at a glance.

## Supported Providers

| Provider | What UsageDock Reads | Requirement |
|---|---|---|
| Cursor | Local Cursor auth state and usage API | Cursor installed and signed in |
| Claude | Local Claude credentials | Claude CLI/app authenticated locally |
| GitHub Copilot | GitHub auth session in VS Code or GitHub CLI token | Copilot signed in to VS Code, or `gh auth login` completed |
| Codex | Local Codex auth state | Codex authenticated locally |
| Windsurf | Local Windsurf state and language server | Windsurf running and signed in |
| Antigravity | Local Antigravity auth state and model quota metadata | Antigravity installed and signed in |
| Ollama | Running model list, VRAM usage, and available model count | Ollama running locally or reachable at the configured URL |

Unavailable providers stay visible as connection states so you know what needs attention.

## Privacy

UsageDock is built around a local-first model:

- Provider credentials are read only from local files or local tools already present on your machine.
- UsageDock does not ask you to paste provider tokens into the extension.
- Antigravity quota is read from the same non-generating model quota metadata shown in Antigravity > Settings > Models > Model Quota.
- UsageDock does not operate a hosted backend for usage tracking.
- Usage data is rendered inside VS Code.
- Refresh behavior is controlled through VS Code settings.

Provider APIs may still receive requests required to fetch your usage, using the provider auth already available locally.

## Getting Started

1. Install the extension from the VS Code Marketplace or from a `.vsix` file.
2. Open the UsageDock icon in the Activity Bar.
3. Click **Refresh All Providers** to load usage.
4. Sign in to any provider that appears as unavailable.
5. Optional: open **UsageDock: Open Settings** to configure refresh behavior.

To install from a local VSIX:

```powershell
code --install-extension usagedock-0.1.0.vsix
```

## Settings

UsageDock intentionally does not refresh on open by default. You can change that from VS Code settings.

```jsonc
{
  "usagedock.autoRefresh.enabled": false,
  "usagedock.autoRefresh.intervalMinutes": 15,
  "usagedock.refreshOnOpen": false,
  "usagedock.statusBar.enabled": true,
  "usagedock.antigravity.enabled": true,
  "usagedock.ollama.url": "http://localhost:11434",
  "usagedock.ollama.apiKey": ""
}
```

| Setting | Default | Description |
|---|---:|---|
| `usagedock.autoRefresh.enabled` | `false` | Refresh usage on a timer. |
| `usagedock.autoRefresh.intervalMinutes` | `15` | Auto-refresh interval. Supported values: `5`, `10`, `15`, `30`, `60`. |
| `usagedock.refreshOnOpen` | `false` | Refresh when the UsageDock sidebar view opens. |
| `usagedock.statusBar.enabled` | `true` | Show UsageDock in the VS Code status bar. |
| `usagedock.antigravity.enabled` | `true` | Show Antigravity model quota tracking. |
| `usagedock.ollama.url` | `http://localhost:11434` | Ollama server URL. Use a remote URL for cloud-hosted Ollama. |
| `usagedock.ollama.apiKey` | _(empty)_ | API key for authenticated cloud Ollama servers. Leave empty for local Ollama. |

## Commands

Use these from the Command Palette:

- `UsageDock: Refresh All Providers`
- `UsageDock: Open Panel`
- `UsageDock: Open Settings`

## Notes

- GitHub Copilot usage requires the GitHub CLI to be installed and authenticated, or a GitHub account signed in to VS Code with Copilot access.
- Windsurf usage requires Windsurf to be running so its local language server can be reached.
- Antigravity quota checks fetch model quota metadata only; they do not send prompts or run generations, so checking quota should not consume quota.
- Antigravity OAuth refresh is optional and uses `USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID` and `USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET` when present; these values are not bundled in the extension.
- Remote environments such as SSH, containers, or Codespaces may not have access to the same local provider files as your desktop session.

### Ollama

UsageDock connects to your Ollama server and shows which models are currently loaded, their VRAM usage, and how many models are available locally. No tokens are consumed — UsageDock only calls the read-only status endpoints (`/api/version`, `/api/ps`, `/api/tags`).

**Local Ollama (default):** Just start Ollama. No configuration needed.

**Remote or cloud-hosted Ollama:** Set the server URL in VS Code settings:

```json
"usagedock.ollama.url": "https://your-cloud-ollama.example.com"
```

**Authenticated cloud Ollama** (e.g. Groq, Together AI, or any self-hosted instance with an API key):

```json
"usagedock.ollama.url": "https://your-cloud-ollama.example.com",
"usagedock.ollama.apiKey": "your-api-key-here"
```

The key is sent as `Authorization: Bearer <key>` on every request, which is the standard scheme for Ollama-compatible cloud APIs.

## Development

```powershell
npm install
npm run build
npx @vscode/vsce package
```

The generated `.vsix` can be installed locally or uploaded to the VS Code Marketplace.

## License

MIT
