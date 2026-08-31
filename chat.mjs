import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/snap/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/chromium",
          "/usr/lib/chromium-browser/chromium-browser",
          "/usr/lib/chromium/chromium",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
        ];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  if (process.platform !== "win32") {
    try {
      const which = execSync(
        "command -v google-chrome-stable google-chrome chromium-browser chromium 2>/dev/null | head -n 1",
        { encoding: "utf8" },
      ).trim();
      if (which) return which;
    } catch {}
  }
  return envPath || candidates[0];
}

const CHROME = findChrome();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const FALLBACK_MODEL = "gpt-5.4-mini";
const DEFAULT_MODEL = process.env.DUCK_MODEL || FALLBACK_MODEL;
const MODELS = [
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  "claude-haiku-4-5",
  "mistral-small-2603",
  "tinfoil/gpt-oss-120b",
  "tinfoil/gemma4-31b",
];
const PROFILE = join(dirname(fileURLToPath(import.meta.url)), ".chrome");
const HEADLESS = process.env.HEADLESS === "1";

function parseProxy(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!u.hostname) return null;
    const scheme = (u.protocol || "http:").replace(":", "") || "http";
    const port = u.port || (scheme === "https" ? "443" : scheme.startsWith("socks") ? "1080" : "80");
    const server = `${scheme}://${u.hostname}:${port}`;
    const auth = u.username
      ? {
          username: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password || ""),
        }
      : null;
    return { server, auth };
  } catch {
    return null;
  }
}

