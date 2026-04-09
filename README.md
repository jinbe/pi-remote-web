# pi-remote-web

A web dashboard for [Pi](https://github.com/mariozechner/pi-coding-agent) — browse, manage, and chat with your Pi coding agent sessions from any browser.

## Features

- **Session browser** — view all Pi sessions grouped by project, with search, favorites, and active session indicators
- **Live chat** — send messages, steer the agent, and watch responses stream in real-time via SSE
- **Branch navigation** — explore conversation branches and switch between them
- **Session lifecycle** — create, resume, abort, and stop sessions directly from the UI
- **Extension UI** — handles Pi extension prompts (input, confirm, select) with modal dialogs
- **Mobile-friendly** — responsive layout with iOS keyboard handling
- **Standalone binary** — bundle into a single self-contained Bun executable

## Tech Stack

- [SvelteKit](https://svelte.dev/docs/kit) + [Svelte 5](https://svelte.dev)
- [Bun](https://bun.sh) runtime & adapter
- [Tailwind CSS](https://tailwindcss.com) + [DaisyUI](https://daisyui.com)
- [Marked](https://marked.js.org) for markdown rendering

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Pi](https://github.com/mariozechner/pi-coding-agent) installed and available on your `PATH` (or set `PI_BIN`)

## Getting Started

```sh
# Install dependencies
bun install

# Start dev server
bun run dev
```

Open [http://localhost:4020](http://localhost:4020) in your browser.

## Environment Variables

See [Agent Setup § Environment Configuration](#3-environment-configuration) for the full env var reference.

### Authentication

When `PI_AUTH_PASSWORD` is set, all routes require authentication. Users are
redirected to a login page where they enter the password. A session cookie is
issued on success and lasts 30 days.

The password can be supplied as either:

- **Plaintext** — e.g. `PI_AUTH_PASSWORD=my-secret`
- **Bcrypt hash** — e.g. `PI_AUTH_PASSWORD='$2b$10$...'` (any string starting
  with `$2` is treated as a bcrypt digest)

To generate a bcrypt hash:

```sh
bun -e "console.log(await Bun.password.hash('my-secret', { algorithm: 'bcrypt' }))"
```

Job completion callbacks (`/api/jobs/:id/complete`) are exempt — they use their
own per-job token authentication.

## Agent Setup

Step-by-step instructions for an AI coding agent to set up the project from scratch.

### 1. Prerequisites Check

Verify the following are available on `PATH`:

```sh
bun --version        # Bun ≥ 1.0
gh auth status       # GitHub CLI, authenticated
pi --version         # Pi coding agent (or claude --version for Claude Code)
```

### 2. Install & Build

```sh
bun install
bun run check        # typecheck
bun test src/        # unit tests
```

### 3. Environment Configuration

```sh
cp .env.example .env
```

Edit `.env` and set values as needed. All variables are optional and have sensible defaults:

**Server (standalone/production only — dev server always uses port 4020):**

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4020` | Port for the standalone/production server |
| `HOST` | `0.0.0.0` | Host to bind the standalone/production server |

**Authentication:**

| Variable | Default | Description |
| --- | --- | --- |
| `PI_AUTH_PASSWORD` | _(unset)_ | Password to protect the dashboard (plaintext or bcrypt hash) |

**Harness:**

| Variable | Default | Description |
| --- | --- | --- |
| `PI_HARNESS` | `pi` | Coding harness: `pi` or `claude-code` |
| `PI_BIN` | `pi` | Path to the Pi binary |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary |

**Sessions:**

| Variable | Default | Description |
| --- | --- | --- |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | Session storage directory |

**Jobs & Worktrees:**

| Variable | Default | Description |
| --- | --- | --- |
| `PI_WORKTREE_DIR` | `.worktrees` | Worktree directory for job isolation (relative to project) |
| `PI_REMOTE_HOST` | _(auto-detected)_ | Host/origin for job completion callbacks |

**Job Skills:**

| Variable | Default | Description |
| --- | --- | --- |
| `PI_JOB_TASK_SKILL` | _(unset)_ | Skill for fire-and-forget tasks (`max_loops=0`) |
| `PI_JOB_LOOP_TASK_SKILL` | _(unset)_ | Skill for the task/fix phase inside a review loop (`max_loops>0`) |
| `PI_JOB_REVIEW_SKILL` | _(unset)_ | Skill for the review phase inside a review loop |

**PR Poller:**

| Variable | Default | Description |
| --- | --- | --- |
| `PI_PR_POLL_INTERVAL_SECONDS` | `600` | Polling interval in seconds (10 minutes) |
| `PI_PR_POLL_CONCURRENCY` | `5` | Max concurrent running jobs |

### 4. Extension Setup

Symlink the job-callback extension into Pi's extensions directory:

```sh
bash scripts/setup-hooks.sh
```

This symlinks `extensions/job-callback.ts` into `~/.pi/agent/extensions/`. The extension fires on `agent_end` to report job results (success/failure) back to pi-remote-web via its callback API.

### 5. Running

```sh
# Development (port 4020)
bun run dev

# Production
bun run build && bun run preview

# Standalone binary
bun run package && ./dist/pi-dashboard
```

### 6. Adding Monitored Repos (PR Poller)

The PR poller watches GitHub repos for pull requests and automatically dispatches review jobs. Manage monitored repos via the API:

```sh
# List monitored repos
curl http://localhost:4020/api/monitored-repos

# Add a repo
curl -X POST http://localhost:4020/api/monitored-repos \
  -H 'Content-Type: application/json' \
  -d '{"owner": "org", "repo": "my-repo", "enabled": true, "assigned_only": false, "manual_only": false}'
```

Per-repo toggles:

- `enabled` — whether the poller watches this repo
- `assigned_only` — only poll PRs assigned to the authenticated GitHub user
- `manual_only` — skip automatic polling; only process PRs triggered manually

### 7. Development Workflow

```sh
bun run check        # typecheck before committing
bun test src/        # run tests before committing
```

- Use conventional commits (e.g. `feat:`, `fix:`, `chore:`)
- Use Australian English in user-facing copy
- Work on feature branches; open PRs against `main`

## Scripts

| Command              | Description                                      |
| -------------------- | ------------------------------------------------ |
| `bun run dev`        | Start the development server                     |
| `bun run build`      | Build for production                             |
| `bun run preview`    | Preview the production build                     |
| `bun run package`    | Bundle into a standalone Bun binary (`dist/pi-dashboard`) |
| `bun run check`      | Run `svelte-check` type checking                 |

## Standalone Binary

Build a single portable executable that embeds all client assets:

```sh
bun run package
./dist/pi-dashboard
```

## Project Structure

```
src/
├── lib/
│   ├── components/     # Svelte components (ChatBubble, MessageInput, etc.)
│   ├── server/         # Server-side logic (RPC manager, session scanner, SSE)
│   ├── types.ts        # Shared TypeScript types
│   └── utils.ts        # Utility functions
├── routes/
│   ├── +page.svelte    # Session browser (home)
│   ├── session/[id]/   # Individual session chat view
│   └── api/            # REST + SSE API endpoints
└── app.html            # HTML shell
```

## License

MIT
