// repo-agent: a Claude Code-style coding agent for GitHub repos. Multi-user.
// Each person signs in with GitHub (OAuth) and brings their own Anthropic API key, which stays in their
// browser and is sent only with the requests that need it. Every user gets a separate workspace.
// One file, no framework.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(here, "workspaces"));
const DEFAULT_MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_RUNS_PER_USER = Number(process.env.MAX_RUNS_PER_USER || 2);
const MAX_REPOS_PER_USER = Number(process.env.MAX_REPOS_PER_USER || 10);
fs.mkdirSync(WORKSPACE, { recursive: true });
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  // Persist a generated secret so logins survive restarts even if the operator didn't set one.
  const f = path.join(WORKSPACE, ".session-secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch { const s = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(f, s, { mode: 0o600 }); return s; }
})();
if (!GH_CLIENT_ID || !GH_CLIENT_SECRET) console.warn("Warning: GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set. Nobody can sign in. Create an OAuth app at https://github.com/settings/developers");

/* ---------- sessions: encrypted cookie, nothing stored server-side ---------- */
const KEY = crypto.createHash("sha256").update(SESSION_SECRET).digest();
function seal(obj) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}
function unseal(s) {
  try { const b = Buffer.from(s, "base64url"); const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString()); } catch { return null; }
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=").map(decodeURIComponent)).filter((p) => p[0])); }
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  parts.push(opts.maxAge === 0 ? "Max-Age=0" : `Max-Age=${opts.maxAge ?? 60 * 60 * 24 * 30}`);
  res.setHeader("set-cookie", [...(res.getHeader("set-cookie") || []), parts.join("; ")]);
}
const isSecure = (req) => String(req.headers["x-forwarded-proto"] || "").startsWith("https") || !!req.socket.encrypted;
async function userFrom(req, res) {
  const u = unseal(cookies(req).ra_session || ""); if (!u || !u.id || !u.token) return null;
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(u.login.toLowerCase())) return null;
  if (u.exp && u.refresh && Date.now() > u.exp - 10 * 60 * 1000) {
    try {
      const tr = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: u.refresh }) }).then((r) => r.json());
      if (tr.access_token) { Object.assign(u, { token: tr.access_token, refresh: tr.refresh_token || u.refresh, exp: tr.expires_in ? Date.now() + tr.expires_in * 1000 : 0 }); if (res) setCookie(res, "ra_session", seal(u), { secure: isSecure(req) }); }
      else if (Date.now() > u.exp) return null;
    } catch { if (Date.now() > u.exp) return null; }
  }
  return u;
}

