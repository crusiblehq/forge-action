// src/api.js
var Unreadable = class extends Error {
};
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client({ token, fetchImpl = globalThis.fetch, base = "https://api.github.com", budget = 250, wait = sleep, retries = 3 }) {
  let calls = 0;
  async function request(method, path, { body, query } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      if (++calls > budget) throw new Unreadable(`call budget ${budget} exhausted`);
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "crusiblehq-forge-action",
            ...body === void 0 ? {} : { "content-type": "application/json" }
          },
          body: body === void 0 ? void 0 : JSON.stringify(body)
        });
      } catch (e) {
        if (attempt < retries) {
          await wait(500 * 2 ** attempt);
          continue;
        }
        throw new Unreadable(`network: ${e.message}`);
      }
      const secondary = res.status === 429 || res.status === 403 && res.headers.get("retry-after") !== null;
      if ((res.status >= 500 || secondary) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await wait(ra > 0 ? ra * 1e3 : 500 * 2 ** attempt);
        continue;
      }
      if (res.status >= 500 || secondary) throw new Unreadable(`${method} ${path}: HTTP ${res.status} after ${attempt + 1} tries`);
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data, headers: res.headers };
    }
  }
  async function read(path, opts) {
    const r = await request("GET", path, opts);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Unreadable(`GET ${path}: HTTP ${r.status} ${r.data?.message ?? ""}`.trim());
    return r.data;
  }
  return { request, read, calls: () => calls };
}

// src/io.js
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
function getInput(name, env = process.env) {
  const v = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return (v ?? "").trim();
}
function mask(value, out = (s) => process.stdout.write(s)) {
  if (value) out(`::add-mask::${value}
`);
}
function setOutput(name, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!file) return;
  const d = `ghadelim_${randomUUID()}`;
  appendFileSync(file, `${name}<<${d}
${text}
${d}
`);
}
function scrub(text, token) {
  return token ? String(text).split(token).join("***") : String(text);
}
function list(raw) {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

// src/ops-write.js
var GATES_MAX = 4096;
var STATES = ["pending", "success", "failure", "error"];
async function status(api, i, { sleep: sleep2 }) {
  if (!i.sha || !i.context) throw new Unreadable("status needs sha and context");
  if (!i.state) {
    const waitMs = Number(i["wait-seconds"] || 0) * 1e3;
    const step = waitMs > 0 ? waitMs / 3 : 0;
    for (let waited = 0; ; waited += step) {
      const d = await api.read(`/repos/${i.repository}/commits/${i.sha}/status`, { query: { per_page: 100 } });
      const hit = d?.statuses?.find((s) => s.context === i.context);
      if (hit) return { verdict: "ok", state: hit.state, description: hit.description ?? "", ok: true };
      if (waited + step > waitMs || step === 0) return { verdict: "absent", ok: false };
      await sleep2(step);
    }
  }
  if (!STATES.includes(i.state)) throw new Unreadable(`bad state: ${i.state}`);
  const body = { state: i.state, context: i.context, description: (i.description ?? "").slice(0, 140) };
  if (i["target-url"]) body.target_url = i["target-url"];
  const r = await api.request("POST", `/repos/${i.repository}/statuses/${i.sha}`, { body });
  if (r.status !== 201) throw new Unreadable(`status POST: HTTP ${r.status} ${r.data?.message ?? ""}`);
  return { verdict: "ok", state: i.state, ok: true };
}
async function label(api, i) {
  if (!i.pr) throw new Unreadable("label needs pr");
  const add = list(i.labels ?? "");
  const remove = list(i["remove-labels"] ?? "");
  if (!add.length && !remove.length) throw new Unreadable("label needs labels or remove-labels");
  if (add.length) {
    const r = await api.request("POST", `/repos/${i.repository}/issues/${i.pr}/labels`, { body: { labels: add } });
    if (r.status >= 300) throw new Unreadable(`label add: HTTP ${r.status} ${r.data?.message ?? ""}`);
  }
  for (const l of remove) {
    const r = await api.request("DELETE", `/repos/${i.repository}/issues/${i.pr}/labels/${encodeURIComponent(l)}`);
    if (r.status >= 300 && r.status !== 404) throw new Unreadable(`label remove ${l}: HTTP ${r.status}`);
  }
  return { verdict: "ok", added: add, removed: remove, ok: true };
}
function unexpected(msg) {
  const m = /Unexpected inputs provided: \[([^\]]*)\]/.exec(msg ?? "");
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}
async function dispatch(api, i, { log }) {
  if (!i.workflow || !i.ref) throw new Unreadable("dispatch needs workflow and ref");
  const inputs = i.inputs ? JSON.parse(i.inputs) : {};
  if (i.pr) inputs.pr = String(i.pr);
  if (i.gates) {
    if (Buffer.byteLength(i.gates) > GATES_MAX) throw new Unreadable(`gates above ${GATES_MAX} bytes refused`);
    inputs.gates = i.gates;
  }
  const dropped = [];
  for (; ; ) {
    const r = await api.request("POST", `/repos/${i.repository}/actions/workflows/${encodeURIComponent(i.workflow)}/dispatches`, { body: { ref: i.ref, inputs } });
    if (r.status === 204) return { verdict: "ok", dropped, ok: true };
    const names = r.status === 422 ? unexpected(r.data?.message).filter((n) => n in inputs) : [];
    if (names.length && i["retry-unknown-inputs"] !== "false" && !dropped.length) {
      for (const n of names) delete inputs[n];
      dropped.push(...names);
      log(`::warning::dispatch retried once without unknown inputs: ${names.join(",")}`);
      continue;
    }
    throw new Unreadable(`dispatch: HTTP ${r.status} ${r.data?.message ?? ""}`);
  }
}

