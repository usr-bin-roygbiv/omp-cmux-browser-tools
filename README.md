# omp-cmux-browser-tools

`omp-cmux-browser-tools` exposes a small, safe cmux help and browser tool layer over native `cmux` surfaces for OMP and Pi coding-agent sessions.

The package supports two current install surfaces, both of which expose the same eighteen model-callable OMP tools:

- package/plugin installs through `package.json` `omp.extensions` and `pi.extensions`; the extension calls `pi.registerTool(...)`
- OMP marketplace installs through the custom-tool factory in `tools/cmux-browser-tools/index.ts`

It is published from the anonymous Roy GitHub identity at `usr-bin-roygbiv/omp-cmux-browser-tools`. It is not published to npm.

## Tool-call exposure

After installation, these are OMP/Pi tool calls, not slash commands or prose-only prompt guidance. OMP discovers the plugin, loads the custom-tool factory or extension entrypoint, and sends each tool's description plus strict parameter schema through the normal model tool registry. No separate system-prompt snippet is required for agents to know the tools exist.

## Tools

| Tool | Purpose |
| --- | --- |
| `cmux_help` | Read bounded cmux CLI help for terminal I/O, layout, browser, notification, markdown, and session commands. |
| `cmux_browser_open` | Open a native visible cmux browser surface for an `http:` or `https:` URL. |
| `cmux_browser_get_url` | Read the current URL from an explicit browser surface. |
| `cmux_browser_goto` | Navigate an existing browser surface to an `http:` or `https:` URL and return a post-navigation snapshot. |
| `cmux_browser_back` | Navigate an explicit browser surface backward. |
| `cmux_browser_forward` | Navigate an explicit browser surface forward. |
| `cmux_browser_reload` | Reload an explicit browser surface. |
| `cmux_browser_snapshot` | Capture `cmux browser snapshot --interactive` for an explicit surface. |
| `cmux_browser_wait` | Wait for load state, selector, text, exact URL, or URL substring. |
| `cmux_browser_find` | Locate elements with bounded cmux locator kinds: role, text, label, placeholder, alt, title, testid, first, last, or nth. |
| `cmux_browser_get` | Read bounded browser state: URL, title, text, HTML, value, attribute, count, box, or styles. |
| `cmux_browser_is` | Check whether an element is visible, enabled, or checked without taking a full snapshot. |
| `cmux_browser_click` | Click a target selector/ref and return a post-action snapshot. |
| `cmux_browser_fill` | Fill a target selector/ref and return a post-action snapshot. |
| `cmux_browser_press` | Press a bounded keyboard key such as `Enter` and return a post-action snapshot. |
| `cmux_browser_select` | Select a dropdown option by selector/value and return a post-action snapshot. |
| `cmux_browser_scroll` | Scroll by small signed deltas and return a post-action snapshot. |
| `cmux_browser_screenshot` | Capture visual proof to `_artifacts-local/omp-cmux-browser-tools-eval/` only. |

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

Use the equivalent `pi plugin install ...` command in Pi-only environments. Package installs load `./extensions/index.ts` from the `omp.extensions` or `pi.extensions` manifest entry, and that extension registers the tools with `pi.registerTool(...)`.

### OMP marketplace install

No public marketplace listing is active yet. For now, keep publishing updates to this GitHub repository and install through an owned OMP marketplace catalog once one is configured:

```bash
omp plugin marketplace add <omp-marketplace-catalog>
omp plugin install omp-cmux-browser-tools@<omp-marketplace-name>
```

Marketplace installs load the custom-tool factory at `tools/cmux-browser-tools/index.ts`.

### Local development load

From this repository root, load the extension explicitly in an owned development session:

```bash
omp -e "$PWD/extensions/index.ts"
```

Keep local absolute paths out of committed OMP/Pi configuration. If you use a local anonymous GitHub profile while publishing, keep machine-specific settings in untracked local config such as `GH_CONFIG_DIR=/path/to/roy-gh-config`.

## Safety contract

- Commands are executed with `spawnSync("cmux", args)` style argv arrays; user input is never shell-interpolated.
- `cmux_help` is read-only and accepts only bounded command-token paths such as `browser` or `browser wait`.
- Navigation/open accepts only absolute `http:` and `https:` URLs.
- Every non-open browser tool requires an explicit browser `surface` ref (`surface:<number>` or UUID).
- Optional workspace/window refs are validated as `workspace:<number>`, `window:<number>`, or UUID.
- Find/get/is/action inputs use bounded enums and max lengths; no arbitrary browser eval is exposed.
- Screenshot output is restricted to `_artifacts-local/omp-cmux-browser-tools-eval/`; path traversal and arbitrary absolute paths are rejected.
- Waits and command execution use bounded timeouts.
- Returned stdout/stderr are redacted and truncated before being handed back to OMP/Pi.
- This package does not expose arbitrary shell execution, standalone JavaScript eval, downloads/uploads, proxy changes, cookies/storage export, network interception, browser state save/load, profile import, tab lifecycle, or arbitrary cmux command execution. `cmux_browser_wait` accepts only load state, selector, text, exact URL, or URL-substring waits; it does not expose cmux's JavaScript `--function` wait path.

## Local tests and evals

```bash
bun test tests/*.test.ts
bun run test:interactive
CMUX_EVAL_MODEL=gpt-proxy/gpt-5.5 bun run eval:cmux-browsergym
```

`bun run test:interactive` drives every exposed tool against a real cmux browser surface and writes screenshot proof under `_artifacts-local/omp-cmux-browser-tools-eval/<run-id>/`. `bun run eval:cmux-browsergym` serves the same deterministic fixture over `127.0.0.1` and launches dev OMP in JSON mode with `--plugin-dir .`, `--auto-approve`, and a bounded tool list so provider/model tool calls are recorded as artifacts.

The eval is BrowserGym/MiniWoB action-space-compatible local coverage through OMP + native cmux browser surfaces. It is intentionally not BrowserGym's native Playwright environment because this plugin's contract is to let OMP drive visible cmux surfaces.

Provider-backed evals can consume model quota and are explicit. Precommit does not run them unless `CMUX_PRECOMMIT_MODEL_EVAL=1` is set.

Install the tracked hook with:

```bash
git config core.hooksPath .githooks
```

The hook delegates to `bun run precommit`, which runs unit tests plus interactive cmux smoke by default. It fails with an actionable message if cmux is unavailable; emergency-only bypass is `CMUX_PRECOMMIT_SKIP_INTERACTIVE=1`.

## Smoke fixture

The maintained interactive smoke and eval fixtures live under `evals/browsergym-action-space/`. The older `smoke/test-page.html` remains a minimal installed-plugin fixture for marketplace/runtime smoke checks.

The full interactive smoke verifies:

1. `cmux_help`, open, URL read, wait, and snapshot.
2. Navigation through goto, back, forward, and reload.
3. Read-only inspection through find, get, and is.
4. Form mutation through fill/click, keyboard submission through press, dropdown selection through select, and offscreen movement through scroll.
5. Screenshot artifact creation through `cmux_browser_screenshot`.

All visual proof paths are reported in the run summary JSON.

## Public metadata

- GitHub remote: `https://github.com/usr-bin-roygbiv/omp-cmux-browser-tools.git`.
- Repo-local author identity: `usr_bin_roygbiv <roy@davai.fyi>`.
- Public package metadata is intentionally anonymous and machine-path-free.
