# Job Queue & Autonomous Polling — Implementation Task

Implement the complete job queue system for pi-remote-web. Work through it methodically, file by file, following the execution order below.

## Key Context
- Package manager: bun
- Typecheck: bun run check
- Tests: bun test src/
- Base branch: main
- GitHub: jinbe/pi-remote-web
- Existing code: src/lib/server/cache.ts has SQLite via bun:sqlite, rpc-manager.ts has createSession/sendMessage, init.ts bootstraps the server
- Use Australian English in all comments and UI text (colour, organisation, behaviour, etc.)

## Execution Order

### 1. Create feature branch
```
git checkout -b feat/job-queue
```

### 2. Pi Extension: `extensions/job-callback.ts`
Create at project root `extensions/job-callback.ts` (NOT in ~/.pi). This is a Pi extension that fires on `agent_end`, scans conversation for JOB_ID/CALLBACK_URL markers, extracts PR_URL/VERDICT markers from assistant messages, and POSTs results back to pi-remote-web. Include retry logic (2 attempts with 2s delay).

Also create `scripts/setup-hooks.sh` that symlinks this into ~/.pi/agent/extensions/.

The extension pattern:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const JOB_ID_PATTERN = /JOB_ID:\s*(\S+)/;
const CALLBACK_PATTERN = /CALLBACK_URL:\s*(\S+)/;
const PR_URL_PATTERN = /PR_URL:\s*(\S+)/;
const VERDICT_PATTERN = /VERDICT:\s*(approved|changes_requested)/;

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    // Extract all text from conversation, look for job metadata
    // Extract PR_URL/VERDICT from assistant messages only
    // POST results back to CALLBACK_URL with retry
  });
}
```

### 3. Schema + `src/lib/server/job-queue.ts`
Add jobs table to cache.ts `getDb()` function. Schema:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  type TEXT NOT NULL CHECK (type IN ('task', 'review')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'running', 'done', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  title TEXT NOT NULL,
  description TEXT,
  repo TEXT,
  branch TEXT,
  issue_url TEXT,
  target_branch TEXT DEFAULT 'main',
  pr_url TEXT,
  pr_number INTEGER,
  review_verdict TEXT CHECK (review_verdict IS NULL OR review_verdict IN ('approved', 'changes_requested')),
  parent_job_id TEXT REFERENCES jobs(id),
  loop_count INTEGER NOT NULL DEFAULT 0,
  max_loops INTEGER NOT NULL DEFAULT 5,
  session_id TEXT,
  worktree_path TEXT,
  result_summary TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2
);
```

job-queue.ts exports: createJob, claimNextJob, updateJobStatus, getJobs, getJob, getJobChain, deleteJob, retryJob. Use atomic claim with RETURNING.

### 4. `src/lib/server/job-prompts.ts`
Prompt builders for: task (new work), task (fix review comments), and review. Each injects JOB_ID + CALLBACK_URL metadata header at the top.

### 5. `src/lib/server/job-completion.ts`
handleCompletion(jobId, payload): validates job is running, updates result fields, cleans up worktree, then applies loop logic:
- Task done → enqueue Review (if loop_count < max_loops)
- Review changes_requested → enqueue Task fix (increment loop_count)
- Review approved → mark done
- Loop cap reached → mark done with note

### 6. `src/lib/server/job-poller.ts`
Fire-and-forget poller with start()/stop(). pollOnce() every 30s. Creates git worktrees for isolation (under PI_WORKTREE_DIR, default ~/.pi/worktrees). Spawns Pi sessions via rpc-manager createSession/sendMessage.

### 7. API Routes
```
src/routes/api/jobs/+server.ts          — GET (list), POST (create)
src/routes/api/jobs/[id]/+server.ts     — GET (detail), PATCH (update), DELETE
src/routes/api/jobs/[id]/complete/+server.ts — POST (hook callback)
src/routes/api/jobs/[id]/retry/+server.ts    — POST (retry failed)
src/routes/api/jobs/[id]/chain/+server.ts    — GET (full chain)
src/routes/api/jobs/poller/+server.ts        — GET (status), POST (start/stop)
```

### 8. UI Components
- `src/lib/components/AddJobModal.svelte` — modal for creating task/review jobs
- `src/lib/components/JobList.svelte` — shows jobs per project with status badges, loop indicators
- `src/lib/components/JobChain.svelte` — linked job chain visualisation
Wire into existing home page (+page.svelte) with [+ Task] and [+ Review] buttons per project row.

### 9. Wire up in init.ts
Start poller on server init (after session recovery).

### 10. Tests
Write tests for job-queue.ts, job-completion.ts, and job-poller.ts.

## Final Steps
- Run `bun run check` — must be 0 errors and 0 warnings
- Run `bun test src/` — all tests must pass
- Commit with conventional commits
- Push and create PR:
  ```
  git push -u origin feat/job-queue
  gh pr create --title "feat: add job queue with autonomous task/review loop" --body "Adds task and review job queues with background poller, Pi extension callback hook, git worktree isolation, and auto-cycling between implementation and review." --base main
  ```

## IMPORTANT SIGNALS
- After creating the PR, output exactly: PR_CREATED: <the full PR URL>
- After pushing review fixes, output exactly: FIXES_PUSHED
- If asked to address review feedback, read reviews directly from the PR using gh api
