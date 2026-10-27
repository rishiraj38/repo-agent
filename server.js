// repo-agent: a Claude Code-style coding agent for GitHub repos, driven by your own API key.
// One file, no framework. Clones repos into a workspace, runs the Claude Agent SDK inside them,
// streams what the agent does to the browser, and exposes git status/diff/commit/push.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(here, "workspaces"));
const DEFAULT_MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
fs.mkdirSync(WORKSPACE, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY) console.warn("Warning: ANTHROPIC_API_KEY is not set. Runs will only work if the Claude Code binary can authenticate another way (claude login, apiKeyHelper, Bedrock/Vertex).");
if (!GITHUB_TOKEN) console.warn("Warning: GITHUB_TOKEN is not set. Only public repos can be cloned, and pushes will fail.");

/* ---------- git credentials: never written into the repo ----------
   Git asks the ASKPASS program for the username/password; it answers from the env.
   The token therefore never lands in .git/config where the agent (or a diff) could see it. */
const askpass = path.join(WORKSPACE, ".askpass.sh");
fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$GH_TOKEN";; esac\n', { mode: 0o700 });
function gitEnv() {
  return {
    ...process.env,
    GIT_ASKPASS: askpass,
    GH_TOKEN: GITHUB_TOKEN,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "repo-agent",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "repo-agent@users.noreply.github.com",
    GIT_COMMITTER_NAME: process.env.GIT_AUTHOR_NAME || "repo-agent",
    GIT_COMMITTER_EMAIL: process.env.GIT_AUTHOR_EMAIL || "repo-agent@users.noreply.github.com",
  };
}

