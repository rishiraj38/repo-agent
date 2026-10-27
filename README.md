# Repo Agent

A Claude Code-style coding agent for your GitHub repositories, run with your own Anthropic API key. Paste a repo, describe a change, and watch the agent read the code, edit files, run commands, and commit and push. Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), which is the same harness Claude Code uses, so it has the same tools: Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, subagents.

One Node file plus one HTML file. The only dependency is the SDK.

## Run it locally

```bash
cp .env.example .env      # fill in ANTHROPIC_API_KEY and GITHUB_TOKEN
export $(grep -v '^#' .env | xargs)
npm install
npm start                 # http://localhost:3000
```

## Deploy

It needs a server with git installed and a writable disk for cloned repos. It cannot run on GitHub Pages or any static host.

| Host | How |
|------|-----|
| **Render** | New → Blueprint → pick this repo (`render.yaml` sets up Docker and a 5 GB disk). Fill in the env vars when asked. The free plan has no persistent disk, so use Starter or accept re-cloning after each restart. |
| **Railway / Fly.io** | Deploy from the Dockerfile, attach a volume at `/data`, set the env vars. |
| **Any VPS** | `docker build -t repo-agent . && docker run -p 3000:3000 -v $PWD/data:/data --env-file .env repo-agent` |

**Always set `APP_PASSWORD` on a public URL.** Anyone who can open the page can run the agent on your repos and spend your API credits.

## Env vars

| Var | Required | What |
|-----|----------|------|
| `ANTHROPIC_API_KEY` | yes | From platform.claude.com. Billed per token. |
| `GITHUB_TOKEN` | for private repos and pushing | Fine-grained token with Contents read/write on the repos you want, or a classic token with `repo`. Never written to disk inside the repo: git gets it through an askpass helper. |
| `APP_PASSWORD` | on public URLs | The UI asks for it once. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | no | Identity on commits the agent makes. |
| `AGENT_MODEL` | no | Default model. `claude-opus-5-5` if unset. |
| `WORKSPACE_DIR` | no | Where repos are cloned. `./workspaces` locally, `/data/workspaces` in Docker. |
| `PORT` | no | 3000 |

## How it works

- **Clone**: `POST /api/repos` clones into the workspace (shallow, then unshallowed in the background).
- **Run**: `POST /api/run` starts `query()` from the Agent SDK with `cwd` set to the repo, `permissionMode: "acceptEdits"`, and the standard tools allowed. Events stream to the browser over Server-Sent Events: text, thinking, every tool call with its input and output, and the final result with cost.
- **Sessions**: the SDK session id is kept per repo in the browser, so follow-up messages resume the same conversation. "New session" starts fresh.
- **Guardrails**: a `canUseTool` hook denies force-pushes, hard resets, `rm -rf /`, branch deletion, piping curl into a shell, sudo, and commands that print secrets. Everything else runs without asking, like Claude Code in auto-accept mode.
- **Changes panel**: live `git status`, diff and recent log, with Commit, Push, Pull and Discard buttons so you can review before anything leaves the server. You can also just tell the agent to commit and push.

## Limits

- One run per repo at a time. Different repos can run in parallel.
- Each run is one browser → server stream. If you close the tab mid-run the agent keeps going; reopen and select the repo to reattach.
- The agent runs on the server with that server's tools. If a repo needs a particular runtime (Go, Rust, Python packages), add it to the Dockerfile.