// src/safe.js
import { resolve, sep, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
var FILE_CAP = 1024 * 1024;
function checkRelPath(p) {
  const parts = p.split("/");
  if (!p || p.startsWith("/") || p.includes("\\") || parts.some((s) => s === ".." || s === "." || s === "" || s === ".git")) {
    throw new Unreadable(`path rejected: ${p}`);
  }
  return p;
}
function writeUnder(dest, rel, bytes) {
  checkRelPath(rel);
  const root = resolve(dest);
  const target = resolve(root, rel);
  if (!target.startsWith(root + sep)) throw new Unreadable(`path escapes dest: ${rel}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

// src/ops-read.js
async function files(api, i) {
  const paths = list(i.paths ?? "");
  if (!paths.length || !i.sha && !i.ref) throw new Unreadable("files needs paths and sha or ref");
  if (!i.dest) throw new Unreadable("files needs dest");
  const out = [];
  for (const p of paths) {
    checkRelPath(p);
    const d = await api.read(`/repos/${i.repository}/contents/${p.split("/").map(encodeURIComponent).join("/")}`, { query: { ref: i.sha || i.ref } });
    if (d === null) {
      out.push({ path: p, found: false });
      continue;
    }
    if (Array.isArray(d) || d.type !== "file") throw new Unreadable(`not a file: ${p}`);
    if (d.size > FILE_CAP) throw new Unreadable(`${p}: ${d.size} bytes above the ${FILE_CAP} cap`);
    writeUnder(i.dest, p, Buffer.from(d.content ?? "", "base64"));
    out.push({ path: p, found: true, size: d.size, sha: d.sha });
  }
  const ok = out.every((f) => f.found);
  return { verdict: ok ? "ok" : "absent", files: out, ok };
}
async function ref(api, i) {
  if (!i.ref) throw new Unreadable("ref needs ref");
  const name = /^(heads|tags)\//.test(i.ref) ? i.ref : `heads/${i.ref}`;
  const d = await api.read(`/repos/${i.repository}/git/ref/${name.split("/").map(encodeURIComponent).join("/")}`);
  if (!d) return { verdict: "absent", ok: false };
  return { verdict: "ok", sha: d.object.sha, type: d.object.type, ok: true };
}

// src/main.js
var OPS = { status, label, dispatch, files, ref };
var NAMES = ["op", "token", "repository", "pr", "sha", "ref", "paths", "dest", "state", "context", "description", "target-url", "labels", "remove-labels", "workflow", "inputs", "gates", "wait-seconds", "retry-unknown-inputs"];
async function run(env = process.env, deps = {}) {
  const i = Object.fromEntries(NAMES.map((n) => [n, getInput(n, env)]));
  const out = deps.out ?? ((s) => process.stdout.write(s));
  mask(i.token, out);
  try {
    if (!i.token) throw new Unreadable("token input is required");
    i.repository ||= env.GITHUB_REPOSITORY ?? "";
    const op = OPS[i.op];
    if (!op) throw new Unreadable(`unknown op: ${i.op}`);
    const api = deps.api ?? client({ token: i.token, ...deps.client ?? {} });
    const res = await op(api, i, { sleep: deps.sleep ?? ((ms) => new Promise((x) => setTimeout(x, ms))), log: out });
    setOutput("verdict", res, env);
    setOutput("ok", String(!!res.ok), env);
    return 0;
  } catch (e) {
    const msg = scrub(e.message, i.token);
    out(`::error::${i.op || "forge-action"}: ${msg}
`);
    setOutput("verdict", { verdict: "unreadable", why: msg.slice(0, 200) }, env);
    setOutput("ok", "false", env);
    return 1;
  }
}
if (import.meta.url === `file://${process.argv[1]}` || process.env.GITHUB_ACTION) {
  run().then((c) => {
    process.exitCode = c;
  });
}
export {
  OPS,
  run
};
