import express from "express";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";

const app = express();
const port = Number(process.env.PORT || 3000);
const extractorToken = process.env.STREAM_EXTRACTOR_TOKEN || "";
const launchTimeoutMs = Number(process.env.EXTRACTOR_LAUNCH_TIMEOUT_MS || 30000);
const extractTimeoutMs = Number(process.env.EXTRACTOR_TIMEOUT_MS || 18000);
const attemptTimeoutMs = Number(process.env.EXTRACTOR_ATTEMPT_TIMEOUT_MS || 7000);
const requestTimeoutMs = Number(process.env.EXTRACTOR_REQUEST_TIMEOUT_MS || 25000);
const maxContexts = Number(process.env.EXTRACTOR_MAX_CONTEXTS || 1);
const keepAliveUrl = process.env.KEEPALIVE_URL || "";
const keepAliveIntervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS || 0);
const extractorProxyUrl = process.env.EXTRACTOR_PROXY_URL || process.env.OUTBOUND_PROXY_URL || "";

app.use(express.json({ limit: "32kb" }));
app.use((request, response, next) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type,range");
  response.setHeader("access-control-expose-headers", "content-length,content-range,content-type,accept-ranges");
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

let browserPromise = null;
let activeContexts = 0;
let totalRequests = 0;
let lastResult = null;
const mediaTokenCache = new Map();
const mediaTokenTtlMs = Number(process.env.MEDIA_TOKEN_TTL_MS || 20 * 60 * 1000);

function assertAuthorized(request, response) {
  if (!extractorToken) return true;
  const expected = `Bearer ${extractorToken}`;
  if (request.headers.authorization === expected) return true;
  response.status(401).json({ success: false, error: "Unauthorized" });
  return false;
}

function normalizeHttpUrl(value, baseUrl) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value, baseUrl || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return String(url);
  } catch {
    return "";
  }
}

function pushLimited(items, item, limit = 80) {
  if (items.length < limit) {
    items.push(item);
    return;
  }
  if (items.length === limit) items.push("...");
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function playwrightProxyFromUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return undefined;

  try {
    const url = new URL(normalized);
    const proxy = {
      server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`,
    };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch {
    return undefined;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const proxy = playwrightProxyFromUrl(extractorProxyUrl);
    browserPromise = chromium.launch({
      headless: true,
      timeout: launchTimeoutMs,
      proxy,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-setuid-sandbox",
        "--no-sandbox",
      ],
    });
  }
  return browserPromise;
}

function isLikelyPrimaryPlaylist(url) {
  try {
    const parsed = new URL(url);
    const mediaPath = `${parsed.hostname}${parsed.pathname}`;
    return /\.m3u8$/i.test(parsed.pathname) && !/(^|[./_-])(ad|ads|vast|tracking|analytics)([./_-]|$)/i.test(mediaPath);
  } catch {
    const mediaPath = String(url).split(/[?#]/)[0];
    return /\.m3u8$/i.test(mediaPath) && !/(^|[./_-])(ad|ads|vast|tracking|analytics)([./_-]|$)/i.test(mediaPath);
  }
}

function isInterestingNetworkUrl(url) {
  return /m3u8|mp4|streamfree|hhkungfu|api\/streamfree|cdn-cgi\/rum/i.test(url);
}

function withTimeout(promise, timeoutMs, fallback = undefined) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
}

function publicBaseUrl(request) {
  const configured = normalizeHttpUrl(process.env.PUBLIC_BASE_URL);
  if (configured) return configured.replace(/\/+$/, "");
  const proto = request.headers["x-forwarded-proto"] || request.protocol || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}`;
}

function sanitizeMediaHeaders(headers = {}) {
  const allowed = ["accept", "accept-language", "origin", "referer", "user-agent"];
  const next = {};
  for (const key of allowed) {
    if (headers[key]) next[key] = headers[key];
  }
  if (!next["user-agent"]) next["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  return next;
}

function createMediaToken(url, headers) {
  const token = randomUUID().replace(/-/g, "");
  mediaTokenCache.set(token, {
    url,
    headers: sanitizeMediaHeaders(headers),
    expiresAt: Date.now() + mediaTokenTtlMs,
  });
  return token;
}

function cleanupMediaTokens() {
  const now = Date.now();
  for (const [token, entry] of mediaTokenCache.entries()) {
    if (!entry || entry.expiresAt <= now) mediaTokenCache.delete(token);
  }
}

function mediaProxyUrl(request, url, headers) {
  cleanupMediaTokens();
  const token = createMediaToken(url, headers);
  return `${publicBaseUrl(request)}/api/media/${token}`;
}

function rewritePlaylistWithMediaTokens(playlist, baseUrl, headers, request) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI=(["'])([^"']+)\1/gi, (_match, quote, uri) => {
          return `URI=${quote}${mediaProxyUrl(request, String(new URL(uri, baseUrl)), headers)}${quote}`;
        });
      }

      return mediaProxyUrl(request, String(new URL(trimmed, baseUrl)), headers);
    })
    .join("\n");
}

