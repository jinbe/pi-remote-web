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

| Variable           | Default     | Description                                                            |
| ------------------ | ----------- | ---------------------------------------------------------------------- |
| `PI_BIN`           | `pi`        | Path to the Pi binary                                                  |
| `PORT`             | `3000`      | Port for the standalone server                                         |
| `HOST`             | `0.0.0.0`  | Host for the standalone server                                         |
| `PI_AUTH_PASSWORD`  | _(unset)_   | Password to protect the dashboard. Supports plaintext or bcrypt hash.  |

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