function loadProxyList() {
  const bits = [process.env.PROXY, process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.PROXY_LIST]
    .filter(Boolean)
    .flatMap((s) => String(s).split(/[\s,;]+/));
  const file = process.env.PROXY_FILE || join(dirname(fileURLToPath(import.meta.url)), "proxies.txt");
  if (existsSync(file)) {
    bits.push(
      ...readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  }
  const seen = new Set();
  const list = [];
  for (const raw of bits) {
    const p = parseProxy(raw);
    if (!p) continue;
    const key = `${p.server}|${p.auth?.username || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  return list;
}

const proxies = loadProxyList();
let proxyIndex = 0;

function currentProxy() {
  if (!proxies.length) return null;
  return proxies[proxyIndex % proxies.length];
}

function isLocalTor(p) {
  return !!(p && /socks5?/i.test(p.server) && /127\.0\.0\.1|localhost/.test(p.server));
}

function torNewnym() {
  const port = Number(process.env.TOR_CONTROL_PORT || 9051);
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    const t = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 2500);
    sock.on("connect", () => {
      sock.write('AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n');
    });
    sock.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
    sock.on("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

async function resetBrowser() {
  try {
    if (chrome) await chrome.close().catch(() => {});
  } catch {}
  page = null;
  chrome = null;
}

async function rotateProxy(reason) {
  if (proxies.length > 1) {
    proxyIndex = (proxyIndex + 1) % proxies.length;
    console.log("Rotated proxy ->", currentProxy().server, `(${reason})`);
  } else if (isLocalTor(currentProxy())) {
    const ok = await torNewnym();
    console.log(ok ? "Tor new circuit" : "Tor control port 9051 not open", `(${reason})`);
    await new Promise((r) => setTimeout(r, ok ? 3000 : 1000));
  } else {
    console.log("No extra proxy to rotate", `(${reason})`);
  }
  journeyId = crypto.randomUUID().replace(/-/g, "");
  pendingHash = null;
  await resetBrowser();
}

const JSA_SRCDOC =
  '<!DOCTYPE html>\n<html>\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\';">\n</head>\n<body></body>\n</html>';
mkdirSync(PROFILE, { recursive: true });

let page;
let chrome;
let askLock = Promise.resolve();
let pendingHash = null;
let journeyId = crypto.randomUUID().replace(/-/g, "");

function killStaleChrome() {
  try {
    if (process.platform === "win32") {
      const marker = PROFILE.replace(/'/g, "''");
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, { stdio: "ignore" });
    } else {
      execSync(`pkill -f ${JSON.stringify(PROFILE)} || true`, { stdio: "ignore" });
    }
  } catch {}
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) {
    try {
      rmSync(join(PROFILE, name), { force: true });
    } catch {}
  }
}

async function launchChrome() {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-breakpad",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--mute-audio",
    "--metrics-recording-only",
    "--renderer-process-limit=1",
    "--js-flags=--max-old-space-size=128",
    "--window-size=1280,800",
  ];
  if (process.platform !== "win32") {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  const proxy = currentProxy();
  if (proxy) args.push(`--proxy-server=${proxy.server}`);
  return puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    userDataDir: PROFILE,
    ignoreDefaultArgs: ["--enable-automation"],
    args,
  });
}

async function browser() {
  if (page) return page;
  killStaleChrome();
  for (let i = 0; i < 3; i++) {
    try {
      chrome = await launchChrome();
      break;
    } catch (err) {
      const busy = /already running/i.test(String(err.message || err));
      if (!busy || i === 2) throw err;
      killStaleChrome();
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  page = await chrome.newPage();
  const proxy = currentProxy();
  if (proxy?.auth) await page.authenticate(proxy.auth);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "media") return req.abort();
    const url = req.url();
    if (/\.(png|jpe?g|gif|webp|mp4|mp3)(\?|$)/i.test(url)) return req.abort();
    return req.continue();
  });
  await page.goto("https://duck.ai/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => window.__DDG_BE_VERSION__, { timeout: 20000 });
  try {
    await page.waitForSelector("#jsa", { timeout: 15000 });
  } catch {
    await page.evaluate((srcdoc) => {
      if (document.getElementById("jsa")) return;
      const iframe = document.createElement("iframe");
      iframe.id = "jsa";
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
      iframe.srcdoc = srcdoc;
      iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
      document.body.appendChild(iframe);
    }, JSA_SRCDOC);
    await page.waitForFunction(() => {
      const el = document.getElementById("jsa");
      return !!(el && (el.contentDocument || el.contentWindow?.document)?.body);
    }, { timeout: 10000 });
  }
  return page;
}

function parseReply(sse) {
  let text = "";
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (data.startsWith("{")) {
      try {
        const j = JSON.parse(data);
        if (j.message) text += j.message;
      } catch {}
    }
  }
  return text;
}

function messageText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  }
  return "";
}

function promptFromMessages(messages) {
  const list = messages || [];
  const lastUser = [...list].reverse().find((m) => m.role === "user");
  const last = messageText(lastUser).trim();
  if (last) return last;
  return list.map(messageText).filter(Boolean).join("\n");
}

async function ask(prompt, model = DEFAULT_MODEL) {
  const run = askLock.then(() => askNow(prompt, model));
  askLock = run.catch(() => {});
  return run;
}

function formatChallengeError(body) {
  try {
    const j = JSON.parse(body);
    if (j?.type === "ERR_CHALLENGE") {
      return "Duck.ai blocked this request (418 ERR_CHALLENGE). Retrying with a fresh hash.";
    }
  } catch {}
  return body;
}

async function askNow(prompt, model = DEFAULT_MODEL) {
  let lastBody = "";
  const maxAttempts = Math.max(3, Math.min(proxies.length + 1, 6));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const p = await browser();
    const challengeFromStatus = pendingHash;
    pendingHash = null;
    const result = await p.evaluate(
      async ({ model, prompt, journeyId, challengeFromStatus, jsaSrcdoc }) => {
        function stackOf(err, max = 5) {
          if (!err?.stack) return "no-stack";
          const msg = err.message || "Unknown";
          const lines = err.stack.split("\n");
          const start = lines[0].includes(msg) ? 1 : 0;
          const chunk = lines.slice(start, start + max).map((l) => l.trim()).join("\n");
          const extra = lines.length - start - max;
          return extra > 0 ? `${chunk}\n... (${extra} more frames omitted)` : chunk;
        }

        async function sha256b64(value) {
          const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
          return btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ""));
        }

        async function ensureJsa() {
          let iframe = document.getElementById("jsa");
          if (iframe?.contentDocument?.body || iframe?.contentWindow?.document?.body) return iframe;
          if (!iframe) {
            iframe = document.createElement("iframe");
            iframe.id = "jsa";
            iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
            iframe.srcdoc = jsaSrcdoc;
            iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
            document.body.appendChild(iframe);
          }
          await new Promise((resolve, reject) => {
            if (iframe.contentDocument?.body) return resolve();
            iframe.addEventListener("load", () => resolve(), { once: true });
            setTimeout(() => reject(new Error("jsa iframe did not load")), 8000);
          });
          return iframe;
        }

        async function runInJsa(jsSource) {
          const iframe = await ensureJsa();
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          window.__jsaCallbacks ||= {};
          const id = Date.now() + Math.floor(Math.random() * 1000);
          return new Promise((resolve, reject) => {
            const script = doc.createElement("script");
            window.__jsaCallbacks[id] = (err, value) => {
              delete window.__jsaCallbacks[id];
              script.remove();
              if (err) reject(err);
              else resolve(value);
            };
            script.textContent =
              "try { window.parent.__jsaCallbacks[" +
              id +
              "](null, " +
              jsSource +
              "); } catch (e) { window.parent.__jsaCallbacks[" +
              id +
              "](e, null); }";
            doc.body.onerror = (e) => {
              reject(e);
              return true;
            };
            doc.body.appendChild(script);
          });
        }

        async function solveHash(challenge) {
          if (!challenge) throw new Error("missing x-vqd-hash-1 challenge");
          const started = Date.now();
          const raw = await runInJsa(atob(challenge));
          if (!raw || typeof raw !== "object" || !Array.isArray(raw.client_hashes)) {
            throw new Error("challenge did not return client_hashes");
          }
          await new Promise((r) => setTimeout(r, 0));
          const client_hashes = await Promise.all(raw.client_hashes.map(sha256b64));
          return btoa(
            JSON.stringify({
              ...raw,
              client_hashes,
              meta: {
                ...(raw.meta || {}),
                origin: (window.top || window).location.origin,
                stack: stackOf(new Error()),
                duration: String(Date.now() - started),
              },
            }),
          );
        }

        function feSignals() {
          const start = Date.now() - 3500 - Math.floor(Math.random() * 1500);
          let t = 80 + Math.floor(Math.random() * 100);
          const events = [{ name: "startNewChat", delta: t }];
          t += 100 + Math.floor(Math.random() * 80);
          events.push({ name: "recentChatsListImpression", delta: t });
          const n = 6 + Math.floor(Math.random() * 10);
          for (let i = 0; i < n; i++) {
            t += 40 + Math.floor(Math.random() * 140);
            events.push({ name: "user_input", delta: t });
          }
          t += 120 + Math.floor(Math.random() * 200);
          events.push({ name: "user_submit", delta: t });
          return btoa(JSON.stringify({ start, events, end: t + 40 }));
        }

        let challenge = challengeFromStatus;
        if (!challenge) {
          const st = await fetch("/duckchat/v1/status", {
            cache: "no-store",
            credentials: "include",
            headers: { "x-vqd-accept": "1" },
          });
          if (!st.ok) {
            return { status: st.status, body: await st.text(), nextHash: null };
          }
          challenge = st.headers.get("x-vqd-hash-1") || st.headers.get("X-Vqd-Hash-1");
        }
        const hash = await solveHash(challenge);
        const res = await fetch("/duckchat/v1/chat", {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
            "x-fe-version": `${window.__DDG_BE_VERSION__ || "dev"}-${window.__DDG_FE_CHAT_HASH__ || "hash"}`,
            "x-fe-signals": feSignals(),
            "x-vqd-hash-1": hash,
            "x-ddg-journey-id": journeyId,
          },
          body: JSON.stringify({
            model,
            metadata: {
              toolChoice: {
                NewsSearch: false,
                VideosSearch: false,
                LocalSearch: false,
                WeatherForecast: false,
              },
            },
            messages: [{ role: "user", content: prompt }],
            canUseTools: true,
            reasoningEffort: "none",
            canUseApproxLocation: null,
          }),
        });
        return {
          status: res.status,
          body: await res.text(),
          nextHash: res.headers.get("x-vqd-hash-1") || res.headers.get("X-Vqd-Hash-1"),
        };
      },
      { model, prompt, journeyId, challengeFromStatus, jsaSrcdoc: JSA_SRCDOC },
    );

    if (result.nextHash) pendingHash = result.nextHash;
    lastBody = result.body || "";
    if (result.status === 200) {
      const text = parseReply(result.body);
      if (!text) throw new Error(result.body || "empty reply");
      return text;
    }

    const isChallenge = result.status === 418 || /ERR_CHALLENGE|ERR_INVALID_CHALLENGE/.test(lastBody);
    const isInputLimit = result.status === 429 || /ERR_INPUT_LIMIT/.test(lastBody);
    pendingHash = null;
    if (isInputLimit) {
      journeyId = crypto.randomUUID().replace(/-/g, "");
      pendingHash = null;
      if (model !== FALLBACK_MODEL) {
        console.log(`${model} hit ERR_INPUT_LIMIT, falling back to ${FALLBACK_MODEL}`);
        return askNow(prompt, FALLBACK_MODEL);
      }
      if (attempt < maxAttempts - 1 && (proxies.length || isLocalTor(currentProxy()))) {
        await rotateProxy("ERR_INPUT_LIMIT");
        continue;
      }
      if (attempt === 0) {
        console.log("mini hit ERR_INPUT_LIMIT, resetting Chrome session");
        await resetBrowser();
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(
        "Duck.ai rate/input limit (ERR_INPUT_LIMIT). This IP/session is capped. Rotate via PROXY_LIST or Tor, or wait. Luna is often blocked on datacenter/Tor exits.",
      );
    }
    if (!isChallenge || attempt === 2) {
      throw new Error(lastBody || `HTTP ${result.status}`);
    }
    console.log(formatChallengeError(lastBody));
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw new Error(lastBody || "challenge failed");
}

function lanIPs() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }
  }
  return ips;
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function serve() {
  http
    .createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        });
        return res.end();
      }

      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        return json(res, 200, { ok: true, models: MODELS });
      }

      if (req.method === "GET" && req.url === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: MODELS.map((id) => ({ id, object: "model", owned_by: "duck.ai" })),
        });
      }

      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        return json(res, 404, { error: { message: "not found" } });
      }

      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        const body = JSON.parse(raw || "{}");
        const model = MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
        const prompt = body.prompt || promptFromMessages(body.messages);
        if (!prompt) return json(res, 400, { error: { message: "prompt or messages required" } });
        const text = await ask(prompt, model);
        return json(res, 200, {
          id: "chatcmpl-duck",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
        });
      } catch (err) {
        return json(res, 500, { error: { message: err.message } });
      }
    })
    .listen(PORT, HOST, async () => {
      console.log("Duck.ai API running");
      console.log("Chrome:", CHROME, existsSync(CHROME) ? "(found)" : "(MISSING)");
      const proxy = currentProxy();
      console.log("Proxy:", proxy ? `${proxy.server} (${proxies.length} in pool)` : "none");
      console.log(`  this PC:  http://127.0.0.1:${PORT}/v1`);
      for (const ip of lanIPs()) {
        console.log(`  other PC: http://${ip}:${PORT}/v1`);
      }
      console.log("Allow Node.js in Windows Firewall if other PCs cannot connect.");
      console.log("Warming one Chrome (reused for every request)...");
      try {
        await browser();
        console.log("Ready. Point your router at this URL.");
      } catch (err) {
        console.log("Chrome failed:", err.message);
      }
    });
}

