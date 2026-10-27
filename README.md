# Repo Agent

A Claude Code-style coding agent for GitHub repositories that anyone can use: sign in with GitHub, paste your Anthropic API key, pick a repo, and tell the agent what to do. It reads the code, edits files, runs commands and tests, and commits and pushes as you. Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), the same harness Claude Code runs on, so it has the same tools.

Each user's API key stays in their own browser and is sent only with their runs, so every person pays for their own usage. Each user gets a separate workspace on the server. The operator only needs a GitHub OAuth app.

One Node file plus one HTML file. The only dependency is the SDK.

## Set up (operator)

1. **Create a GitHub OAuth app** at https://github.com/settings/developers → OAuth Apps → New OAuth App.
   - Homepage URL: your site, e.g. `https://repo-agent.onrender.com`
   - Authorization callback URL: `https://repo-agent.onrender.com/auth/callback`
   - Copy the Client ID and generate a Client Secret.
2. **Deploy** with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and a random `SESSION_SECRET` set (see below).
3. Optionally set `ALLOWED_USERS=login1,login2` to restrict sign-in to friends.

### Run locally

```bash
cp .env.example .env      # fill in the OAuth app values; callback URL http://localhost:3000/auth/callback
export $(grep -v '^#' .env | grep -v '^$' | xargs)
npm install && npm start  # http://localhost:3000
```

### Free hosting

It needs a server that can run git and shell commands, so GitHub Pages and other static hosts won't work. Free options:

| Host | How |
|------|-----|
| **Render (free)** | New → Blueprint → this repo. `render.yaml` uses the free plan: no disk, so cloned repos disappear when the service restarts or sleeps after 15 minutes idle. Users just add the repo again. |
| **Hugging Face Spaces (free, Docker)** | New Space → Docker → push this repo. Add the env vars as Space secrets and set `app_port: 3000` in the Space README front matter. More RAM than Render free. |
| **Google Cloud Run** | `gcloud run deploy --source .` with the env vars. Generous free tier, scales to zero. |

Paid anywhere: attach a disk at `/data` (the Dockerfile uses `/data/workspaces`) and repos persist.

## Use it (everyone)

1. Open the site, click **Continue with GitHub**, authorise the app (it asks for `repo` so it can clone and push for you).
2. Click the gear in the sidebar and paste your Anthropic API key from platform.claude.com.
3. Type a repo (the box suggests your GitHub repos) and press +.
4. Chat. Every tool call shows as a card; the Changes panel shows the diff with Commit, Push, Pull and Discard buttons. Or just tell the agent to commit and push.

## Env vars

| Var | Required | What |
|-----|----------|------|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes | From the OAuth app. |
| `SESSION_SECRET` | recommended | Encrypts login cookies. Generated and stored on disk if empty, which means logins reset when a diskless host restarts. |
| `ALLOWED_USERS` | no | Comma-separated GitHub logins. Empty = open to anyone. |
| `MAX_RUNS_PER_USER`, `MAX_REPOS_PER_USER` | no | Defaults 2 and 10. |
| `AGENT_MODEL` | no | Default `claude-opus-5-5`. Users can pick Sonnet or Haiku in the UI. |
| `WORKSPACE_DIR` | no | `./workspaces` locally, `/data/workspaces` in Docker, `/tmp/workspaces` on Render free. |
| `PORT` | no | 3000 |

## How it works

- **Login**: GitHub OAuth. The access token is kept in an encrypted, HttpOnly cookie, never on the server's disk.
- **Clone**: into `workspaces/u<github-id>/owner__repo`. Git gets the user's token through an askpass helper, so it never lands in `.git/config`.
- **Run**: `query()` from the Agent SDK with `cwd` set to the repo, the user's key in the subprocess env, `permissionMode: "acceptEdits"`, and a `canUseTool` policy that blocks force-pushes, hard resets, branch deletion, `rm -rf /`, sudo, curl-to-shell, reading secrets, and any path outside the user's repo. Events stream to the browser over SSE.
- **Sessions**: the SDK session id is kept per user and repo in the browser, so follow-ups resume the same conversation.

## Trust model

Agents from different users run as the same OS user on one server. The policy keeps them inside their own repo for normal use, but it is a filter, not a sandbox. Use `ALLOWED_USERS` to limit sign-in to people you trust, or run each user in their own container if you open it to strangers.
