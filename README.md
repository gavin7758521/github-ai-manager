# gh-ai-client

Small Node.js CLI for AI-assisted GitHub management. It operates on live GitHub API data.

## Install locally

```bash
cd ~/workspace/repos/gh-ai-client
npm install
npm link
```

After linking, use:

```bash
ghac help
```

## Commands

```bash
ghac help

ghac auth set-token
ghac auth status
ghac auth clear-token

ghac proxy set http://127.0.0.1:7890
ghac proxy status
ghac proxy clear

ghac codex login
ghac codex status
ghac codex logout

ghac model list
ghac model list codex
ghac model list pi openai
ghac model use codex
ghac model use pi:openai/gpt-4o-mini
ghac model current
ghac model test

ghac stars list
ghac stars list --limit 20
ghac stars search agent
ghac stars star owner/repo
ghac stars unstar owner/repo

ghac lists list
ghac lists show "AI Tools"
ghac lists create "AI Tools"
ghac lists create "AI Tools" --description "AI projects and agents" --private
ghac lists add "AI Tools" openai/codex
ghac lists add "AI Tools" openai/codex --create
ghac lists remove "AI Tools" openai/codex

ghac ai
ghac ai plan "帮我把 AI agent 相关仓库整理到 AI-智能体"

ghac data path
ghac data doctor
```

`stars`, `lists`, and `ai` read GitHub online through REST or GraphQL on each run.

## Data

Only credentials and configuration are stored locally:

```text
~/.ghac/
  config.json
  pi-auth.json
```

`config.json` stores the GitHub token, proxy config, and selected model. `pi-auth.json` stores pi/Codex OAuth credentials. Stars, Star Lists, and AI plans are not stored by this CLI.

Set `GHAC_HOME` to use a different config directory for tests. `GH_AI_CLIENT_HOME` is still accepted as a legacy override.

## GitHub Star Lists

`ghac stars` uses GitHub REST for starred repositories. `ghac lists` uses GitHub GraphQL `UserList` APIs for GitHub-native Star Lists:

```bash
ghac lists list
ghac lists add "AI Tools" openai/codex
```

`lists add` preserves the repository's existing Star List memberships. By default it also stars the repository first if it is not already starred.

## AI Shell

```bash
ghac ai
```

Inside the shell, natural language reads live GitHub data, asks the configured model for a plan, and asks before applying write actions:

```text
/help
/model current
/stars list
/lists list
/lists add "AI Tools" openai/codex
/plan 帮我整理最近 star 的 RAG 仓库
/apply
/context
/refresh
/forget
/exit
```

`ghac ai` keeps conversation history, the latest plan, and the latest GitHub context in memory while the shell is running. It does not write that session memory to disk.

Use `/context` to inspect the current in-memory state, `/refresh` to reload GitHub online data, and `/forget` to clear conversation memory and the pending plan.

Command-line `ghac ai plan ...` prints a plan but does not save it. Use `ghac ai` when you want to apply a plan.

## AI Providers

`pi` uses `@earendil-works/pi-ai`:

```bash
ghac codex login
ghac model list codex
ghac model use codex
ghac ai
```

`openai-compatible` uses these environment variables:

```bash
OPENAI_COMPATIBLE_BASE_URL=https://your-model-host/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

## Suggested Workflow

```bash
ghac proxy set http://127.0.0.1:7890
ghac auth set-token
ghac codex login
ghac model use codex
ghac ai
```

## Secret Scanning

This project uses Gitleaks for local secret checks:

```bash
npm run secrets
npm run secrets:dir
npm run secrets:staged
npm run precommit
```

`npm run precommit` scans the staged diff for secrets and then runs the test suite.
