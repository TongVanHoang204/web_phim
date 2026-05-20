import express from "express";
import { chromium } from "playwright";

const app = express();
const port = Number(process.env.PORT || 3000);
const extractorToken = process.env.STREAM_EXTRACTOR_TOKEN || "";
const launchTimeoutMs = Number(process.env.EXTRACTOR_LAUNCH_TIMEOUT_MS || 30000);
const extractTimeoutMs = Number(process.env.EXTRACTOR_TIMEOUT_MS || 18000);
const requestTimeoutMs = Number(process.env.EXTRACTOR_REQUEST_TIMEOUT_MS || 25000);
const maxContexts = Number(process.env.EXTRACTOR_MAX_CONTEXTS || 1);

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
      extraHTTPHeaders: cleanReferer
        ? {
            referer: cleanReferer,
            origin: new URL(cleanReferer).origin,
          }
        : undefined,
    });

    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });
        window.chrome ||= { runtime: {} };
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
    });
    page.on("response", (response) => {
      capture(response.url());
    });

    await page.goto(cleanIframeUrl, { waitUntil: "domcontentloaded", timeout: Math.min(extractTimeoutMs, 15000) });

    const frame = page.frames().find((item) => item.url().includes("streamfree")) || page.mainFrame();
    await frame
      .evaluate(() => {
        try {
          const player = typeof window.jwplayer === "function" ? window.jwplayer() : null;
          if (player?.play) player.play();
          const video = document.querySelector("video");
          if (video) void video.play();
        } catch {}
      })
      .catch(() => {});

    const deadline = Date.now() + extractTimeoutMs;
    while (!finalM3u8 && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    if (!finalM3u8) {
      const error = new Error("Bytecode VM did not yield m3u8");
      error.statusCode = 404;
      throw error;
    }

    return finalM3u8;
  } finally {
    activeContexts -= 1;
    if (context) await context.close().catch(() => {});
  }
}

function health(_request, response) {
  response.json({ ok: true, activeContexts });
}

app.get("/health", health);
app.get("/api/health", health);

app.post("/api/extract", async (request, response) => {
  if (!assertAuthorized(request, response)) return;
  totalRequests += 1;
  const startedAt = Date.now();

  try {
    const url = await Promise.race([
      extractStream({
        iframeUrl: request.body?.iframeUrl,
        referer: request.body?.referer,
      }),
      timeoutError(requestTimeoutMs),
    ]);
    lastResult = { ok: true, status: 200, elapsedMs: Date.now() - startedAt, at: new Date().toISOString() };
    response.json({ success: true, url });
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    lastResult = {
      ok: false,
      status,
      error: error instanceof Error ? error.message : "Unknown extractor error",
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString(),
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

process.on("SIGTERM", async () => {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Stream extractor listening on ${port}`);
});
