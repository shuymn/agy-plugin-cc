# Antigravity CLI plugin for Claude Code

`agy-run` is a role-free executable in the plugin's `bin/` directory that Claude Code adds to the Bash tool's `PATH`. It runs one Antigravity CLI (`agy`) turn from a prompt file in a chosen working directory, writes the turn's final response unchanged to a per-run file, and prints a short summary report to stdout including any working-tree changes. The caller, typically an orchestrating Claude Code session, owns the role, prompt structure, and what to do with the result.

The runner follows the contract of `codex-run` from [codex-plugin-cc](https://github.com/shuymn/codex-plugin-cc), so a caller can use both with the same habits. The design is in [docs/design/agy-runner.md](docs/design/agy-runner.md).

## Trust boundary

`agy-run` runs `agy` with `--dangerously-skip-permissions` and the user's full authority: every file the user can read or write, the network, credentials in the home directory, Git remotes, and the MCP servers and plugins configured for `agy`. Only the permission rules configured for `agy` itself still apply. There is no read-only mode and no sandbox.

The change report covers only the non-ignored content of the working tree of `--cwd`. It does not see `.git` contents, ignored files (such as `.env` or build output), files outside the tree, credential reads, pushes, API calls, or MCP actions. `changes: none` means the working tree's tracked and untracked content is unchanged, not that the run had no side effects.

Use `agy-run` only for repositories and inputs you trust as much as the calling session. A prompt that includes untrusted text (a third-party pull request, a fetched web page) can steer the agent to act with that authority.

## Requirements

- **Node.js 24.2 or later.** The runner is written in TypeScript and uses Node's built-in type stripping and `import.meta.main`, with no runtime dependencies.
- **Antigravity CLI** (`agy`), on `PATH` and logged in. Install the Antigravity CLI, then run `agy` once in a terminal to log in.
- **Git 2.45 or later** for the working-tree change report (uses `--no-lazy-fetch`; older Git versions report `changes: unknown: ...`).

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add shuymn/agy-plugin-cc
```

Install the plugin:

```bash
/plugin install agy@shuymn-agy
```

Reload plugins:

```bash
/reload-plugins
```

Verify that `agy-run` is on the Bash tool's `PATH`:

```bash
agy-run --help
```

## Usage

Minimal call:

```bash
agy-run --prompt-file /abs/path/to/prompt.md --cwd /path/to/repo
```

State the role in the prompt, and say so when the agent must not edit: nothing else stops it. After each run, read `status:` and `changes:`, and read `result.md` on `ok`; the response may report that a tool was denied or a step failed. On a run whose request forbade edits, a non-empty change report is a finding to inspect and repair before anything else touches the tree. `unknown` is not `none`.

### Options

```text
agy-run --prompt-file <absolute file> [--cwd <dir>] [--thread <id>]
        [--model <model>] [--effort <effort>]
agy-run --help
```

- `--prompt-file <file>`: Required. Must be an absolute path to a readable, non-blank UTF-8 file. Its text, including a leading BOM, is sent to `agy` unchanged as one `stream-json` user message on stdin, with slash-command expansion turned off.
- `--cwd <dir>`: `agy`'s working directory. Default: the current directory. Must exist and be a directory.
- `--thread <id>`: Continue a conversation started by `agy-run` in the same directory (see [Conversations](#conversations)).
- `--model <model>`: Pass `--model <model>` to `agy` unchanged (ids from `agy models`).
- `--effort <effort>`: Pass `--effort <effort>` to `agy` unchanged.
- `--help`: Show usage and exit `0`.

Options are parsed strictly as long options only; there are no short options and no positional arguments. Repeating an option keeps its last value. Without `--model` and `--effort`, `agy`'s own settings decide.

Every run calls:

```text
agy --input-format stream-json --output-format stream-json --disable-slash-commands
    --dangerously-skip-permissions [--conversation <id>] [--model <model>] [--effort <effort>] -p=
```

`agy-run` does not pass `--print-timeout` or `--sandbox`. To stop a run, stop the process (see [Running in the background](#running-in-the-background)).

### Stdout report

```text
run: 20260101T000000Z-a1b2c3d4
scratch: /tmp/agy-run-scratch-xxxxxx
thread: c3b66b04-872b-4fbe-a3a4-058a026ef20a
status: ok (exit 0)
result: <state>/runs/20260101T000000Z-a1b2c3d4/result.md
cwd: /path/to/repo
changes: none
```

- `run: <id>`: Always printed first. Format is `<UTC timestamp>-<8 hex chars>`.
- `scratch: <dir>`: Printed before `agy` starts. Names the temporary directory passed to `agy` as `TMPDIR`.
- `thread: <id>`: The conversation id, printed once `agy` reports it in its `init` event and the runner accepts it. Omitted when `agy` fails before that.
- `status: ok|failed|interrupted (exit <n>)`: Final status (`ok` for exit `0`, `interrupted` for exit `> 128`, `failed` otherwise) and exit code.
- `result: <file>`: Printed on exit `0` only. Path to `result.md` in the run directory.
- `cwd: <dir>`: The resolved `--cwd`.
- `changes: ...`: Working-tree change report (see [Change report](#change-report)).
- `scratch left: <dir>`: Printed only when the scratch directory was not deleted.

Output without a `status:` line or a `changes:` line is incomplete. Backslashes and control characters in printed paths and messages are escaped (`\\`, `\n`, `\t`, `\xNN`) so each line stays on one line.

On failure, stderr prints `agy-run: <one-line reason>` followed by up to 40 cleaned lines of `agy`'s stderr.

### Result file and event archive

`agy-run` writes the `response` of `agy`'s `result` event byte for byte (UTF-8, no added newline) to `<state>/runs/<run id>/result.md`. Each run gets its own private directory (`0700`), so concurrent runs do not overwrite each other's output.

A run is `ok` only when all of these hold: `agy` exited `0`; exactly one `init` and exactly one `result` event arrived, with the same conversation id, and the `result` came after `agy` received the whole prompt; on a resume that id equals `--thread`; the result's `status` is `SUCCESS`; it has no `finished_reason`; its `response` is non-empty; no `AGY_ERROR:` line appeared on stderr; and `result.md` was written. Otherwise the run exits `1` with a one-line reason, even when `agy` exited `0`. A turn whose response explains a denied tool call stays `ok`.

`agy`'s stdout is also saved byte for byte to `<state>/runs/<run id>/events.jsonl`. It is the only record of which tools ran, so look there when `changes:` shows something unexpected. It may contain tool parameters and outputs. If it cannot be written, the run continues and prints `agy-run: events not saved: <error>` on stderr.

Run directories older than 7 days (by modification time) are pruned automatically on subsequent runs.

### Conversations

When `agy` reports a conversation, `agy-run` writes `<state>/threads/<conversation id>.json` containing `{cwd, root, repo, updatedAt}`: `cwd` is the canonical directory `agy` ran in, `root` the canonical workspace root, and `repo` the canonical Git common directory (`null` outside Git).

A resumed `agy` conversation keeps working in the directory it started in, so `--thread <id>` is accepted only when `<id>` matches `^[A-Za-z0-9-]{1,128}$`, a record exists, and both the canonical `--cwd` and the Git common directory equal the recorded ones. A sibling subdirectory or another worktree of the same repository does not match. Otherwise `agy-run` exits `2` before starting `agy`: an invalid id is rejected outright, an unknown id suggests `agy --conversation <id>` in a terminal, and a mismatch names the recorded directory. To continue the work in another directory, start a new conversation and pass the earlier result in the prompt.

If `agy` does not resume the requested conversation (it starts a new one when it does not know the id), `agy-run` stops it before sending the prompt and exits `1` with `stale conversation: requested <id>, agy started <id>`; the record is kept.

Concurrent runs on the same conversation are not guarded; keep rounds of a conversation sequential.

### Change report

`agy-run` snapshots the workspace root of `--cwd` as a Git tree in a temporary index before `agy` starts and again after its process group exits, then compares the two trees with `git diff-tree -r -z --no-renames --name-status`. Snapshots do not touch the user's index, refs, or working tree, and disable hooks, fsmonitor, untracked cache, split index, lazy fetch, and filter drivers.

Possible `changes:` values:

- `none`: The baseline and final snapshots are equal as Git stores them.
- `<n> files (baseline <tree>, paths relative to <workspace root>)`: Lists up to 10 changed paths as `  <status> <path>` (`A`, `M`, `D`, `T`, etc.). When more than 10 files changed, the full list (`baseline <tree>`, `final <tree>`, then `<status>\t<path>` lines) is written to `<state>/runs/<run id>/changes.txt` and referenced as `  ... full list: <file>`.
- `unknown: <reason>` (with `(baseline <tree>)` when a baseline exists): The workspace is outside Git, a snapshot or diff failed (for example Git older than 2.45, submodules, files with a Git `filter` attribute, or a 30-second snapshot timeout), the run was interrupted (`unknown: interrupted`), or `agy`'s process group could not be confirmed gone (`unknown: reap-error`).

The change report never changes the exit code.

Limits:

- Reports all working-tree changes that occurred **during** the run, including edits made by other processes in the same working tree. Run at most one `agy-run` per working tree at a time; concurrent runs in separate worktrees are isolated.
- Changes made and reverted before `agy` exits report `none`.
- Byte changes hidden by Git normalization on `git add` (such as line endings under `core.autocrlf`) report `none`.
- Ignored files, `.git` contents, and files outside the working tree are not covered. Edits to a force-added file that matches an ignore rule and is not in `HEAD` report `none`.
- Repositories with submodules (or embedded repositories) and files with a Git `filter` attribute (such as Git LFS) produce `unknown: <reason>`. Sparse checkouts are untested.
- Snapshot trees are unreferenced Git objects that `git gc` prunes after its expiry period.
- The snapshot's temporary index and the scratch directory are created under `TMPDIR`, and the state under `XDG_STATE_HOME`. Keep both outside the repositories `agy-run` works in, or the runner's own files appear in `changes:`.

### Scratch directory and `TMPDIR`

After taking the baseline snapshot, `agy-run` creates a temporary directory (`agy-run-scratch-*` under the system temporary directory), passes it to `agy` as `TMPDIR`, and prints `scratch: <dir>`.

After `agy`'s process group exits, `agy-run` deletes the directory after verifying its device and inode still match what was created. If deletion fails, or if the process group could not be confirmed gone (so `agy` may still be using it), the directory is left in place and reported as `scratch left: <dir>`.

### Exit codes

| Code    | Meaning                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`     | The turn completed with a non-empty response, written to `result.md`.                                                                                                                                                                       |
| `1`     | `agy` failed, could not be started, or ended without a usable response, a Git lookup failed before starting, the thread record could not be written, or `agy`'s process group could not be confirmed gone (takes precedence over a signal). |
| `2`     | Usage error (missing, relative, unreadable, blank, or non-UTF-8 `--prompt-file`; invalid `--cwd`; unknown option; positional argument) or refused `--thread`. `agy` was not started.                                                        |
| `3`     | `agy` was not found on `PATH`.                                                                                                                                                                                                              |
| `128+n` | Stopped by signal `n` (`130` for `SIGINT`, `143` for `SIGTERM`) after `agy` started.                                                                                                                                                        |

### Running in the background

`agy-run` runs in the foreground of its own process. For long runs, use Claude Code's Bash tool background mode (`run_in_background`); stdout stays short so the completion notification is concise.

When stopped with `SIGINT` or `SIGTERM`, `agy-run` stops `agy`'s entire process group in stages (`SIGINT`, `SIGTERM`, `SIGKILL`), reports `changes: unknown: interrupted` (with the baseline tree id if taken), deletes the scratch directory, and exits `128+n`. If the process group cannot be confirmed gone, it exits `1` and leaves the scratch directory (`scratch left: <dir>`). A signal that arrives during the final snapshot, the result write, or cleanup ends the runner at once; that output has no `status:` or `changes:` line, and the scratch directory may remain. Background tasks that `agy` starts outside its process group are not stopped.

If `agy` does not report its conversation within 120 seconds, `agy-run` stops it and exits `1` with `no init event within 120s`.

### State directory and run log

`<state>` is `$XDG_STATE_HOME/agy-plugin-cc`, or `~/.local/state/agy-plugin-cc` when `XDG_STATE_HOME` is unset, empty, or relative.

```text
<state>/
  runs/<run id>/result.md           # The final response (pruned after 7 days)
  runs/<run id>/events.jsonl        # agy's stdout
  runs/<run id>/changes.txt         # Written only when more than 10 files changed
  threads/<conversation id>.json    # {cwd, root, repo, updatedAt}
  runs.jsonl                        # One metadata JSON line per run
```

Each run that prints `run: <id>` appends one JSON line to `<state>/runs.jsonl` with:

- `run` (run id), `time` (ISO-8601 UTC start time), `continued` (boolean), `exit`, `durationMs`
- `changes` (changed-file count, or `null` when `unknown`)
- `unknown` (present when `changes:` is `unknown`: `not-git`, `snapshot-failed`, `interrupted`, or `reap-error`)
- `snapshotMs` (`{ baseline, final? }`)

`runs.jsonl` does **not** record prompts, results, file paths, or raw error text. Note each run id together with whether the request allowed edits, to see how often runs edit without being asked.

## Permissions

Add a Claude Code Bash permission rule to allow `agy-run` across plugin updates without referencing versioned cache paths:

```text
Bash(agy-run:*)
```

## Development

The tools are pinned in `mise.toml`. After cloning, run `mise install`, then `pnpm install` and `pnpm exec lefthook install` to set up the dependencies and git hooks.

The GitHub repository settings are declared in `.github/infra.yaml`; review them with `mise exec -- gh-infra plan .github/infra.yaml` then apply them with `gh-infra apply` on the same file.

```bash
pnpm run lint
pnpm run fmt
pnpm run typecheck
pnpm test
pnpm run test:cli-contract   # checks the plugin's argv against the pinned Antigravity CLI, without logging in
```

## License

Apache-2.0. Portions are derived from [codex-plugin-cc](https://github.com/shuymn/codex-plugin-cc). See `LICENSE` and `NOTICE`.
