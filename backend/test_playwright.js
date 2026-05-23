import { chromium } from "playwright";

const target =
  process.env.TARGET_URL ||
  "https://tsverse.vercel.app/xem-phim/gia-thien?episode=tap-163";

const waitMs = Number(process.env.WAIT_MS || 25000);
const testsStreamfreeDirectly = target.includes("streamfree.vip") || target.includes("/api/streamfree/");
const allowSourceUnavailable = process.env.ALLOW_SOURCE_UNAVAILABLE === "true";

function isMediaUrl(url) {
  if (url.includes("/hls-proxy") || url.includes("/api/hhkungfu/hls/")) return true;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith(".m3u8") || pathname.endsWith(".mp4")) return true;
    if (pathname.endsWith(".ts")) {
      return !pathname.startsWith("/src/") && !pathname.includes("/node_modules/") && !pathname.includes("/@fs/");
    }
  } catch {
    return /\.(m3u8|mp4)(?:[?#]|$)/i.test(url);
  }
  return false;
}

async function frameSnapshot(frame) {
  return frame.evaluate(() => {
    const player = document.querySelector("#hrm-player");
    const video = document.querySelector("video");
    const jw = typeof window.jwplayer;
    const mediaSource = typeof window.MediaSource;
    const hrmHtml = player ? player.outerHTML.substring(0, 800) : null;
    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 500) || "",
      playerState: player?.getAttribute("data-state") || null,
      hasVideo: Boolean(video),
      video: video
        ? {
            src: video.currentSrc || video.src,
            readyState: video.readyState,
            duration: Number.isFinite(video.duration) ? video.duration : null,
            paused: video.paused,
          }
        : null,
      jwplayerType: jw,
      mediaSourceType: mediaSource,
      playerOuterHtml: hrmHtml,
    };
  });
}

