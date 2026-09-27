# Amicode CLI

Amicode also ships as a terminal client. `amicode` is one command on `PATH`
with a foreground TUI — no editor, no webview. It assembles the same session
[`extension.ts`](../packages/extension/src/extension.ts) builds for VS Code —
the same platform skills, vault context, and `amico-run` solves — and hands it
straight to the vendored `opencode` binary. `amico` stays the bookkeeping CLI;
`amicode` is the chat-and-solve one.

Out of this build: the webview, Run Inspector, device panels, and the
extension-host `/amicode/*` service — those stay editor-only. Chat, skills,
vault context, `amicode_*` tools, and `amico-run` solves all work from the
terminal exactly as they do in VS Code.

## Install

Two paths, both idempotent — a second run replaces the same version tree and
relinks the command:

- **From a checkout.** [`packages/amicode-cli`](../packages/amicode-cli) is a
  workspace package; its asset root defaults to the sibling `packages/extension`
  tree (override with `AMICODE_ASSET_ROOT`). No separate install step needed.
- **Standalone.** [`install.sh`](../packages/amicode-cli/install.sh) copies a
  versioned tree — the vendored `opencode` binary, the whole `opencode-plugin/`
  directory, skills, packs, scores, templates, the Julia project files, and the
  bundled `bin/dist/amicode.cjs` — into `~/.local/share/amicode/<version>/` and
  links `~/.local/bin/amicode`.
  [`remote-install.sh`](../packages/amicode-cli/remote-install.sh) does the same
  from a release archive, no git checkout needed:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/Jecinoris/amicode/feat/amicode-cli/packages/amicode-cli/remote-install.sh | bash
  ```

  Neither path calls `code --install-extension` or touches any VS Code state.
  Julia itself stays optional at install time — the project files land in
  `~/.amico/julia`, and `--instantiate` runs `Pkg.instantiate()` on them (the
  same compile the extension runs from **Amicode: Setup Julia**).

## Commands

```
amicode                              open the TUI (or attach — see below)
amicode doctor                       asset tree + runtime checks
amicode config                       print the assembled opencode session config
amicode env                          print the spawn env's key names (never values)
amicode auth                         opencode auth login, for its own provider list
amicode auth harmoniqs [--key <api-key>]
                                      register Harmoniqs as a provider directly
```

`amicode doctor` checks the asset tree is complete — the vendored binary for
your platform, the plugin directory, the MCP bundle, `AGENTS.md`, and the
`scores/` / `packs/` / `skills/` / `templates/` directories — then appends
three runtime facts that don't change its exit code: the Node version,
whether a model provider is authenticated, and whether a Julia project exists
(reported as "missing — solves will block" if not).

`amicode config` and `amicode env` build from
[`buildSessionConfig`](../packages/amicode-cli/src/session.ts) and
[`buildCliSpawnEnv`](../packages/amicode-cli/src/spawn.ts) — the same
`prepareOpencodeProject`, `buildOpencodeConfigContent`, and
`buildServerSpawnEnv` calls the extension itself makes, so a CLI session and
an editor session opened on the same directory carry the same skills, vault
mounts, and MCP wiring.

Harmoniqs isn't in opencode's own provider list, so `opencode auth login`
can't register it; `amicode auth harmoniqs` writes the same provider entry
and auth-store credential the extension's onboarding writes instead. The key
comes from `--key`, then `AMICODE_HARMONIQS_API_KEY`, then an interactive
(never-echoed) prompt, and is never printed.

## Settings

`~/.amico/cli.json`, a plain file, no VS Code required. A missing file means
the same defaults the extension uses when its own settings are unset:
`~/.amico/julia`, the auto vault stack, bundled skills.

```jsonc
{
  "juliaProject": "~/.amico/julia", // optional override, ~ expands under $HOME
  "vaultDir": "...",
  "skillRoots": ["..."],
  "defaultModel": "..."
}
```

## Sharing a server with the extension

`amicode` with no subcommand reads
[`~/.amico/ops/server/standalone.json`](../packages/extension/src/server_handshake.ts).
If it names a live process (PID alive) whose config hash matches the session
`amicode` just assembled for the current directory, it runs `opencode attach`
against that server instead of opening a second one. Anything else — no
handshake, a dead PID, or a hash for a *different* project — opens its own
foreground TUI on an ephemeral port, not port 43117.

A hash mismatch on its own is not treated as a conflict to refuse: the
extension always serves on 43117 for whichever editor window is open, which
is routinely a different asset tree than the one a terminal session in some
other directory just assembled, and that must never block the CLI from
working on its own project
([`chooseServer`](../packages/amicode-cli/src/attach.ts)).

The CLI never starts `opencode serve` or the amicode service itself — the
foreground process *is* the session. Quitting the TUI ends it; nothing is
left running.

## Julia and provider auth

A solve needs both a Julia project and a model provider. `amicode doctor`
reports both without blocking on either. In the TUI itself, asking for a
solve names the gap directly — the Julia-project message if
`~/.amico/julia` (or the `cli.json` override) doesn't exist, or the normal
provider-auth prompt if no credential is present — rather than failing
opaquely.
