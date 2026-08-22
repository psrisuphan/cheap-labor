<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-green?style=flat-square" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" />
</p>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/psrisuphan/cheap-labor">
    <img src="assets/cheap-labor-icon-1024px.png" alt="Cheap Labor Logo" width="120" height="120">
  </a>

  <h3 align="center">Cheap Labor</h3>

  <p align="center">
    <i>ChatGPT thinks. Codex executes. They bill separately.</i>
  </p>

  <p align="center">
    A plug-in tool that integrates ChatGPT web and Codex for agentic coding workflows — ChatGPT does the thinking, planning, and reviewing, while Codex spends its pool only on real implementation, all over your local repo.
    <br />
    <br />
    <a href="#installation"><strong>Install »</strong></a>
    <br />
    <br />
    <a href="#abstract">Abstract</a>
    &middot;
    <a href="#use-it">Use It</a>
    &middot;
    <a href="#uninstall">Uninstall</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#abstract">Abstract</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li><a href="#prerequisites">Prerequisites</a></li>
    <li>
      <a href="#installation">Installation</a>
      <ul>
        <li><a href="#use-it">Use It</a></li>
      </ul>
    </li>
    <li><a href="#uninstall">Uninstall</a></li>
    <li>
      <a href="#how-it-works">How It Works</a>
      <ul>
        <li><a href="#the-workflow">The Workflow</a></li>
      </ul>
    </li>
    <li><a href="#features">Features</a></li>
    <li><a href="#tools-reference">Tools Reference</a></li>
    <li><a href="#safety-model">Safety Model</a></li>
    <li><a href="#project-structure">Project Structure</a></li>
    <li><a href="#testing">Testing</a></li>
    <li><a href="#local-data--logs">Local Data & Logs</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

---

<!-- ABSTRACT -->
## Abstract

Cheap Labor exists because Codex usage is a limited pool — and most of what a coding agent does is *not* writing code. Reading files, exploring the repo, planning, and reviewing diffs all burn the Codex allowance without ever writing code.

Then came the key realization: ChatGPT and Codex usage are counted **separately** — two independent allowances. So we decided to split the work: ChatGPT does all the thinking on its own allowance, and Codex is spent only on real implementation.

That's the whole idea — a local MCP server joined over a Secure MCP Tunnel: ChatGPT on the web drives a Codex CLI on your machine, over your local repo, with a single `@cheap-labor` trigger.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

Cheap Labor is built with a deliberately small, cross-platform stack:

