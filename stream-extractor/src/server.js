import express from "express";
import { chromium } from "playwright";

const app = express();
const port = Number(process.env.PORT || 3000);
const extractorToken = process.env.STREAM_EXTRACTOR_TOKEN || "";
const launchTimeoutMs = Number(process.env.EXTRACTOR_LAUNCH_TIMEOUT_MS || 30000);
const extractTimeoutMs = Number(process.env.EXTRACTOR_TIMEOUT_MS || 18000);
const requestTimeoutMs = Number(process.env.EXTRACTOR_REQUEST_TIMEOUT_MS || 25000);
const maxContexts = Number(process.env.EXTRACTOR_MAX_CONTEXTS || 1);
const keepAliveUrl = process.env.KEEPALIVE_URL || "";
const keepAliveIntervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS || 0);

app.use(express.json({ limit: "32kb" }));

let browserPromise = null;
let activeContexts = 0;
let totalRequests = 0;
let lastResult = null;

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

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      timeout: launchTimeoutMs,
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
  return /\.m3u8(?:[?#]|$)/i.test(url) && !/ads?|vast|tracking|analytics/i.test(url);
}

function isInterestingNetworkUrl(url) {
  return /m3u8|mp4|streamfree|hhkungfu|api\/streamfree|cdn-cgi\/rum/i.test(url);
}

async function triggerPlayback(page) {
  const frames = page.frames().filter((frame) => /streamfree|api\/streamfree/i.test(frame.url()));
  const targets = frames.length ? frames : [page.mainFrame()];

  for (const frame of targets) {
    await frame
      .evaluate(() => {
        try {
          const player = typeof window.jwplayer === "function" ? window.jwplayer() : null;
          if (player?.play) player.play();
          const video = document.querySelector("video");
          if (video) void video.play();
          const clickable = document.querySelector("button,[role='button'],.jwplayer,.jw-display-icon-container");
          if (clickable instanceof HTMLElement) clickable.click();
        } catch {}
      })
      .catch(() => {});

    const element = await frame.frameElement().catch(() => null);
    const box = element ? await element.boundingBox().catch(() => null) : null;
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
        Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });
        Object.defineProperty(window, "outerWidth", { get: () => window.innerWidth, configurable: true });
        Object.defineProperty(window, "outerHeight", { get: () => window.innerHeight, configurable: true });
        window.chrome ||= {
          app: {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
          },
          runtime: {},
        };

        const makeNative = (fn, name) => {
          try {
            Object.defineProperty(fn, "toString", {
              value: () => `function ${name}() { [native code] }`,
              configurable: true,
            });
          } catch {}
          return fn;
        };
        const noop = function () {};
        const mockConsole = {};
        ["log", "table", "clear", "dir", "group", "groupCollapsed", "groupEnd", "trace", "warn", "info", "debug", "error"].forEach((name) => {
          mockConsole[name] = makeNative(noop, name);
        });
        window.console = mockConsole;

        const realPerformanceNow = window.performance?.now?.bind(window.performance);
        if (realPerformanceNow) {
          let last = realPerformanceNow();
          window.performance.now = function () {
            const current = realPerformanceNow();
            last = current - last > 100 ? last + 1 : current;
            return last;
          };
        }

        const realDateNow = Date.now;
        let lastDate = realDateNow();
        Date.now = function () {
          const current = realDateNow();
          lastDate = current - lastDate > 100 ? lastDate + 1 : current;
          return lastDate;
        };
      } catch {}
    });

    const page = await context.newPage();
    let finalM3u8 = "";

    const capture = (url) => {
      if (!isLikelyPrimaryPlaylist(url)) return;
      if (!finalM3u8 || /(?:master|index|playlist)/i.test(url)) finalM3u8 = url;
    };

    page.on("request", (request) => {
      capture(request.url());
      if (isInterestingNetworkUrl(request.url())) {
        pushLimited(debug.network, `REQ ${request.method()} ${request.resourceType()} ${request.url()}`);
      }
    });
    page.on("response", (response) => {
      capture(response.url());
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

      await page.waitForTimeout(1000);
      while (!finalM3u8 && Date.now() < deadline) {
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
    return { url: finalM3u8, debug };
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
      extractStream({
        iframeUrl: request.body?.iframeUrl,
        referer: request.body?.referer,
      }),
      timeoutError(requestTimeoutMs),
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

app.get("/debug/status", (_request, response) => {
  response.json({ ok: true, activeContexts, maxContexts, totalRequests, lastResult });
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
