async function verify() {
  const episodeId = "eyJwb3N0SWQiOiI4NDAiLCJjaGFwdGVyIjoidGFwLTE2MiIsInR5cGUiOiJwcm8iLCJzdiI6IjEifQ";
  const host = "http://localhost:8081";

  const m3u8Url = `${host}/api/hhkungfu/hls/${episodeId}`;
  console.log(`\n1. Fetching direct HHKungfu HLS Playlist from: ${m3u8Url}... (This will trigger Playwright resolution in background)`);
  
  const m3u8Res = await fetch(m3u8Url);
  if (!m3u8Res.ok) {
    const errorBody = await m3u8Res.text();
    throw new Error(`Failed to fetch M3U8 playlist: ${m3u8Res.status} ${m3u8Res.statusText}\nError Body: ${errorBody}`);
  }

  const playlistText = await m3u8Res.text();
  console.log("\n2. M3U8 PLAYLIST PREVIEW (First 20 lines):");
  console.log(playlistText.split("\n").slice(0, 20).join("\n"));
  
  console.log("\n3. Verifying proxy URL rewrites...");
  if (playlistText.includes("/api/hhkungfu/hls-proxy") || playlistText.includes("/api/phimapi/hls-proxy")) {
    console.log("SUCCESS! HLS stream resolved and proxied successfully!");
  } else {
    throw new Error("Failed to rewrite playlist urls!");
  }
}

verify().catch(console.error);
