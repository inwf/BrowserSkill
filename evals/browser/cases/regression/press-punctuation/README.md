# Punctuation shortcuts on Monaco's public playground

Regression for #623. The current extension can return success for `press Ctrl+/`
while Monaco receives `code: ""` and `keyCode: 0` and leaves the document unchanged.
The fixed descriptor lets the editor toggle the first line's comment. A second
press restores the complete original document. `Ctrl+]` and `Ctrl+[` similarly
indent and outdent the line.

This opt-in test opens the existing JavaScript editor at
<https://microsoft.github.io/monaco-editor/playground.html?source=v0.55.1#example-creating-the-editor-hello-world>.
It uses the full CLI/IPC/daemon/WebSocket/installed-extension path. The website
provides the document, controls and shortcut handlers. CDP reads model values and
adds a passive event observer; all focus and editing actions use `bsk press`.
The test also verifies plain `/`, `?`, `+`, `!` and Unicode insertion and deletion.

Requirements: Node 22+, pnpm, a compatible `bsk` binary, Chrome for Testing, and
network access to the Monaco site and its dependencies. The test owns its browser
profile and daemon home. It does not connect to an existing browser. This live-site
check is separate from offline CI because the website can change or be unavailable.

From the repository root:

```sh
mkdir -p dist/press-runtime
BSK_DAEMON_WS_URL=ws://127.0.0.1:52964 pnpm --filter @browser-skill/extension build
TMPDIR="$PWD/dist/press-runtime" \
BSK_PRESS_CHROME=/path/to/chrome \
BSK_PRESS_BSK=/path/to/bsk \
node evals/browser/cases/regression/press-punctuation/run.mjs
```

`BSK_PRESS_PORT` must match the extension's build-time port.
`BSK_PRESS_EXTENSION` selects a separately built extension, and `BSK_PRESS_OUTPUT`
selects the artifact directory. `BSK_PRESS_BASELINE=1` asserts the original failure
behavior for a before/after comparison. The default mode asserts the fixed behavior
and fails against the original extension.

Artifacts include exact editor values, trusted keydown/keyup events, CLI responses
and daemon logs. Set `BSK_PRESS_VIDEO=1` with `ffmpeg` installed to save a silent
`monaco.mp4` of the two comment shortcuts. The video uses Chrome's screencast frames
and their timestamps. It includes no injected labels or replacement webpage.