function run(cmd, args, { cwd, env = gitEnv(), maxOut = 400_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { if (out.length < maxOut) out += d; });
    p.stderr.on("data", (d) => { if (err.length < maxOut) err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}
const git = (dir, ...args) => run("git", args, { cwd: dir });

/* ---------- repos ---------- */
function parseRepoUrl(input) {
  const s = String(input || "").trim();
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
       || s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
       || s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` };
}
const repoDir = (slug) => path.join(WORKSPACE, slug.replace("/", "__"));
function safeRepo(slug) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug || "")) return null;
  const dir = repoDir(slug);
  return fs.existsSync(path.join(dir, ".git")) ? dir : null;
}
async function repoInfo(slug) {
  const dir = safeRepo(slug); if (!dir) return null;
  const [branch, status, ahead] = await Promise.all([
    git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
    git(dir, "status", "--porcelain"),
    git(dir, "rev-list", "--count", "@{u}..HEAD"),
  ]);
  return { slug, branch: branch.out.trim(), dirty: status.out.split("\n").filter(Boolean).length, ahead: Number(ahead.out.trim()) || 0, running: runs.has(slug) };
}
async function listRepos() {
  const names = fs.existsSync(WORKSPACE) ? fs.readdirSync(WORKSPACE).filter((n) => !n.startsWith(".") && n.includes("__")) : [];
  return (await Promise.all(names.map((n) => repoInfo(n.replace("__", "/"))))).filter(Boolean);
}

/* ---------- agent runs ---------- */
const runs = new Map();     // slug -> { controller, clients:Set<res>, events:[] }  (in progress)
const lastRuns = new Map(); // slug -> events[] of the most recent finished run, for clients that reconnect late
const DANGEROUS = [/\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\.\.)\/?(\s|$)/i, /\bgit\s+push\b.*--force\b/i, /\bgit\s+push\s+-f\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-[a-z]*f/i, /\bgit\s+branch\s+-D\b/, /\bgh\s+repo\s+delete\b/i, /\bcurl\b.*\|\s*(ba)?sh\b/i, /\bsudo\b/i, /\bmkfs\b/, /\bdd\s+if=/];

function send(res, ev) { res.write(`data: ${JSON.stringify(ev)}\n\n`); }
function broadcast(r, ev) { r.events.push(ev); if (r.events.length > 5000) r.events.shift(); for (const c of r.clients) send(c, ev); }

function summarizeTool(name, input) {
  const i = input || {};
  switch (name) {
    case "Bash": return i.description ? `${i.description}  —  ${i.command}` : String(i.command || "");
    case "Read": return String(i.file_path || "");
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return String(i.file_path || i.notebook_path || "");
    case "Glob": return `${i.pattern || ""}${i.path ? " in " + i.path : ""}`;
    case "Grep": return `${i.pattern || ""}${i.path ? " in " + i.path : ""}`;
    case "WebFetch": return String(i.url || "");
    case "WebSearch": return String(i.query || "");
    case "Task": return String(i.description || i.prompt || "").slice(0, 200);
    default: return JSON.stringify(i).slice(0, 300);
  }
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

async function startRun(slug, { prompt, sessionId, model, effort }) {
  const dir = safeRepo(slug); if (!dir) throw new Error("Unknown repo");
  if (runs.has(slug)) throw new Error("A run is already in progress for this repo");
  const controller = new AbortController();
  const r = { controller, clients: new Set(), events: [], startedAt: Date.now() };
  runs.set(slug, r);

  (async () => {
    try {
      const q = query({
        prompt,
        options: {
          cwd: dir,
          model: model || DEFAULT_MODEL,
          effort: effort || undefined,
          resume: sessionId || undefined,
          permissionMode: "acceptEdits",
          // No bare allowedTools: every tool call falls through to canUseTool below so the policy actually runs.
          // acceptEdits still auto-approves file edits inside the repo.
          allowedTools: [],
          includePartialMessages: true,
          abortController: controller,
          env: gitEnv(),
          systemPrompt: {
            type: "preset", preset: "claude_code",
            append: `You are working inside the git repository ${slug}, already cloned at ${dir}. The user talks to you from a web UI and cannot see your tool calls, only your final message, so finish with a short summary of what you changed. Git is authenticated: commit and push with ordinary git commands when the user asks you to, using clear commit messages. Never force-push, never rewrite published history, never delete branches, and never print environment variables or tokens.`,
          },
          canUseTool: async (toolName, input) => {
            if (toolName === "Bash") {
              const cmd = String(input.command || "");
              if (DANGEROUS.some((re) => re.test(cmd))) return { behavior: "deny", message: "Blocked by repo-agent policy: destructive or history-rewriting command." };
              if (/\b(printenv|env)\b\s*$|\$GH_TOKEN|\$GITHUB_TOKEN|ANTHROPIC_API_KEY/i.test(cmd)) return { behavior: "deny", message: "Blocked: do not read secrets." };
            }
            return { behavior: "allow", updatedInput: input };
          },
          settingSources: [],
        },
      });

      let textBuf = "";
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          broadcast(r, { type: "init", session_id: m.session_id, model: m.model });
        } else if (m.type === "stream_event") {
          const e = m.event;
          if (e.type === "content_block_delta" && e.delta?.type === "text_delta") { textBuf += e.delta.text; broadcast(r, { type: "text", delta: e.delta.text }); }
          else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) broadcast(r, { type: "thinking", delta: e.delta.thinking });
          else if (e.type === "message_stop") { if (textBuf) broadcast(r, { type: "text_end" }); textBuf = ""; }
        } else if (m.type === "assistant") {
          for (const b of m.message.content || []) {
            if (b.type === "tool_use") broadcast(r, { type: "tool_use", id: b.id, name: b.name, summary: summarizeTool(b.name, b.input), input: b.name === "Edit" || b.name === "Write" ? b.input : undefined, parent: m.parent_tool_use_id });
          }
        } else if (m.type === "user") {
          for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) {
            if (b.type === "tool_result") {
              const t = textOf(b.content);
              broadcast(r, { type: "tool_result", id: b.tool_use_id, is_error: !!b.is_error, output: t.length > 4000 ? t.slice(0, 4000) + `\n… (${t.length - 4000} more chars)` : t });
            }
          }
        } else if (m.type === "result") {
          broadcast(r, { type: "result", subtype: m.subtype, is_error: m.is_error, session_id: m.session_id, cost: m.total_cost_usd, turns: m.num_turns, duration_ms: m.duration_ms, errors: m.errors || [], text: m.subtype === "success" ? m.result : "" });
        }
      }
    } catch (e) {
      broadcast(r, { type: "error", message: controller.signal.aborted ? "Stopped." : String(e?.message || e) });
    } finally {
      runs.delete(slug);
      const info = await repoInfo(slug).catch(() => null);
      broadcast(r, { type: "done", repo: info });
      for (const c of r.clients) c.end();
      lastRuns.set(slug, r.events);
    }
  })();
  return r;
}

/* ---------- http ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function json(res, code, body) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); }); }
function authed(req) { return !APP_PASSWORD || req.headers["x-app-password"] === APP_PASSWORD || new URL(req.url, "http://x").searchParams.get("pw") === APP_PASSWORD; }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  try {
    if (p === "/api/config") return json(res, 200, { needsPassword: !!APP_PASSWORD, hasKey: !!process.env.ANTHROPIC_API_KEY, hasGithubToken: !!GITHUB_TOKEN, model: DEFAULT_MODEL });
    if (p.startsWith("/api/")) {
      if (!authed(req)) return json(res, 401, { error: "Wrong or missing app password" });

      if (p === "/api/repos" && req.method === "GET") return json(res, 200, await listRepos());
      if (p === "/api/repos" && req.method === "POST") {
        const { url: u } = await readBody(req);
        const info = parseRepoUrl(u); if (!info) return json(res, 400, { error: "That doesn't look like a GitHub repo URL (owner/name or https://github.com/owner/name)." });
        const dir = repoDir(info.slug);
        if (fs.existsSync(dir)) return json(res, 200, await repoInfo(info.slug));
        const c = await run("git", ["clone", "--depth=50", info.url, dir], { cwd: WORKSPACE });
        if (c.code !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return json(res, 400, { error: "Clone failed: " + (c.err.split("\n").filter(Boolean).pop() || "unknown error") }); }
        await git(dir, "fetch", "--unshallow").catch(() => {});
        return json(res, 200, await repoInfo(info.slug));
      }
      if (p === "/api/repos" && req.method === "DELETE") {
        const { repo } = await readBody(req); const dir = safeRepo(repo); if (!dir) return json(res, 404, { error: "Unknown repo" });
        if (runs.has(repo)) return json(res, 409, { error: "Stop the running agent first" });
        fs.rmSync(dir, { recursive: true, force: true }); return json(res, 200, { ok: true });
      }

      if (p === "/api/run" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.prompt?.trim()) return json(res, 400, { error: "Empty prompt" });
        try { await startRun(body.repo, body); } catch (e) { return json(res, 409, { error: e.message }); }
        return json(res, 200, { ok: true });
      }
      if (p === "/api/run/events" && req.method === "GET") {
        const slug = url.searchParams.get("repo"); const r = runs.get(slug);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        if (!r) { for (const ev of lastRuns.get(slug) || []) send(res, ev); if (!(lastRuns.get(slug) || []).some((e) => e.type === "done")) send(res, { type: "done", repo: await repoInfo(slug) }); return res.end(); }
        for (const ev of r.events) send(res, ev);
        r.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => { clearInterval(ping); r.clients.delete(res); });
        return;
      }
      if (p === "/api/run/stop" && req.method === "POST") {
        const { repo } = await readBody(req); const r = runs.get(repo); if (!r) return json(res, 200, { ok: true, wasRunning: false });
        r.controller.abort(); return json(res, 200, { ok: true, wasRunning: true });
      }

      if (p === "/api/git/diff" && req.method === "GET") {
        const dir = safeRepo(url.searchParams.get("repo")); if (!dir) return json(res, 404, { error: "Unknown repo" });
        const [status, diff, log] = await Promise.all([git(dir, "status", "--porcelain=v1", "--untracked-files=all"), git(dir, "diff", "HEAD", "--stat=120"), git(dir, "log", "--oneline", "-8", "--decorate")]);
        const full = await git(dir, "diff", "HEAD");
        const untracked = status.out.split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
        let extra = "";
        for (const f of untracked.slice(0, 20)) { try { const fp = path.join(dir, f); if (fs.statSync(fp).size < 200_000) extra += `\n--- /dev/null\n+++ b/${f}\n` + fs.readFileSync(fp, "utf8").split("\n").map((l) => "+" + l).join("\n") + "\n"; } catch {} }
        const text = (full.out + extra);
        return json(res, 200, { status: status.out, stat: diff.out, log: log.out, diff: text.length > 300_000 ? text.slice(0, 300_000) + "\n… diff truncated" : text, info: await repoInfo(url.searchParams.get("repo")) });
      }
      if (p === "/api/git" && req.method === "POST") {
        const { repo, action, message } = await readBody(req); const dir = safeRepo(repo); if (!dir) return json(res, 404, { error: "Unknown repo" });
        if (runs.has(repo)) return json(res, 409, { error: "Wait for the agent to finish" });
        let r;
        if (action === "commit") { await git(dir, "add", "-A"); r = await git(dir, "commit", "-m", message?.trim() || "Changes by repo-agent"); }
        else if (action === "push") r = await git(dir, "push", "-u", "origin", "HEAD");
        else if (action === "pull") r = await git(dir, "pull", "--rebase");
        else if (action === "discard") { await git(dir, "reset", "--hard"); r = await git(dir, "clean", "-fd"); }
        else return json(res, 400, { error: "Unknown action" });
        return json(res, r.code === 0 ? 200 : 400, { ok: r.code === 0, out: (r.out + "\n" + r.err).trim(), info: await repoInfo(repo) });
      }
      return json(res, 404, { error: "Not found" });
    }

    // static
    let file = path.join(here, "public", p === "/" ? "index.html" : p);
    if (!file.startsWith(path.join(here, "public"))) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
    else res.end();
  }
}).listen(PORT, () => console.log(`repo-agent running on http://localhost:${PORT}  (workspace: ${WORKSPACE})`));
