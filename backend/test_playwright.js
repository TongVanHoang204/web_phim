import { chromium } from "playwright";

const target =
  process.env.TARGET_URL ||
  "https://tsverse.vercel.app/xem-phim/gia-thien?episode=tap-163";

const waitMs = Number(process.env.WAIT_MS || 25000);
const testsStreamfreeDirectly = target.includes("streamfree.vip") || target.includes("/api/streamfree/");

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
      // 1. Stub iframe check
      var mockParent = new Proxy(window, {
        get: function(target, prop) {
          if (prop === "location") {
            return {
              href: "https://hhkungfu.ee/",
              origin: "https://hhkungfu.ee",
              protocol: "https:",
              host: "hhkungfu.ee",
              hostname: "hhkungfu.ee",
              pathname: "/",
              search: "",
              hash: ""
            };
          }
          return target[prop];
        }
      });

      try {
        Object.defineProperty(window, "parent", { get: function() { return mockParent; }, configurable: true });
      } catch(e) {}
      try {
        Object.defineProperty(window, "top", { get: function() { return mockParent; }, configurable: true });
      } catch(e) {}

      var dummyFrame = document.createElement("iframe");
      try {
        Object.defineProperty(window, "frameElement", { get: function() { return dummyFrame; }, configurable: true });
      } catch(e) {}

      // 2. Neutralize webdriver
      try {
        Object.defineProperty(navigator, "webdriver", {
          get: function() { return false; },
          configurable: true
        });
      } catch(e) {}

      // 3. Completely stub all console methods natively to neutralize devtools detector CDP triggers
      try {
        var makeNative = function(fn, name) {
          try {
            Object.defineProperty(fn, "toString", {
              value: function() { return "function " + (name || fn.name) + "() { [native code] }"; },
              configurable: true
            });
          } catch(e) {}
          return fn;
        };
        var noop = function() {};
        var mockConsole = {};
        var props = ["log", "table", "clear", "dir", "group", "groupCollapsed", "groupEnd", "trace", "warn", "info", "debug", "error"];
        props.forEach(function(p) {
          mockConsole[p] = makeNative(noop, p);
        });
        window.console = mockConsole;
      } catch(e) {}

      // 4. Cap performance.now() and Date.now() timing jumps to defeat date-delay/timing checks
      try {
        var realNow = window.performance.now.bind(window.performance);
        var lastTime = realNow();
        window.performance.now = function() {
          var current = realNow();
          if (current - lastTime > 100) {
            lastTime += 1;
          } else {
            lastTime = current;
          }
          return lastTime;
        };
      } catch(e) {}
      try {
        var realDateNow = Date.now;
        var lastDate = realDateNow();
        Date.now = function() {
          var current = realDateNow();
          if (current - lastDate > 100) {
            lastDate += 1;
          } else {
            lastDate = current;
          }
          return lastDate;
        };
      } catch(e) {}

      // 5. Mock Chrome
      try {
        window.chrome = {
          app: {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
            getDetails: function() {},
            getIsInstalled: function() {},
            install: function() {}
          },
          runtime: {
            OnInstalledReason: { INSTALL: "install", UPDATE: "update", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE_AVAILABLE: "update_available" },
            OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
            PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
            PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
            PlatformOS: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
            RequestUpdateCheckStatus: { NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available", THROTTLED: "throttled" }
          }
        };
      } catch(e) {}
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
    console.log(`Navigating to: ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Wait for players to load
    await page.waitForTimeout(3000);

    // Attempt multi-layered play triggers inside streamfree frame context
    const sfFrame = page.frames().find(f => f.url().includes("streamfree"));
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
      console.log("\nSOURCE_UNAVAILABLE: app showed the no-stable-HLS fallback state instead of hanging.");
      return;
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