async function fetchMediaEntry(entry, request) {
  const headers = { ...entry.headers };
  if (request.headers.range) headers.range = request.headers.range;
  return fetch(entry.url, { headers, signal: AbortSignal.timeout(30000) });
}

async function fetchAndRewritePlaylist(url, headers, request) {
  const result = await fetch(url, {
    headers: sanitizeMediaHeaders(headers),
    signal: AbortSignal.timeout(30000),
  });
  if (!result.ok) {
    const error = new Error(`Streamfree playlist returned ${result.status}`);
    error.statusCode = 502;
    throw error;
  }

  const playlist = await result.text();
  if (!playlist.trimStart().startsWith("#EXTM3U")) {
    const error = new Error("Streamfree response is not an HLS playlist");
    error.statusCode = 502;
    throw error;
  }

  return rewritePlaylistWithMediaTokens(playlist, new URL(url), headers, request);
}

async function extractStreamWithRetries(input, attempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await extractStream(input);
    } catch (error) {
      lastError = error;
      const retryable =
        Number(error?.statusCode || 500) === 404 &&
        /yield m3u8|timeout/i.test(error instanceof Error ? error.message : String(error));
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  throw lastError;
}

async function triggerPlayback(page) {
  const frames = page.frames().filter((frame) => /streamfree|api\/streamfree/i.test(frame.url()));
  const targets = frames.length ? frames : [page.mainFrame()];

  for (const frame of targets) {
    const element = await withTimeout(frame.frameElement(), 1000, null).catch(() => null);
    const box = element ? await withTimeout(element.boundingBox(), 1000, null).catch(() => null) : null;
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    }
  }

  await page.mouse.click(640, 360).catch(() => {});
  await page.keyboard.press("Space").catch(() => {});
}

async function snapshotFrames(page) {
  const frames = page.frames().slice(0, 8);
  const snapshots = [];
  for (const frame of frames) {
    snapshots.push(
      await frame
        .evaluate(() => {
          const player = document.querySelector("#hrm-player");
          const video = document.querySelector("video");
          return {
            url: location.href,
            title: document.title,
            text: document.body?.innerText?.slice(0, 300) || "",
            playerState: player?.getAttribute("data-state") || null,
            hasVideo: Boolean(video),
            videoReadyState: video?.readyState ?? null,
          };
        })
        .catch((error) => ({ url: frame.url(), error: error instanceof Error ? error.message : String(error) })),
    );
  }
  return snapshots;
}

function timeoutError(timeoutMs) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      const error = new Error(`Extractor request timed out after ${timeoutMs}ms`);
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);
  });
}

