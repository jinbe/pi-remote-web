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

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Environment Variables

| Variable | Default     | Description                          |
| -------- | ----------- | ------------------------------------ |
| `PI_BIN` | `pi`        | Path to the Pi binary                |
| `PORT`   | `3000`      | Port for the standalone server       |
| `HOST`   | `0.0.0.0`  | Host for the standalone server       |

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
