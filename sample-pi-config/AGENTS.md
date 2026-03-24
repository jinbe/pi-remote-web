# Project Guidelines

Sample `.pi/agent/AGENTS.md` — place in your home directory or project root.
This file is loaded by Pi as context for every session, teaching the agent
your team's conventions and workflow expectations.

## Code Style

- Follow existing project conventions
- Use meaningful variable names
- Keep functions under 50 lines
- Add comments for complex logic only
- DRY — extract shared logic into reusable functions, modules, or constants
- No magic numbers — define all numeric literals as named constants with clear intent

## Git

- Conventional Commits: `feat`/`fix`/`refactor`/`docs`/`test`/`chore`
- Atomic commits, one concern per commit
- Never force push to main
- Never commit directly to main — always create a feature branch first
- Auto-commit and push to feature branches without asking

## Safety

- Never hardcode secrets or API keys
- Always validate user input
- Handle errors explicitly, no silent failures

## Testing

- Always write tests for new work (features, bug fixes, refactors)
- Run tests to verify they pass before committing

## Workflow

- Read before write — understand context first
- Minimal changes — don't refactor unrelated code
- Verify after changes — run tests or check output