/* ---------- git: credentials via askpass from the per-request env, never on disk in the repo ---------- */
const askpass = path.join(WORKSPACE, ".askpass.sh");
fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$GH_TOKEN";; esac\n', { mode: 0o700 });
function gitEnv(user) {
  const { PATH, HOME, TMPDIR, LANG, NODE_ENV } = process.env; // deliberately not the whole server env
  const email = user.email || `${user.id}+${user.login}@users.noreply.github.com`, name = user.name || user.login;
  return { PATH, HOME, TMPDIR, LANG, NODE_ENV, GIT_ASKPASS: askpass, GH_TOKEN: user.token, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}
function run(cmd, args, { cwd, env, maxOut = 400_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { if (out.length < maxOut) out += d; });
    p.stderr.on("data", (d) => { if (err.length < maxOut) err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}
const git = (user, dir, ...args) => run("git", args, { cwd: dir, env: gitEnv(user) });

/* ---------- repos (per user) ---------- */
function parseRepoUrl(input) {
  const s = String(input || "").trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) || s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) || s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` };
}
const userRoot = (user) => path.join(WORKSPACE, `u${user.id}`);
const repoDir = (user, slug) => path.join(userRoot(user), slug.replace("/", "__"));
function safeRepo(user, slug) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug || "") || slug.includes("..")) return null;
  const dir = repoDir(user, slug);
  return fs.existsSync(path.join(dir, ".git")) ? dir : null;
}
const runKey = (user, slug) => `${user.id}/${slug}`;
async function repoInfo(user, slug) {
  const dir = safeRepo(user, slug); if (!dir) return null;
  const [branch, status, ahead] = await Promise.all([git(user, dir, "rev-parse", "--abbrev-ref", "HEAD"), git(user, dir, "status", "--porcelain"), git(user, dir, "rev-list", "--count", "@{u}..HEAD")]);
  return { slug, branch: branch.out.trim(), dirty: status.out.split("\n").filter(Boolean).length, ahead: Number(ahead.out.trim()) || 0, running: runs.has(runKey(user, slug)) };
}
async function listRepos(user) {
  const root = userRoot(user);
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.includes("__")) : [];
  return (await Promise.all(names.map((n) => repoInfo(user, n.replace("__", "/"))))).filter(Boolean);
}

/* ---------- agent runs ---------- */
const runs = new Map();     // key -> { controller, clients:Set<res>, events:[] }
const lastRuns = new Map(); // key -> events[] of the most recent finished run
const DANGEROUS = [/\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\.\.)\/?(\s|$)/i, /\bgit\s+push\b.*--force\b/i, /\bgit\s+push\s+-f\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-[a-z]*f/i, /\bgit\s+branch\s+-D\b/, /\bgh\s+repo\s+delete\b/i, /\bcurl\b.*\|\s*(ba)?sh\b/i, /\bsudo\b/i, /\bmkfs\b/, /\bdd\s+if=/];
const SECRETS = /\b(printenv|env)\b\s*$|\$GH_TOKEN|\$GITHUB_TOKEN|ANTHROPIC_API_KEY|GIT_ASKPASS|\.askpass|\.session-secret/i;

function send(res, ev) { res.write(`data: ${JSON.stringify(ev)}\n\n`); }
function broadcast(r, ev) { r.events.push(ev); if (r.events.length > 5000) r.events.shift(); for (const c of r.clients) send(c, ev); }
function summarizeTool(name, input) {
  const i = input || {};
  switch (name) {
    case "Bash": return i.description ? `${i.description}  —  ${i.command}` : String(i.command || "");
    case "Read": return String(i.file_path || "");
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return String(i.file_path || i.notebook_path || "");
    case "Glob": case "Grep": return `${i.pattern || ""}${i.path ? " in " + i.path : ""}`;
    case "WebFetch": return String(i.url || "");
    case "WebSearch": return String(i.query || "");
    case "Task": return String(i.description || i.prompt || "").slice(0, 200);
    default: return JSON.stringify(i).slice(0, 300);
  }
}
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : "")).join("") : "");
const insideDir = (p, dir) => { if (!p) return true; const abs = path.resolve(dir, String(p)); return abs === dir || abs.startsWith(dir + path.sep); };

async function startRun(user, slug, { prompt, sessionId, model, effort, apiKey }) {
  const dir = safeRepo(user, slug); if (!dir) throw new Error("Unknown repo");
  const key = runKey(user, slug);
  if (runs.has(key)) throw new Error("A run is already in progress for this repo");
  if ([...runs.keys()].filter((k) => k.startsWith(user.id + "/")).length >= MAX_RUNS_PER_USER) throw new Error(`You already have ${MAX_RUNS_PER_USER} runs going. Wait for one to finish.`);
  const controller = new AbortController();
  const r = { controller, clients: new Set(), events: [], startedAt: Date.now() };
  runs.set(key, r);
  const uroot = userRoot(user);

  (async () => {
    try {
      const q = query({
        prompt,
        options: {
          cwd: dir,
          model: model || DEFAULT_MODEL,
          effort: effort || undefined,
          // Resume only if this user's session store still exists (free hosts wipe disk on restart).
          resume: sessionId && fs.existsSync(path.join(uroot, ".claude", "projects")) ? sessionId : undefined,
          permissionMode: "acceptEdits",
          allowedTools: [],           // everything goes through canUseTool so the policy runs
          settingSources: [],         // ignore any ~/.claude settings on the server
          includePartialMessages: true,
          abortController: controller,
          env: { ...gitEnv(user), ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: path.join(uroot, ".claude") },
          systemPrompt: {
            type: "preset", preset: "claude_code",
            append: `You are working inside the git repository ${slug} for GitHub user ${user.login}, already cloned at ${dir}. Stay inside this directory. The user talks to you from a web UI and cannot see your tool calls, only your final message, so finish with a short summary of what you changed. Git is authenticated as the user: commit and push with ordinary git commands when asked, with clear commit messages. Never force-push, never rewrite published history, never delete branches, and never print environment variables or tokens.`,
          },
          canUseTool: async (toolName, input) => {
            const deny = (message) => ({ behavior: "deny", message });
            if (toolName === "Bash") {
              const cmd = String(input.command || "");
              if (DANGEROUS.some((re) => re.test(cmd))) return deny("Blocked by repo-agent policy: destructive or history-rewriting command.");
              if (SECRETS.test(cmd)) return deny("Blocked: do not read secrets.");
              if (cmd.includes(WORKSPACE) && !cmd.includes(uroot)) return deny("Blocked: other users' workspaces are off limits.");
            }
            for (const k of ["file_path", "notebook_path", "path"]) if (input[k] != null && !insideDir(input[k], dir)) return deny(`Blocked: ${input[k]} is outside the repository.`);
            return { behavior: "allow", updatedInput: input };
          },
        },
      });

      let textBuf = "";
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") broadcast(r, { type: "init", session_id: m.session_id, model: m.model });
        else if (m.type === "stream_event") {
          const e = m.event;
          if (e.type === "content_block_delta" && e.delta?.type === "text_delta") { textBuf += e.delta.text; broadcast(r, { type: "text", delta: e.delta.text }); }
          else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) broadcast(r, { type: "thinking", delta: e.delta.thinking });
          else if (e.type === "message_stop") { if (textBuf) broadcast(r, { type: "text_end" }); textBuf = ""; }
        } else if (m.type === "assistant") {
          for (const b of m.message.content || []) if (b.type === "tool_use") broadcast(r, { type: "tool_use", id: b.id, name: b.name, summary: summarizeTool(b.name, b.input), input: b.name === "Edit" || b.name === "Write" ? b.input : undefined, parent: m.parent_tool_use_id });
        } else if (m.type === "user") {
          for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) if (b.type === "tool_result") { const t = textOf(b.content); broadcast(r, { type: "tool_result", id: b.tool_use_id, is_error: !!b.is_error, output: t.length > 4000 ? t.slice(0, 4000) + `\n… (${t.length - 4000} more chars)` : t }); }
        } else if (m.type === "result") {
          broadcast(r, { type: "result", subtype: m.subtype, is_error: m.is_error, session_id: m.session_id, cost: m.total_cost_usd, turns: m.num_turns, duration_ms: m.duration_ms, errors: m.errors || [], text: m.subtype === "success" ? m.result : "" });
        }
      }
    } catch (e) {
      broadcast(r, { type: "error", message: controller.signal.aborted ? "Stopped." : String(e?.message || e) });
    } finally {
      runs.delete(key);
      broadcast(r, { type: "done", repo: await repoInfo(user, slug).catch(() => null) });
      for (const c of r.clients) c.end();
      lastRuns.set(key, r.events);
    }
  })();
  return r;
}

/* ---------- github api ---------- */
async function gh(token, url) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "repo-agent" } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

/* ---------- http ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function json(res, code, body) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); }); }
const baseUrl = (req) => `${isSecure(req) ? "https" : "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  try {
    /* auth */
    if (p === "/auth/github") {
      if (!GH_CLIENT_ID) return json(res, 500, { error: "GitHub OAuth is not configured on this server" });
      const state = crypto.randomBytes(16).toString("hex");
      setCookie(res, "ra_state", state, { secure: isSecure(req), maxAge: 600 });
      const q = new URLSearchParams({ client_id: GH_CLIENT_ID, redirect_uri: baseUrl(req) + "/auth/callback", scope: "repo read:user user:email", state });
      res.writeHead(302, { location: "https://github.com/login/oauth/authorize?" + q }); return res.end();
    }
    if (p === "/auth/callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state || state !== cookies(req).ra_state) { res.writeHead(400); return res.end("Bad OAuth state. Go back and try signing in again."); }
      const tr = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code, redirect_uri: baseUrl(req) + "/auth/callback" }) }).then((r) => r.json());
      if (!tr.access_token) { res.writeHead(400); return res.end("GitHub did not return a token: " + (tr.error_description || tr.error || "unknown")); }
      const me = await gh(tr.access_token, "https://api.github.com/user");
      let email = me.email;
      if (!email) { try { const emails = await gh(tr.access_token, "https://api.github.com/user/emails"); email = (emails.find((e) => e.primary) || emails[0])?.email; } catch {} }
      if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(me.login.toLowerCase())) { res.writeHead(403); return res.end(`@${me.login} is not on this server's allow list.`); }
      setCookie(res, "ra_session", seal({ id: String(me.id), login: me.login, name: me.name || "", email: email || "", avatar: me.avatar_url, token: tr.access_token, refresh: tr.refresh_token || "", exp: tr.expires_in ? Date.now() + tr.expires_in * 1000 : 0 }), { secure: isSecure(req) });
      setCookie(res, "ra_state", "", { maxAge: 0 });
      res.writeHead(302, { location: "/" }); return res.end();
    }
    if (p === "/auth/logout") { setCookie(res, "ra_session", "", { maxAge: 0 }); res.writeHead(302, { location: "/" }); return res.end(); }

    if (p === "/api/config") return json(res, 200, { oauth: !!GH_CLIENT_ID, model: DEFAULT_MODEL, allowList: ALLOWED_USERS.length > 0 });

    if (p.startsWith("/api/")) {
      const user = await userFrom(req, res);
      if (!user) { setCookie(res, "ra_session", "", { maxAge: 0 }); return json(res, 401, { error: "Sign in with GitHub first" }); }
      if (p === "/api/me") return json(res, 200, { id: user.id, login: user.login, name: user.name, avatar: user.avatar });

      if (p === "/api/github/repos") {
        const list = await gh(user.token, "https://api.github.com/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member");
        return json(res, 200, list.map((r) => ({ slug: r.full_name, private: r.private, pushed: r.pushed_at })));
      }

      if (p === "/api/repos" && req.method === "GET") return json(res, 200, await listRepos(user));
      if (p === "/api/repos" && req.method === "POST") {
        const { url: u } = await readBody(req);
        const info = parseRepoUrl(u); if (!info) return json(res, 400, { error: "That doesn't look like a GitHub repo (owner/name or https://github.com/owner/name)." });
        const dir = repoDir(user, info.slug);
        if (fs.existsSync(dir)) return json(res, 200, await repoInfo(user, info.slug));
        if ((await listRepos(user)).length >= MAX_REPOS_PER_USER) return json(res, 400, { error: `Limit of ${MAX_REPOS_PER_USER} repos reached. Remove one first.` });
        fs.mkdirSync(userRoot(user), { recursive: true });
        const c = await run("git", ["clone", "--depth=50", info.url, dir], { cwd: userRoot(user), env: gitEnv(user) });
        if (c.code !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return json(res, 400, { error: "Clone failed: " + (c.err.split("\n").filter(Boolean).pop() || "unknown error") }); }
        git(user, dir, "fetch", "--unshallow").catch(() => {});
        return json(res, 200, await repoInfo(user, info.slug));
      }
      if (p === "/api/repos" && req.method === "DELETE") {
        const { repo } = await readBody(req); const dir = safeRepo(user, repo); if (!dir) return json(res, 404, { error: "Unknown repo" });
        if (runs.has(runKey(user, repo))) return json(res, 409, { error: "Stop the running agent first" });
        fs.rmSync(dir, { recursive: true, force: true }); return json(res, 200, { ok: true });
      }

      if (p === "/api/run" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.prompt?.trim()) return json(res, 400, { error: "Empty prompt" });
        const apiKey = String(req.headers["x-anthropic-key"] || "").trim();
        if (!/^sk-ant-/.test(apiKey)) return json(res, 400, { error: "Add your Anthropic API key in Settings first" });
        try { await startRun(user, body.repo, { ...body, apiKey }); } catch (e) { return json(res, 409, { error: e.message }); }
        return json(res, 200, { ok: true });
      }
      if (p === "/api/run/events" && req.method === "GET") {
        const slug = url.searchParams.get("repo"); const key = runKey(user, slug); const r = runs.get(key);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        if (!r) { const evs = lastRuns.get(key) || []; for (const ev of evs) send(res, ev); if (!evs.some((e) => e.type === "done")) send(res, { type: "done", repo: await repoInfo(user, slug) }); return res.end(); }
        for (const ev of r.events) send(res, ev);
        r.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => { clearInterval(ping); r.clients.delete(res); });
        return;
      }
      if (p === "/api/run/stop" && req.method === "POST") {
        const { repo } = await readBody(req); const r = runs.get(runKey(user, repo)); if (!r) return json(res, 200, { ok: true, wasRunning: false });
        r.controller.abort(); return json(res, 200, { ok: true, wasRunning: true });
      }

      if (p === "/api/git/diff" && req.method === "GET") {
        const slug = url.searchParams.get("repo"); const dir = safeRepo(user, slug); if (!dir) return json(res, 404, { error: "Unknown repo" });
        const [status, log, full] = await Promise.all([git(user, dir, "status", "--porcelain=v1", "--untracked-files=all"), git(user, dir, "log", "--oneline", "-8", "--decorate"), git(user, dir, "diff", "HEAD")]);
        const untracked = status.out.split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
        let extra = "";
        for (const f of untracked.slice(0, 20)) { try { const fp = path.join(dir, f); if (fs.statSync(fp).size < 200_000) extra += `\ndiff --git a/${f} b/${f}\n--- /dev/null\n+++ b/${f}\n` + fs.readFileSync(fp, "utf8").split("\n").map((l) => "+" + l).join("\n") + "\n"; } catch {} }
        const text = full.out + extra;
        return json(res, 200, { status: status.out, log: log.out, diff: text.length > 300_000 ? text.slice(0, 300_000) + "\n… diff truncated" : text, info: await repoInfo(user, slug) });
      }
      if (p === "/api/git" && req.method === "POST") {
        const { repo, action, message } = await readBody(req); const dir = safeRepo(user, repo); if (!dir) return json(res, 404, { error: "Unknown repo" });
        if (runs.has(runKey(user, repo))) return json(res, 409, { error: "Wait for the agent to finish" });
        let r;
        if (action === "commit") { await git(user, dir, "add", "-A"); r = await git(user, dir, "commit", "-m", message?.trim() || "Changes by repo-agent"); }
        else if (action === "push") r = await git(user, dir, "push", "-u", "origin", "HEAD");
        else if (action === "pull") r = await git(user, dir, "pull", "--rebase");
        else if (action === "discard") { await git(user, dir, "reset", "--hard"); r = await git(user, dir, "clean", "-fd"); }
        else return json(res, 400, { error: "Unknown action" });
        return json(res, r.code === 0 ? 200 : 400, { ok: r.code === 0, out: (r.out + "\n" + r.err).trim(), info: await repoInfo(user, repo) });
      }
      return json(res, 404, { error: "Not found" });
    }

    /* static */
    let file = path.join(here, "public", p === "/" ? "index.html" : p);
    if (!file.startsWith(path.join(here, "public"))) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) }); else res.end();
  }
}).listen(PORT, () => console.log(`repo-agent running on http://localhost:${PORT}  (workspace: ${WORKSPACE})`));
