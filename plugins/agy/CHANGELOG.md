# Changelog

## Unreleased

Added `agy-run`, a role-free executable in `plugins/agy/bin/` (added to the Bash tool's `PATH` by Claude Code) that runs one Antigravity CLI (`agy`) turn. The caller writes the role and instructions in the prompt file.

- Strict long options: `--prompt-file` (required, an absolute path to a UTF-8 file), `--cwd`, `--thread`, `--model`, `--effort`, `--help`.
- The prompt is sent unchanged as one `stream-json` user message on stdin, only after `agy` reported its conversation, with slash-command expansion turned off. Every run passes `--dangerously-skip-permissions`; there is no read-only mode.
- The final response is written byte for byte to `<state>/runs/<run id>/result.md`, and `agy`'s stdout to `events.jsonl` next to it. A run is `ok` only when `agy` exited `0` with exactly one `init` and one `result` event for the requested conversation, a `SUCCESS` status, no `finished_reason`, a non-empty response, and no `AGY_ERROR:` line on stderr; otherwise it exits `1` with a one-line reason. Run directories older than 7 days are pruned automatically.
- Every run snapshots the Git working tree before and after `agy` runs (requiring Git 2.45 or later) and prints a change report on stdout (`none`, up to 10 changed paths with full lists written to `changes.txt`, or `unknown: <reason>`). Snapshots turn off split index, so a repository with `core.splitIndex=true` gets no new `sharedindex.*` file.
- `--thread <id>` continues a conversation only from the directory and repository it started in; records are stored at `<state>/threads/<conversation id>.json`. A resume that `agy` answers with a new conversation is stopped before the prompt is sent.
- Each run creates a scratch directory passed to `agy` as `TMPDIR` and deletes it after `agy`'s process group exits.
- Stopping the runner stops `agy`'s process group in stages (`SIGINT`, `SIGTERM`, `SIGKILL`) and exits `128+n`. A run whose `agy` does not report its conversation within 120 seconds is stopped.
- Each run prints a run id and appends a metadata-only JSON line to `<state>/runs.jsonl`.
