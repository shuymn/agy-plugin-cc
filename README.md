# Antigravity CLI plugin for Claude Code

`agy-run` will be a role-free executable that Claude Code puts on the Bash tool's `PATH`. It runs one Antigravity CLI (`agy`) turn from a prompt file in a chosen working directory, writes the final response to a per-run file, and prints a short report that includes working-tree changes.

Status: design. See [docs/design/agy-runner.md](docs/design/agy-runner.md).

The runner follows the contract of `codex-run` from [codex-plugin-cc](https://github.com/shuymn/codex-plugin-cc).
