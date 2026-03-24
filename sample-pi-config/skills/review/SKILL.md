---
name: review
description: >-
  Code review skill for pull requests. Use when reviewing PRs, checking code
  quality, verifying test coverage, and providing structured feedback. Outputs
  a VERDICT of approved or changes_requested.
---

# Code Review

Review a pull request thoroughly, then output a final verdict.

## Process

1. **Read the PR diff** using `gh pr diff <pr-url>` or by examining the changed files
2. **Check out the branch** if you need to run tests or typecheck locally
3. **Review each file** for the criteria below
4. **Summarise findings** with specific file and line references
5. **Output your verdict** — see [Verdict Format](#verdict-format)

## Review Criteria

### Correctness
- Logic errors, off-by-one mistakes, race conditions
- Edge cases not handled
- Incorrect assumptions about data shape or API contracts

### Test Coverage
- New code should have corresponding tests
- Tests should cover happy path and error cases
- Run the test suite: check for failures or missing coverage

### Code Style & Conventions
- Follows the project's existing patterns and naming conventions
- No unnecessary complexity or premature abstractions
- Functions are focused and reasonably sized
- No duplicated logic that should be extracted

### Security
- No hardcoded secrets, tokens, or credentials
- User input is validated and sanitised
- No SQL injection, XSS, or path traversal vulnerabilities

### Performance
- No obviously inefficient algorithms (e.g. N+1 queries, unbounded loops)
- Large data sets handled with pagination or streaming
- No unnecessary blocking operations on the main thread

## Verdict Format

After completing your review, output exactly one of the following on its own line:

```
VERDICT: approved
```

```
VERDICT: changes_requested
```

If changes are requested, provide **specific, actionable feedback** above the
verdict explaining what needs to be fixed. Reference file paths and line numbers
where possible.

## Submitting the Review

Use the GitHub CLI to submit your review:

```bash
# Approve
gh pr review <pr-url> --approve --body "Looks good — all checks pass."

# Request changes
gh pr review <pr-url> --request-changes --body "<your detailed feedback>"
```