async function extractStream({ iframeUrl, referer }) {
  if (activeContexts >= maxContexts) {
    const error = new Error("Extractor is busy");
    error.statusCode = 429;
    throw error;
  }

  activeContexts += 1;
  let context = null;
  const debug = {
    entries: [],
    network: [],
    console: [],
    failed: [],
    snapshots: [],
  };

  try {
    const browser = await getBrowser();
    const cleanReferer = normalizeHttpUrl(referer, "https://hhkungfu.ee/");
    const cleanIframeUrl = normalizeHttpUrl(iframeUrl, cleanReferer || "https://hhkungfu.ee/");
    if (!cleanIframeUrl) {
      const error = new Error("Invalid iframeUrl");
      error.statusCode = 400;
      throw error;
    }

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    await context.addInitScript(() => {
      try {
        var makeNative = function(fn, name) {
          try { Object.defineProperty(fn, "toString", { value: function() { return "function " + (name || fn.name) + "() { [native code] }"; }, configurable: true }); } catch(e) {}
          return fn;
        };

        // Check 0: iframe detection — mock parent/top to look like hhkungfu.ee embedding
        try {
          if (window.self === window.top) {
            var mockParent = new Proxy(window, {
              get: function(target, prop) {
                if (prop === "location") return { href: "https://hhkungfu.ee/", origin: "https://hhkungfu.ee", protocol: "https:", host: "hhkungfu.ee", hostname: "hhkungfu.ee", pathname: "/", search: "", hash: "" };
                if (prop === "self" || prop === "window" || prop === "parent" || prop === "top") return mockParent;
                if (prop === "document") {
                  throw new DOMException("Blocked a frame with origin \"https://streamfree.vip\" from accessing a cross-origin frame.");
                }
                return undefined;
              }
            });
            try { Object.defineProperty(window, "parent", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
            try { Object.defineProperty(window, "top", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
            try { Object.defineProperty(Window.prototype, "parent", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
            try { Object.defineProperty(Window.prototype, "top", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
          }
          var dummyFrame = document.createElement("iframe");
          try { Object.defineProperty(window, "frameElement", { get: function() { return dummyFrame; }, configurable: true }); } catch(e) {}
          try { Object.defineProperty(Window.prototype, "frameElement", { get: function() { return dummyFrame; }, configurable: true }); } catch(e) {}

          // Mock document.referrer
          try { Object.defineProperty(document, "referrer", { get: function() { return "https://hhkungfu.ee/"; }, configurable: true }); } catch(e) {}
          // Mock location.ancestorOrigins
          try { Object.defineProperty(window.location, "ancestorOrigins", { get: function() { return ["https://hhkungfu.ee"]; }, configurable: true }); } catch(e) {}
          try { Object.defineProperty(Location.prototype, "ancestorOrigins", { get: function() { return ["https://hhkungfu.ee"]; }, configurable: true }); } catch(e) {}
        } catch(e) {}

        // Check 1+6: chrome object with full runtime mock
        try {
          window.chrome = {
            app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" }, getDetails: function() {}, getIsInstalled: function() {}, install: function() {} },
            runtime: { OnInstalledReason: { INSTALL: "install", UPDATE: "update", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE_AVAILABLE: "update_available" }, OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" }, PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" }, PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" }, PlatformOS: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" }, RequestUpdateCheckStatus: { NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available", THROTTLED: "throttled" } }
          };
        } catch(e) {}

        // Check 2: Notification API
        try {
          if (typeof window.Notification === "undefined") {
            window.Notification = makeNative(function Notification() {}, "Notification");
            window.Notification.permission = "default";
            window.Notification.requestPermission = makeNative(function() { return Promise.resolve("default"); }, "requestPermission");
          }
        } catch(e) {}

        // Check 3: navigator.plugins — mock with PDF viewer plugins
        try {
          var mockPlugins = { 0: { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 }, 1: { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "", length: 1 }, 2: { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "", length: 1 }, length: 3, item: function(i) { return this[i] || null; }, namedItem: function(n) { for (var j = 0; j < 3; j++) if (this[j] && this[j].name === n) return this[j]; return null; }, refresh: makeNative(function() {}, "refresh") };
          Object.defineProperty(navigator, "plugins", { get: function() { return mockPlugins; }, configurable: true });
        } catch(e) {}

        // Check 5: navigator.webdriver
        try { Object.defineProperty(navigator, "webdriver", { get: function() { return false; }, configurable: true }); } catch(e) {}

        // Check 6b: navigator.hardwareConcurrency + deviceMemory
        try { Object.defineProperty(navigator, "hardwareConcurrency", { get: function() { return 8; }, configurable: true }); } catch(e) {}
        try { Object.defineProperty(navigator, "deviceMemory", { get: function() { return 8; }, configurable: true }); } catch(e) {}

        // Check 7: outerWidth/Height match inner
        try {
          var gw = function() { return window.innerWidth; }, gh = function() { return window.innerHeight; };
          Object.defineProperty(window, "outerWidth", { get: gw, configurable: true });
          Object.defineProperty(window, "outerHeight", { get: gh, configurable: true });
          Object.defineProperty(Window.prototype, "outerWidth", { get: gw, configurable: true });
          Object.defineProperty(Window.prototype, "outerHeight", { get: gh, configurable: true });
        } catch(e) {}

        // Check 10: screen.colorDepth + pixelDepth
        try { Object.defineProperty(screen, "colorDepth", { get: function() { return 24; }, configurable: true }); } catch(e) {}
        try { Object.defineProperty(screen, "pixelDepth", { get: function() { return 24; }, configurable: true }); } catch(e) {}

        // Check 11: screen dimensions
        try { Object.defineProperty(screen, "width", { get: function() { return 1920; }, configurable: true }); } catch(e) {}
        try { Object.defineProperty(screen, "height", { get: function() { return 1080; }, configurable: true }); } catch(e) {}
        try { Object.defineProperty(screen, "availWidth", { get: function() { return 1920; }, configurable: true }); } catch(e) {}
        try { Object.defineProperty(screen, "availHeight", { get: function() { return 1040; }, configurable: true }); } catch(e) {}

        // Check 12: document.hasFocus() always true
        try { document.hasFocus = makeNative(function() { return true; }, "hasFocus"); } catch(e) {}

        // Check 13: MediaSource exists
        try {
          if (typeof window.MediaSource === "undefined") {
            window.MediaSource = makeNative(function MediaSource() {}, "MediaSource");
            window.MediaSource.isTypeSupported = makeNative(function(t) { return /video\/mp4|video\/webm|audio/i.test(t || ""); }, "isTypeSupported");
          }
        } catch(e) {}

        // Console stub — neutralize devtools detector
        try {
          var noop = function() {};
          var mc = {};
          ["log", "table", "clear", "dir", "group", "groupCollapsed", "groupEnd", "trace", "warn", "info", "debug", "error"].forEach(function(p) { mc[p] = makeNative(noop, p); });
          window.console = mc;
        } catch(e) {}

        // Timing cap — defeat performance.now()/Date.now() delta checks
        try { var rn = window.performance.now.bind(window.performance); var lt = rn(); window.performance.now = function() { var c = rn(); if (c - lt > 100) lt += 1; else lt = c; return lt; }; } catch(e) {}
        try { var rdn = Date.now; var ld = rdn(); Date.now = function() { var c = rdn(); if (c - ld > 100) ld += 1; else ld = c; return ld; }; } catch(e) {}

        // Debugger neutralization via Proxy on Function constructor + eval
        try {
          var nf = window.Function;
          var cd = function(v) { return typeof v === "string" ? v.replace(/\bdebugger\b/g, "void 0") : v; };
          window.Function = new Proxy(nf, {
            construct: function(target, args) {
              if (args.length > 0) args[args.length - 1] = cd(args[args.length - 1]);
              return Reflect.construct(target, args);
            },
            apply: function(target, thisArg, args) {
              if (args.length > 0) args[args.length - 1] = cd(args[args.length - 1]);
              return Reflect.apply(target, thisArg, args);
            }
          });
          var re = window.eval;
          window.eval = new Proxy(re, {
            apply: function(target, thisArg, args) {
              if (args.length > 0 && typeof args[0] === "string") args[0] = cd(args[0]);
              return Reflect.apply(target, thisArg, args);
            }
          });
        } catch(e) {}
      } catch(globalErr) {}
    });

    const page = await context.newPage();
    let finalM3u8 = "";
    let finalM3u8Headers = {};

    const capture = (url, headers = {}) => {
      if (!isLikelyPrimaryPlaylist(url)) return;
      if (!finalM3u8 || /(?:master|index|playlist)/i.test(url)) {
        finalM3u8 = url;
        finalM3u8Headers = sanitizeMediaHeaders(headers);
      }
    };

    page.on("request", (request) => {
      capture(request.url(), request.headers());
      if (isInterestingNetworkUrl(request.url())) {
        pushLimited(debug.network, `REQ ${request.method()} ${request.resourceType()} ${request.url()}`);
      }
    });
    page.on("response", (response) => {
      if (isInterestingNetworkUrl(response.url())) {
        pushLimited(debug.network, `RES ${response.status()} ${response.url()}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (isInterestingNetworkUrl(request.url())) {
        pushLimited(debug.failed, `FAIL ${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`);
      }
    });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        pushLimited(debug.console, `[${message.type()}] ${message.text().slice(0, 240)}`, 30);
      }
    });
    page.on("pageerror", (error) => {
      pushLimited(debug.console, `[pageerror] ${error.message.slice(0, 240)}`, 30);
    });

    await page
      .route("**/cdn-cgi/rum*", (route) => route.fulfill({ status: 204, contentType: "text/plain", body: "" }))
      .catch(() => {});
    await page
      .route("**/*", async (route) => {
        const request = route.request();
        const url = request.url();
        const resourceType = request.resourceType();
        if (/\/cdn-cgi\/rum/i.test(url)) {
          await route.fulfill({ status: 204, contentType: "text/plain", body: "" }).catch(() => {});
          return;
        }
        if (/streamfree\.vip/i.test(url) && (resourceType === "document" || /\.m3u8(?:[?#]|$)|\/hls\//i.test(url))) {
          await route
            .continue({
              headers: {
                ...request.headers(),
                referer: cleanReferer || "https://hhkungfu.ee/",
                origin: "https://hhkungfu.ee",
              },
            })
            .catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      })
      .catch(() => {});

    const refererUrl = cleanReferer ? new URL(cleanReferer) : null;
    const wrapperUrl = String(new URL("/__tsverse_stream_probe.html", cleanReferer || "https://hhkungfu.ee/"));
    await page
      .route(wrapperUrl, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;width:100%;height:100%;background:#000;border:0;overflow:hidden}</style></head><body><iframe src="${escapeAttribute(cleanIframeUrl)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe></body></html>`,
        }),
      )
      .catch(() => {});

    const entries = [];
    if (refererUrl && /(^|\.)hhkungfu\.ee$/i.test(refererUrl.hostname) && /\/(?:watch-|xem-phim\/)/i.test(refererUrl.pathname)) {
      entries.push({ label: "hhkungfu-referer", url: cleanReferer });
    }
    entries.push({ label: "hhkungfu-wrapper", url: wrapperUrl });
    entries.push({ label: "direct-iframe", url: cleanIframeUrl });

    const deadline = Date.now() + extractTimeoutMs;
    for (const entry of entries) {
      if (finalM3u8 || Date.now() >= deadline) break;
      debug.entries.push(entry);

      try {
        await page.goto(entry.url, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(10000, Math.max(1000, deadline - Date.now())),
          referer: entry.label === "direct-iframe" && cleanReferer ? cleanReferer : undefined,
        });
      } catch (error) {
        debug.entries.push({
          label: entry.label,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const entryDeadline = Date.now() + Math.min(Math.max(3000, attemptTimeoutMs), Math.max(1000, deadline - Date.now()));
      await page.waitForTimeout(1000);
      while (!finalM3u8 && Date.now() < entryDeadline) {
        await triggerPlayback(page);
        await page.waitForTimeout(500);
      }
    }

    if (!finalM3u8) {
      debug.snapshots = await snapshotFrames(page);
      const error = new Error("Bytecode VM did not yield m3u8");
      error.statusCode = 404;
      error.debug = debug;
      throw error;
    }

    debug.snapshots = await snapshotFrames(page);
    return { url: finalM3u8, headers: finalM3u8Headers, debug };
  } finally {
    activeContexts -= 1;
    if (context) await context.close().catch(() => {});
  }
}

function health(_request, response) {
  response.json({ ok: true, activeContexts, uptimeSeconds: Math.round(process.uptime()) });
}

app.get("/health", health);
app.get("/api/health", health);

app.post("/api/extract", async (request, response) => {
  if (!assertAuthorized(request, response)) return;
  totalRequests += 1;
  const startedAt = Date.now();

  try {
    const result = await Promise.race([
      extractStreamWithRetries({
        iframeUrl: request.body?.iframeUrl,
        referer: request.body?.referer,
      }),
      timeoutError(Math.max(requestTimeoutMs, 45000)),
    ]);
    lastResult = {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString(),
      debug: result.debug,
    };
    response.json({ success: true, url: result.url });
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    lastResult = {
      ok: false,
      status,
      error: error instanceof Error ? error.message : "Unknown extractor error",
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString(),
      debug: error?.debug,
    };
    response.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown extractor error",
    });
  }
});

app.post("/api/extract-playlist", async (request, response) => {
  if (!assertAuthorized(request, response)) return;
  totalRequests += 1;
  const startedAt = Date.now();

  try {
    const result = await Promise.race([
      extractStreamWithRetries({
        iframeUrl: request.body?.iframeUrl,
        referer: request.body?.referer,
      }),
      timeoutError(Math.max(requestTimeoutMs, 45000)),
    ]);
    const playlist = await fetchAndRewritePlaylist(result.url, result.headers, request);
    lastResult = {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString(),
      debug: result.debug,
    };
    response.json({ success: true, playlist });
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    lastResult = {
      ok: false,
      status,
      error: error instanceof Error ? error.message : "Unknown extractor error",
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString(),
      debug: error?.debug,
    };
    response.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown extractor error",
    });
  }
});

app.get("/api/media/:token", async (request, response) => {
  cleanupMediaTokens();
  const entry = mediaTokenCache.get(String(request.params.token));
  if (!entry) {
    response.status(404).type("text/plain").send("Media token expired");
    return;
  }

  try {
    const result = await fetchMediaEntry(entry, request);
    if (!result.ok) {
      response.status(result.status).type("text/plain").send(`Streamfree media returned ${result.status}`);
      return;
    }

    const contentType = result.headers.get("content-type") || "";
    response.setHeader("cache-control", "public, max-age=300");
    for (const header of ["accept-ranges", "content-range", "content-length"]) {
      const value = result.headers.get(header);
      if (value) response.setHeader(header, value);
    }

    if (contentType.includes("mpegurl") || /\.m3u8(?:[?#]|$)/i.test(entry.url)) {
      const playlist = await result.text();
      response.type("application/vnd.apple.mpegurl").send(rewritePlaylistWithMediaTokens(playlist, new URL(entry.url), entry.headers, request));
      return;
    }

    const bytes = Buffer.from(await result.arrayBuffer());
    if (!request.headers.range && bytes.subarray(0, 7).toString("utf8") === "#EXTM3U") {
      const playlist = bytes.toString("utf8");
      response.type("application/vnd.apple.mpegurl").send(rewritePlaylistWithMediaTokens(playlist, new URL(entry.url), entry.headers, request));
      return;
    }

    response.type(contentType || "application/octet-stream").send(bytes);
  } catch (error) {
    response.status(502).type("text/plain").send(error instanceof Error ? error.message : "Cannot proxy Streamfree media");
  }
});

app.get("/debug/status", (_request, response) => {
  response.json({ ok: true, activeContexts, maxContexts, totalRequests, mediaTokens: mediaTokenCache.size, lastResult });
});

function startKeepAlive() {
  const normalizedKeepAliveUrl = normalizeHttpUrl(keepAliveUrl);
  if (!normalizedKeepAliveUrl || !Number.isFinite(keepAliveIntervalMs) || keepAliveIntervalMs < 60000) return;

  const ping = async () => {
    try {
      const response = await fetch(normalizedKeepAliveUrl, {
        headers: { "user-agent": "TSVERSE-stream-extractor-keepalive/1.0" },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`Keepalive ${response.status} ${normalizedKeepAliveUrl}`);
    } catch (error) {
      console.warn(`Keepalive failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const timer = setInterval(ping, keepAliveIntervalMs);
  timer.unref?.();
}

process.on("SIGTERM", async () => {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Stream extractor listening on ${port}`);
  startKeepAlive();
});
