import { chromium } from "playwright";

const target =
  process.env.TARGET_URL ||
  "https://tsverse.vercel.app/xem-phim/gia-thien?episode=tap-163";

const waitMs = Number(process.env.WAIT_MS || 15000);

function isMediaUrl(url) {
  return /\.(m3u8|ts|mp4)(?:[?#]|$)/i.test(url) || url.includes("/hls-proxy") || url.includes("/api/hhkungfu/hls/");
}

async function frameSnapshot(frame) {
  return frame.evaluate(() => {
    const player = document.querySelector("#hrm-player");
    const video = document.querySelector("video");
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
    };
  });
}

async function test() {
  console.log("Starting browser...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1200, height: 720 },
  });

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
    if (isMediaUrl(url)) {
      mediaResponses.push(`${response.status()} ${url}`);
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("tsverse") || url.includes("streamfree")) {
      failedRequests.push(`${request.method()} ${url} ${request.failure()?.errorText || ""}`);
    }
  });

  try {
    console.log(`Navigating to: ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(waitMs);

    const snapshots = [];
    for (const frame of page.frames()) {
      snapshots.push(await frameSnapshot(frame).catch((error) => ({ url: frame.url(), error: String(error) })));
    }

    const streamfree = snapshots.find((item) => item.url?.includes("/api/streamfree/embed/") || item.url?.includes("streamfree.vip"));
    const hasUsableVideo = snapshots.some((item) => item.hasVideo && item.video?.readyState >= 1);
    const hasMedia = mediaResponses.some((line) => /^2\d\d /.test(line));
    const stuckLoading = streamfree?.playerState === "loading";

    console.log("\nFrame snapshots:");
    console.log(JSON.stringify(snapshots, null, 2));

    console.log("\nMedia responses:");
    console.log(mediaResponses.length ? mediaResponses.join("\n") : "(none)");

    console.log("\nConsole warnings/errors:");
    console.log(consoleMessages.length ? consoleMessages.join("\n") : "(none)");

    console.log("\nFailed requests:");
    console.log(failedRequests.length ? failedRequests.join("\n") : "(none)");

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