async function test() {
  console.log("Starting browser...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security"
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1200, height: 720 },
  });

  if (testsStreamfreeDirectly) {
    await context.setExtraHTTPHeaders({
      "referer": "https://hhkungfu.ee/",
      "origin": "https://hhkungfu.ee"
    });
  }

  const page = await context.newPage();
  const consoleMessages = [];
  const mediaResponses = [];
  const failedRequests = [];

  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) {
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    }
  });

  page.on("pageerror", (err) => {
    consoleMessages.push(`[pageerror] ${err.name}: ${err.message}`);
  });

  page.on("response", (response) => {
    const url = response.url();
    mediaResponses.push(`${response.status()} ${response.request().method()} ${url}`);
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    failedRequests.push(`${request.method()} ${url} ${request.failure()?.errorText || ""}`);
  });

  // Inject anti-bot bypass scripts only when the target itself is Streamfree.
  // App-page tests should exercise TSVERSE without modifying browser globals.
  if (testsStreamfreeDirectly) {
    await page.addInitScript(() => {
      try {
        var makeNative = function(fn, name) {
          try { Object.defineProperty(fn, "toString", { value: function() { return "function " + (name || fn.name) + "() { [native code] }"; }, configurable: true }); } catch(e) {}
          return fn;
        };

        // Check 0: iframe detection — mock parent/top to look like hhkungfu.ee embedding
        try {
          var mockParent = new Proxy(window, {
            get: function(target, prop) {
              if (prop === "location") return { href: "https://hhkungfu.ee/", origin: "https://hhkungfu.ee/", protocol: "https:", host: "hhkungfu.ee", hostname: "hhkungfu.ee", pathname: "/", search: "", hash: "" };
              return target[prop];
            }
          });
          try { Object.defineProperty(window, "parent", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
          try { Object.defineProperty(window, "top", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
          try { Object.defineProperty(Window.prototype, "parent", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
          try { Object.defineProperty(Window.prototype, "top", { get: function() { return mockParent; }, configurable: true }); } catch(e) {}
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
            apply: function(t, a, r) { return Reflect.apply(t, a, Array.prototype.map.call(r, cd)); },
            construct: function(t, r) { return Reflect.construct(t, Array.prototype.map.call(r, cd)); }
          });
          window.Function.prototype = nf.prototype;
        } catch(e) {}
        try { var ne = window.eval; window.eval = function(v) { return ne.call(window, typeof v === "string" ? v.replace(/\bdebugger\b/g, "void 0") : v); }; } catch(e) {}

        // Block ad/tracking noise
        try {
          var isNoise = function(u) { return /ibyteimg\.com\/obj\/ad-site-i18n|\/cdn-cgi\/rum/.test(u || ""); };
          var of = window.fetch;
          if (of) { window.fetch = function(i, o) { var u = typeof i === "string" ? i : i && i.url; if (isNoise(u)) return Promise.resolve(new Response("", { status: 204 })); return of.apply(window, arguments); }; }
        } catch(e) {}

        // Protect video element prototypes from browser extension takeover
        try { window._nativeVideoFns = { play: HTMLMediaElement.prototype.play, pause: HTMLMediaElement.prototype.pause, load: HTMLMediaElement.prototype.load }; } catch(e) {}
      } catch(e) {}
    });
  }

  if (testsStreamfreeDirectly) {
    await page.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      const type = req.resourceType();
      if (url.includes("streamfree.vip") && (type === "document" || url.includes(".m3u8"))) {
        const headers = {
          ...req.headers(),
          "referer": "https://hhkungfu.ee/",
          "origin": "https://hhkungfu.ee"
        };
        await route.continue({ headers });
      } else {
        await route.continue();
      }
    });
  }

  try {
    let sfFrame;
    if (testsStreamfreeDirectly) {
      console.log(`Navigating to parent host: https://hhkungfu.ee/`);
      await page.goto("https://hhkungfu.ee/", { waitUntil: "domcontentloaded", timeout: 45000 });
      
      console.log(`Injecting streamfree iframe: ${target}`);
      await page.evaluate((embedUrl) => {
        document.body.innerHTML = "";
        document.body.style.margin = "0";
        document.body.style.padding = "0";
        document.body.style.width = "100vw";
        document.body.style.height = "100vh";
        document.body.style.overflow = "hidden";
        const iframe = document.createElement("iframe");
        iframe.src = embedUrl;
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "none";
        iframe.id = "test-player-iframe";
        document.body.appendChild(iframe);
      }, target);

      console.log("Waiting for streamfree frame to attach...");
      const iframeElement = await page.waitForSelector("iframe#test-player-iframe", { timeout: 15000 });
      sfFrame = await iframeElement.contentFrame();
      await page.waitForTimeout(3000);
    } else {
      console.log(`Navigating to: ${target}`);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      sfFrame = page.frames().find(f => f.url().includes("streamfree"));
    }
    if (sfFrame) {
      console.log("Triggering jwplayer/video play in streamfree iframe...");
      await sfFrame.evaluate(() => {
        try {
          if (typeof window.jwplayer === "function") {
            window.jwplayer().play();
          } else {
            const v = document.querySelector("video");
            if (v) v.play();
          }
        } catch (e) {}
      }).catch(() => {});
    }

    // Also attempt center coordinate click of the player iframe to trigger interaction
    try {
      const frameElement = await page.$("iframe");
      if (frameElement) {
        const box = await frameElement.boundingBox();
        if (box) {
          console.log("Clicking center of player iframe...");
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      }
    } catch (e) {}

    await page.waitForTimeout(waitMs - 3000);

    const snapshots = [];
    for (const frame of page.frames()) {
      snapshots.push(await frameSnapshot(frame).catch((error) => ({ url: frame.url(), error: String(error) })));
    }

    const streamfree = snapshots.find((item) => item.url?.includes("/api/streamfree/embed/") || item.url?.includes("streamfree.vip"));
    const hasUsableVideo = snapshots.some((item) => item.hasVideo && item.video?.readyState >= 1);
    const hasMedia = mediaResponses.some((line) => {
      const match = line.match(/^2\d\d\s+\S+\s+(.+)$/);
      return Boolean(match && isMediaUrl(match[1]));
    });
    const stuckLoading = streamfree?.playerState === "loading";
    const sourceUnavailable = snapshots.some((item) => /Nguồn này chưa sẵn sàng|Server hiện chưa có HLS ổn định/i.test(item.text || ""));

    console.log("\nFrame snapshots:");
    console.log(JSON.stringify(snapshots, null, 2));

    console.log("\nMedia responses:");
    console.log(mediaResponses.length ? mediaResponses.join("\n") : "(none)");

    console.log("\nConsole warnings/errors:");
    console.log(consoleMessages.length ? consoleMessages.join("\n") : "(none)");

    console.log("\nFailed requests:");
    console.log(failedRequests.length ? failedRequests.join("\n") : "(none)");

    if (sourceUnavailable) {
      if (allowSourceUnavailable) {
        console.log("\nSOURCE_UNAVAILABLE: app showed the no-stable-HLS fallback state instead of hanging.");
        return;
      }
      throw new Error("SOURCE_UNAVAILABLE: app did not load playable media for this episode");
    }

    if (!hasUsableVideo && !hasMedia) {
      throw new Error("Player did not load usable video or media responses");
    }

    if (stuckLoading) {
      throw new Error("Streamfree player is stuck in data-state=loading");
    }

    console.log("\nSUCCESS: player loaded playable media.");
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

test().catch((error) => {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
