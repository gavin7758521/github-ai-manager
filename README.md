# gh-ai-client

Small Node.js CLI for AI-assisted GitHub management. The first version only manages starred repositories and local collections.

## Install locally

```bash
cd ~/workspace/repos/gh-ai-client
npm install
npm link
```

You can also run without linking:

```bash
node bin/gh-ai-client.js help
```

## Commands

```bash
gh-ai-client help
gh-ai-client help stars

gh-ai-client auth set-token
gh-ai-client auth status
gh-ai-client auth clear-token

gh-ai-client model list
gh-ai-client model list codex
gh-ai-client model list pi openai
gh-ai-client model list local
gh-ai-client model use mock
gh-ai-client model use codex
gh-ai-client model use pi:openai/gpt-4o-mini
gh-ai-client model use openai-compatible:env
gh-ai-client model current
gh-ai-client model test

gh-ai-client stars sync
gh-ai-client stars list --limit 20
gh-ai-client stars search agent

gh-ai-client collections list
gh-ai-client collections show AI
gh-ai-client collections create AI
gh-ai-client collections add AI owner/repo
gh-ai-client collections remove AI owner/repo
gh-ai-client collections export collections.json
gh-ai-client collections import collections.json
gh-ai-client collections import collections.json --replace

gh-ai-client ai suggest --provider mock
gh-ai-client ai status
gh-ai-client ai step
gh-ai-client ai step --apply
gh-ai-client ai skip
gh-ai-client ai review
gh-ai-client ai apply
gh-ai-client ai clear

gh-ai-client data path
gh-ai-client data doctor
```

## Data

Data is stored in:

```text
~/.gh-ai-client/
  config.json
  stars.json
  collections.json
  suggestions.json
  history.jsonl
```

Set `GH_AI_CLIENT_HOME` to use a different directory for tests.

## GitHub Star API boundary

GitHub REST supports listing, starring, unstarring, and checking starred repositories. GitHub's web Star Lists do not have a clearly documented stable write API in the REST starring docs, so this CLI starts with local collections.

## AI providers

`mock` works offline and groups by repo metadata. It is hidden from the default model list; use `gh-ai-client model list local` if you need the offline fallback.

`openai-compatible` uses these environment variables:

```bash
OPENAI_COMPATIBLE_BASE_URL=https://your-model-host/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

`pi` uses `@earendil-works/pi-ai`:

```bash
gh-ai-client model list pi
gh-ai-client model list pi anthropic --limit 10
gh-ai-client model list codex
gh-ai-client model use codex
gh-ai-client model use pi:openai/gpt-4o-mini
gh-ai-client ai suggest --provider pi
```

`model use codex` selects the recommended OpenAI Codex model exposed by pi, such as `openai/gpt-5.3-codex` when available. The selected pi provider still needs its own API key/configuration available to pi.

## Suggested workflow

```bash
gh-ai-client auth set-token
gh-ai-client stars sync
gh-ai-client model use codex
gh-ai-client ai suggest
gh-ai-client ai review
```

Use `ai review` when you want to approve or skip one model-generated action at a time. Use `ai step --apply` when you want to apply only the next pending action from a script.

## Secret scanning

This project uses Gitleaks for local secret checks:

```bash
npm run secrets
npm run secrets:dir
npm run secrets:staged
npm run precommit
```

`npm run precommit` scans the staged diff for secrets and then runs the test suite.
