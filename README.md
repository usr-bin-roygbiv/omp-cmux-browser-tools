# omp-cmux-browser-tools

`omp-cmux-browser-tools` exposes a small, safe browser tool layer over native `cmux browser` surfaces for OMP and Pi coding-agent sessions.

The package supports two current install surfaces, both of which expose the same six model-callable OMP tools:

- package/plugin installs through `package.json` `omp.extensions` and `pi.extensions`; the extension calls `pi.registerTool(...)`
- OMP marketplace installs through the Claude-compatible custom-tool factory in `tools/cmux-browser-tools/index.ts`

It is published from the anonymous Roy GitHub identity at `usr-bin-roygbiv/omp-cmux-browser-tools`. It is not published to npm.

## Tool-call exposure

After installation, these are OMP/Pi tool calls, not slash commands or prose-only prompt guidance. OMP discovers the plugin, loads the custom-tool factory or extension entrypoint, and sends each tool's description plus strict parameter schema through the normal model tool registry. No separate system-prompt snippet is required for agents to know the tools exist.

## Tools

| Tool | Purpose |
| --- | --- |
| `cmux_browser_open` | Open a native visible cmux browser surface for an `http:` or `https:` URL. |
| `cmux_browser_get_url` | Read the current URL from an explicit browser surface. |
| `cmux_browser_snapshot` | Capture `cmux browser snapshot --interactive` for an explicit surface. |
| `cmux_browser_wait` | Wait for load state, selector, text, exact URL, or URL substring with bounded timeout. |
| `cmux_browser_click` | Click a target selector/ref and return a post-action snapshot. |
| `cmux_browser_fill` | Fill a target selector/ref and return a post-action snapshot. |

## Requirements

- OMP/Pi `15.5.7` or newer in the `15.x` line.
- `cmux` installed and available on `PATH` for the agent process.
- A local cmux workspace capable of opening browser surfaces.

## Install

### OMP/Pi package install

This repository is not published to npm yet. The package manifest is prepared for package installs once published through an npm-compatible plugin source:

```bash
omp plugin install omp-cmux-browser-tools
```

Use the equivalent `pi plugin install ...` command in Pi-only environments. Package installs load `./extensions/index.ts` from the `omp.extensions` or `pi.extensions` manifest entry, and that extension registers the six tools with `pi.registerTool(...)`.

### Marketplace install

After the official marketplace entry is accepted, install it with either interactive marketplace commands:

```text
/marketplace add anthropics/claude-plugins-official
/marketplace install omp-cmux-browser-tools@claude-plugins-official
```

or CLI equivalents:

```bash
omp plugin marketplace add anthropics/claude-plugins-official
omp plugin install omp-cmux-browser-tools@claude-plugins-official
```

Marketplace installs load the Claude-compatible custom-tool factory at `tools/cmux-browser-tools/index.ts`.

### Local development load

From this repository root, load the extension explicitly in an owned development session:

```bash
omp -e "$PWD/extensions/index.ts"
```

Keep local absolute paths out of committed OMP/Pi configuration. If you use a local anonymous GitHub profile while publishing, keep machine-specific settings in untracked local config such as `GH_CONFIG_DIR=/path/to/roy-gh-config`.

## Safety contract

- Commands are executed with `spawnSync("cmux", ["--json", ...args])` style argv arrays; user input is never shell-interpolated.
- Navigation/open accepts only absolute `http:` and `https:` URLs.
- Every non-open tool requires an explicit browser `surface` ref (`surface:<number>` or UUID).
- Optional workspace/window refs are validated as `workspace:<number>`, `window:<number>`, or UUID.
- Waits and command execution use bounded timeouts.
- Returned stdout/stderr are redacted and truncated before being handed back to OMP/Pi.
- This package does not expose JavaScript eval, downloads/uploads, proxy changes, cookies/storage export, network interception, browser state save/load, or arbitrary shell execution.

## Local tests

```bash
bun test tests/*.test.ts
```

Repository verification for release runs through the configured Woodpecker pipeline.

## Smoke fixture

Serve the deterministic fixture from an owned local process:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory smoke
```

Then ask the OMP/Pi session that loaded the tools to:

1. Open `http://127.0.0.1:8765/test-page.html` with `cmux_browser_open`.
2. Verify the URL with `cmux_browser_get_url`.
3. Wait for page readiness with `cmux_browser_wait`.
4. Inspect the page with `cmux_browser_snapshot`.
5. Fill `#marker-input` with a marker such as `modified-by-omp-cmux-tool` using `cmux_browser_fill`.
6. Click `#apply-marker` using `cmux_browser_click`.
7. Re-snapshot and confirm `Applied marker: modified-by-omp-cmux-tool` is visible.

## Public metadata

- GitHub remote: `https://github.com/usr-bin-roygbiv/omp-cmux-browser-tools.git`.
- Repo-local author identity: `usr_bin_roygbiv <roy@davai.fyi>`.
- Public package metadata is intentionally anonymous and machine-path-free.
