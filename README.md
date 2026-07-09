# github-ai-manager

GitHub AI Manager is a Node.js CLI for AI-assisted GitHub management. It operates on live GitHub API data.

## Install from npm

```bash
npm install -g @gavin7758521/github-ai-manager
```

## Install locally

```bash
cd ~/workspace/repos/github-ai-manager
npm install
npm link
```

After linking, use:

```bash
gham help
```

## Commands

```bash
gham help

gham auth set-token
gham auth status
gham auth clear-token

gham proxy set http://127.0.0.1:7890
gham proxy status
gham proxy clear

gham codex login
gham codex status
gham codex logout

gham model list
gham model list codex
gham model list pi openai
gham model use codex
gham model use pi:openai/gpt-4o-mini
gham model current
gham model test

gham stars list
gham stars list --limit 20
gham stars search agent
gham stars star owner/repo
gham stars unstar owner/repo

gham lists list
gham lists show "AI Tools"
gham lists create "AI Tools"
gham lists create "AI Tools" --description "AI projects and agents" --private
gham lists add "AI Tools" openai/codex
gham lists add "AI Tools" openai/codex --create
gham lists remove "AI Tools" openai/codex
gham lists delete "AI Tools" --yes

gham cli
gham cli plan "帮我把 AI agent 相关仓库整理到 AI-智能体"

gham mcp serve
gham-mcp

gham data path
gham data doctor
```

`stars`, `lists`, and `cli` read GitHub online through REST or GraphQL on each run.

## Data

Only credentials and configuration are stored locally:

```text
~/.gham/
  config.json
  pi-auth.json
```

`config.json` stores the GitHub token, proxy config, and selected model. `pi-auth.json` stores pi/Codex OAuth credentials. Stars, Star Lists, and AI plans are not stored by this CLI.

Set `GHAM_HOME` to use a different config directory for tests.

## GitHub Star Lists

`gham stars` uses GitHub REST for starred repositories. `gham lists` uses GitHub GraphQL `UserList` APIs for GitHub-native Star Lists:

```bash
gham lists list
gham lists add "AI Tools" openai/codex
```

`lists add` preserves the repository's existing Star List memberships. By default it also stars the repository first if it is not already starred.

## CLI Shell

```bash
gham cli
```

Inside the shell, natural language reads live GitHub data, asks the configured model for a plan, and asks before applying write actions:

```text
/help
/model current
/stars list
/lists list
/lists add "AI Tools" openai/codex
/lists delete "AI Tools" --yes
/plan 帮我整理最近 star 的 RAG 仓库
/apply
/context
/refresh
/forget
/exit
```

`gham cli` keeps conversation history, the latest plan, and the latest GitHub context in memory while the shell is running. It does not write that session memory to disk.

Use `/context` to inspect the current in-memory state, `/refresh` to reload GitHub online data, and `/forget` to clear conversation memory and the pending plan.

Command-line `gham cli plan ...` prints a plan but does not save it. Use `gham cli` when you want to apply a plan.

## MCP Server

`github-ai-manager` includes a stdio MCP server for Codex, Claude Code, and other MCP clients:

```bash
gham-mcp
gham mcp serve
```

Add it to Codex:

```bash
codex mcp add github-ai-manager -- gham-mcp
```

Add it to Claude Code:

```bash
claude mcp add github-ai-manager -- gham-mcp
```

The MCP tools use the same `~/.gham/config.json` GitHub token and proxy configuration as the CLI. They read GitHub online and write directly to GitHub only through explicit structured tools:

```text
stars_list
stars_search
star_repo
unstar_repo
lists_list
lists_show
lists_create
lists_add_repo
lists_remove_repo
lists_delete
```

## GitHub API Pacing

GitHub API calls are serialized with light pacing to reduce secondary rate-limit and abuse-detection risk. Defaults:

```bash
GHAM_GITHUB_READ_DELAY_MS=150
GHAM_GITHUB_WRITE_DELAY_MS=1000
GHAM_GITHUB_MAX_RETRIES=2
```

Increase `GHAM_GITHUB_WRITE_DELAY_MS` before large batch Star List edits if GitHub begins returning rate-limit or abuse-detection responses.

## AI Providers

`pi` uses `@earendil-works/pi-ai`:

```bash
gham codex login
gham model list codex
gham model use codex
gham cli
```

`openai-compatible` uses these environment variables:

```bash
OPENAI_COMPATIBLE_BASE_URL=https://your-model-host/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

## Suggested Workflow

```bash
gham proxy set http://127.0.0.1:7890
gham auth set-token
gham codex login
gham model use codex
gham cli
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
