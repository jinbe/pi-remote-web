# Sample Pi Configuration

These files demonstrate the configuration that makes pi-remote-web's autonomous
job workflow tick. Copy and adapt them to your own projects.

## What's Here

```
sample-pi-config/
├── README.md                   # This file
├── AGENTS.md                   # Project guidelines for the agent
└── skills/
    └── review/
        └── SKILL.md            # Code review skill with verdict output
```

## How the Pieces Fit Together

pi-remote-web's job queue dispatches tasks to Pi sessions and uses a
**task → review → fix** loop to iterate until the work is approved (or a loop
cap is reached). Three pieces of configuration make this possible:

### 1. AGENTS.md — Project Guidelines

Place at `~/.pi/agent/AGENTS.md` (global) or `.pi/agent/AGENTS.md` (per-project).

This teaches the agent your team's conventions: commit style, branching rules,
testing expectations, and code standards. Every Pi session loads it
automatically — both interactive sessions and autonomous jobs benefit.

### 2. Review Skill — Structured Code Review

Place under `~/.pi/agent/skills/review/SKILL.md` or `.pi/skills/review/SKILL.md`.

The review skill gives the agent a structured process for reviewing pull
requests. It checks correctness, test coverage, code style, security, and
performance, then outputs a machine-readable verdict:

```
VERDICT: approved
```
or
```
VERDICT: changes_requested
```

pi-remote-web's job system parses this verdict to decide whether to enqueue a
fix job or mark the chain as complete. The review skill is referenced via the
`review_skill` field when creating a job through the API or dashboard.

### 3. Job Callback Extension

The extension at `extensions/job-callback.ts` (in the pi-remote-web repo) is a
Pi extension that fires on `agent_end`. It scans the conversation for job
metadata markers (`JOB_ID`, `CALLBACK_URL`, `CALLBACK_TOKEN`) and result
markers (`PR_URL`, `VERDICT`), then POSTs the results back to pi-remote-web.

Install it with:

```bash
./scripts/setup-hooks.sh
```

This symlinks the extension into `~/.pi/agent/extensions/` so it's active for
all Pi sessions.

## Setting Up a Project

1. **Copy `AGENTS.md`** to your project's `.pi/agent/AGENTS.md` and customise
   the guidelines for your team's conventions.

2. **Copy the review skill** to `~/.pi/agent/skills/review/` (global) or
   `.pi/skills/review/` (per-project).

3. **Install the job callback extension** by running
   `./scripts/setup-hooks.sh` from the pi-remote-web repo.

4. **Create a job** via the pi-remote-web dashboard or API:

   ```bash
   curl -X POST http://localhost:4020/api/jobs \
     -H 'Content-Type: application/json' \
     -d '{
       "type": "task",
       "title": "Add input validation to signup form",
       "repo": "/path/to/your/project",
       "target_branch": "main",
       "review_skill": "review"
     }'
   ```

   The job poller will claim it, create a git worktree, spawn a Pi session,
   and start the autonomous loop.

## Customising the Review Skill

The sample review skill is intentionally generic. You can customise it for your
project by:

- Adding project-specific review criteria (e.g. "check for Australian English
  spelling" or "verify all API endpoints have rate limiting")
- Referencing project documentation or style guides
- Adjusting the review process to match your team's workflow
- Adding domain-specific checks (e.g. "verify database migrations are
  reversible")

## How the Loop Works

```
┌─────────────────────────────────────────────┐
│                                             │
│  1. Job queued (type: task)                 │
│  2. Poller claims job, creates worktree     │
│  3. Pi session implements the task          │
│  4. Agent creates PR, outputs PR_URL        │
│  5. Callback fires → review job enqueued    │
│                                             │
│  6. Review job claimed                      │
│  7. Pi session reviews the PR               │
│  8. Agent outputs VERDICT                   │
│     ├─ approved → chain complete ✓          │
│     └─ changes_requested → fix job enqueued │
│                                             │
│  9. Fix job claimed (loop_count++)          │
│ 10. Pi session addresses review feedback    │
│ 11. Back to step 5 (until approved or       │
│     loop cap reached)                       │
│                                             │
└─────────────────────────────────────────────┘
```