* **Runtime:** [Node.js](https://nodejs.org) (>= 20) — bridge server runtime
* **Language:** [TypeScript](https://www.typescriptlang.org) — all bridge code
* **Protocol:** [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`) — stdio MCP server + client
* **Validation:** [zod](https://github.com/colinhacks/zod) — tool argument schemas
* **Executor:** [Codex CLI](https://github.com/openai/codex) (`codex mcp-server`) — spawned child MCP client for exploration and implementation
* **Connectivity:** [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) (`tunnel-client`) — private, outbound-only link between ChatGPT web and the local server

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- PREREQUISITES -->
## Prerequisites

* **macOS or Linux** with [Node.js](https://nodejs.org) >= 20 + npm
* **git**
* A paid **ChatGPT** account with [developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
* [Codex CLI](https://github.com/openai/codex), logged in (`codex login`)
* `tunnel-client` — installed during setup: macOS via Homebrew; Linux via the [GitHub releases](https://github.com/openai/tunnel-client/releases/latest) binary (`linux-amd64`/`arm64`) on your PATH
* A **Secure MCP Tunnel** + **runtime API key** from the OpenAI platform (the installer points you to the right pages)

---

<!-- INSTALLATION -->
## Installation

> **Jump to:** [1. Clone & install](#installation) → [2. Use it](#use-it)

1. **Clone the repo** and move into it:

   ```bash
   git clone https://github.com/psrisuphan/cheap-labor.git
   cd cheap-labor
   ```

2. **Run the installer** — it installs deps, builds the bridge, writes your tunnel profile, validates all 25 tools, and walks you through connecting the app to ChatGPT web:

   ```bash
   ./scripts/install.sh
   ```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Use It

1. **Start the tunnel** — keep it running while you use cheap-labor:

   ```bash
   ./scripts/tunnel.sh start    # stop: ./scripts/tunnel.sh stop
   ```

2. **Open a new ChatGPT chat** and type `@cheap-labor` (or whatever you named the app/plugin when creating it).
3. **Confirm the project** directory when asked — the session is armed.
4. **Approval Mode** — defaults to `normal` (asks you before running every command). Switch to **auto-approve** (GPT decides the risk) with `@cheap-labor, switch to auto-approve`.

---

<!-- UNINSTALL -->
## Uninstall

```bash
./scripts/uninstall.sh
```

Cleans up everything the script can reach: legacy MCP registration, the tunnel daemon, `.codex-bridge/` state in every initialized project, the tunnel profile and stored API key, and the build artifacts. Three prompts (press Enter for the recommended answer, `n` to keep). Afterwards it prints a manual cleanup guide for the parts only you can reach: the ChatGPT app connection, the Platform tunnel, the runtime API key, and the project folder.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- HOW IT WORKS -->
## How It Works

The bridge is **dormant until armed**. While dormant, the server ships only a short "ignore these tools" notice as its `instructions`, so unrelated prompts are answered without the bridge ever being considered. The full workflow rules live in the `init` tool's return payload and enter the conversation only after arming.

The trigger is the **invocation itself** — no prompt monitoring, no tag syntax, no phrase scanning:

1. The user invokes cheap-labor by typing `@cheap-labor`. That's the only trigger.
2. ChatGPT asks which project you want, resolves it (`find_projects` for fuzzy names, `create_project` for new directories), confirms the exact path with you, then arms the session — `init(project)` (or `create_project` directly for a brand-new directory) and receives a `session_token`.
3. Every other tool refuses to run without a valid `session_token` — a hard backstop that also blocks accidental use outside the workflow.

### The Workflow

1. **Arm the session** — `@cheap-labor` + confirm the project → `init` returns the token.
2. **Understand** — `git_status`, `list_tree`, `read_file`, `grep` (all free).
3. **Plan in detail** — ChatGPT writes `PLAN.md` / `SPEC.md` / `TASKS.md` into the repo's `.codex-bridge/` folder with `plan_write`. The plan is exact step-by-step instructions: which files to create/edit, what each change should be, which commands to run, and how to verify.
4. **Small edits, done directly** — `write_file` / `edit_file` handle one-file changes for free.
5. **Delegate heavy work** — `implement` hands the plan to Codex, which executes the steps literally, runs builds/tests, fixes what breaks, and returns `IMPLEMENTATION COMPLETE`.
6. **Review** — ChatGPT reads the returned `git diff` and sends targeted corrections back through the same loop.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- FEATURES -->
## Features

* **One-Trigger Activation:** `@cheap-labor` in any ChatGPT chat is the only trigger; the bridge stays dormant (zero model attention) until invoked — no prompt monitoring, no tag syntax, no phrase scanning.
* **Three-Bucket Command Safety:** provably-safe read-only commands (git status/log/diff, ls, cat, grep, …) run freely; dangerous ones (file deletes, git rewrites, network installs, interpreter one-liners) always require your explicit approval; everything else depends on the approval mode — ask first (`normal`, default) or let ChatGPT judge safe commands itself (`auto`). Switch modes in chat any time with `set_approval_mode`.
* **Built-In Safety Rails:** project path scoping, secret redaction, checkpoints before every heavy run, and local-only commits that never push.
* **Cross-Platform:** macOS and Linux, no public ports, outbound-only tunnel.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TOOLS REFERENCE -->
## Tools Reference

Free bridge tools (deterministic local I/O, no Codex cost):

| Tool | Purpose |
|---|---|
| `init` | **Arm the session** for a project (the single entry point); returns the `session_token` + an operation-mode brief |
| `list_tree` | Directory structure, depth-limited |
| `read_file` | File contents, line-ranged, size-capped, secrets redacted (`redact_secrets: false` to disable) |
| `grep` | Regex search with path-aware include/exclude globs (`*.ts`, `src/**/*.ts`), secrets redacted (`redact_secrets: false` to disable) |
| `git_status` / `git_diff` / `git_log` | Repo state + the review loop (untracked files surfaced) |
| `run_command` | Three-bucket execution (tests, build, typecheck): safe allowlist runs freely; dangerous commands always need your approval; the rest follows the approval mode. Output secrets redacted (`redact_secrets: false` to disable) |
| `set_approval_mode` | Switch the global approval mode — `normal` (ask first) or `auto` (ChatGPT judges safe commands itself); dangerous commands always ask |
| `get_settings` | Read current bridge settings (e.g. the approval mode) |
| `write_file` | Create a new file directly (refuses to overwrite) |
| `edit_file` | Exact-match edit of an existing file (content-based stale guard) |
| `edit_pack` | Batch edits/writes after validating every guard before application |
| `checkpoint` | Snapshot HEAD + working tree for rollback (auto before `implement`) |
| `rollback` | Restore to a checkpoint (user-confirmed; itself undoable) |
| `git_commit` | Stage + commit locally with a user-approved message; refuses existing staged work and never pushes |
| `checkpoints` | List recorded checkpoints |
| `find_projects` | Resolve fuzzy names to candidate paths (shallow, well-known locations) |
| `create_project` | Create a new project directory (no git init); returns a `session_token` |
| `plan_read` / `plan_write` / `task_update` | Manage `.codex-bridge/` handoff files |

Codex-backed tools (spend the Codex pool):

| Tool | Purpose |
|---|---|
| `deep_explore` | Read-only Codex session for questions free tools can't answer (model upgrade per-call with your confirmation) |
| `implement` | Workspace-write Codex on the current plan; returns summary + `git diff` (model upgrade per-call with your confirmation) |
| `codex_reply` | Continue a session by thread id (approval veto loop, follow-ups); bound to the project that created it |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- SAFETY MODEL -->
## Safety Model

* `implement` / `deep_explore` always pass an explicit sandbox (`workspace-write` / `read-only`) — never `danger-full-access`.
* **Fixed Codex model** — every Codex call pins `gpt-5.6-luna` with `medium` reasoning and Fast Mode off, passed as per-call overrides. The bridge never writes to `~/.codex/config.toml`. The one exception: `implement` / `deep_explore` accept a stronger model (e.g. `gpt-5.6-sol`), but the bridge refuses it unless the call passes `model_confirmed: true` — set only after you explicitly agree to that exact model in chat. Per-call: each non-default model run needs its own confirmation.
* **Auto-safe approvals** — Codex shell approvals surface as MCP elicitations: commands on the provably-safe allowlist are auto-approved; dangerous ones (writes, network, git mutations, interpreter one-liners) are always declined — in `auto` mode too — and recorded so ChatGPT relays them to you for a veto. The veto is executed with `codex_reply`.
* **Approval modes** — `run_command` buckets every command. The safe allowlist (`git status/log/diff/show/rev-parse`, `ls`, `cat`, `pwd`, `echo`, `grep`, `rg`, `sort`, `uniq`, `wc`, `head`, `tail`, `printf`, `date`) always runs. Dangerous commands (file deletion/overwrite, git rewrites, network installs, interpreter one-liners) always require your approval — the bridge refuses them without `approved: true`. Everything else follows the mode: `normal` (default) asks you first; `auto` lets ChatGPT judge safe commands itself but still makes it ask you for dangerous ones. Change it any time with `set_approval_mode` — it applies to every chat immediately.
* `write_file` only creates new files; `edit_file` only edits existing ones via exact-match replacement (stale/ambiguous matches write nothing); `edit_pack` validates the full batch before applying it. All cap sizes and refuse binary files.
* **Ship mode** — `checkpoint` snapshots HEAD + working tree (taken automatically before every `implement`); `rollback` restores a checkpoint (itself undoable); `git_commit` refuses a non-empty index, then commits locally with a user-approved message. Push/pull/reset/rebase/checkout are never exposed.
* Bridge tools refuse paths outside the session-approved project directory.
* Git-backed tools require the approved project to be the repository root, preventing nested projects from affecting sibling directories.
* `read_file` / `grep` / `git_diff` / `run_command` redact known secret patterns by default; pass `redact_secrets: false` when a task genuinely needs the raw content.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- PROJECT STRUCTURE -->
## Project Structure

```text
cheap-labor/
├── assets/                  # Logo / icons
├── scripts/                 # Installer, uninstaller, tunnel control, setup
│   ├── install.sh           # All-in-one installer
│   ├── uninstall.sh         # Clean uninstaller
│   ├── tunnel-setup.sh      # Writes the tunnel-client profile
│   ├── tunnel.sh            # start / stop / restart / status / logs the tunnel daemon
│   └── setup.mjs            # Prerequisite check
├── src/                     # Bridge MCP server
│   ├── index.ts             # Server entry, tool registration, server instructions
│   ├── git.ts               # Exact repository-root boundary for Git-backed tools
│   ├── safety.ts            # Project scoping, redaction, risk classification, command buckets
│   ├── projects.ts          # Session approvals, ledger, find/create
│   ├── planstore.ts         # .codex-bridge/ I/O
│   ├── settings.ts          # Approval mode (normal / auto)
│   ├── approvals.ts         # Auto-safe policy
│   ├── skips.ts             # Shared directory-skip list
│   └── tools/               # context, command, codex, deepExplore,
│                            # implement, edit, plans, ship
├── tests/                   # Node test suite
├── dist/                    # Build output (gitignored)
└── package.json
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TESTING -->
## Testing

To run the unit test suites:

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test (tsx)
npm run build        # tsc → dist/
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- LOCAL DATA & LOGS -->
## Local Data & Logs

Cheap Labor stores its tunnel profile, runtime API key, and daemon logs locally, outside the project directory:

* **macOS / Linux:** `~/.config/tunnel-client/`

Inside this directory you will find:

* `cheap-labor.yaml` — the `tunnel-client` profile (contains the tunnel id).
* `cheap-labor.key` — the runtime API key, chmod 600, never committed.
* `cheap-labor.log` — the tunnel daemon log.

Bridge settings (the approval mode) live in `~/.codex/cheap-labor-settings.json` (chmod 600), and the list of initialized projects in `~/.codex/cheap-labor-approved-projects.json` (read by the uninstaller to purge `.codex-bridge/` state).

Plans and handoff files are written into each project's `.codex-bridge/` folder at runtime (gitignored). Checkpoint metadata is stored under Git's private directory and snapshots are pinned under `refs/bridge-checkpoints/`. Codex's own configuration and auth live in `~/.codex/`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- LICENSE -->
## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for the full license text.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