async function chatLoop() {
  let model = DEFAULT_MODEL;
  console.log("Chrome will open. Type here, not in Chrome.");
  console.log("Models:", MODELS.join(", "));
  console.log("Commands: /model NAME   /quit");
  console.log(`Using ${model}\n`);
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question(`${model}> `)).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line.startsWith("/model ")) {
        const next = line.slice(7).trim();
        if (!MODELS.includes(next)) {
          console.log("Unknown model. Pick one of:", MODELS.join(", "));
          continue;
        }
        model = next;
        console.log("Switched to", model);
        continue;
      }
      try {
        const text = await ask(line, model);
        console.log("\n" + text + "\n");
      } catch (err) {
        console.log("Error:", err.message);
      }
    }
  } finally {
    rl.close();
    if (chrome) await chrome.close().catch(() => {});
  }
}

process.on("SIGINT", async () => {
  if (chrome) await chrome.close().catch(() => {});
  process.exit(0);
});

const argv = process.argv.slice(2);
if (argv[0] === "--serve") serve();
else if (argv.length === 0) await chatLoop();
else {
  let model = DEFAULT_MODEL;
  const parts = [...argv];
  const i = parts.indexOf("--model");
  if (i !== -1) {
    model = parts[i + 1];
    parts.splice(i, 2);
  }
  const prompt = parts.join(" ").trim();
  console.log(`Asking ${model}...`);
  try {
    console.log("\n" + (await ask(prompt, model)));
  } finally {
    if (chrome) await chrome.close().catch(() => {});
  }
}
