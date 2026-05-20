import fs from 'fs';
import path from 'path';

async function testHhkungfuVideo() {
  console.log("Starting video check script...");
  const baseUrl = "http://localhost:8081";

  // Step 1: Check backend health
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    if (!health.ok) {
      console.log("❌ Backend is not running! Start it with 'npm run dev:backend' first.");
      return;
    }
    console.log("✅ Backend is running.");
  } catch (e) {
    console.log("❌ Could not connect to backend. Is it running on port 8081?");
    return;
  }

  // Step 2: Fetch latest movies to get a slug
  console.log("\nFetching latest movies...");
  const latestRes = await fetch(`${baseUrl}/api/movies/latest`);
  const latestData = await latestRes.json();
  const hhkungfuMovie = latestData.items.find((item) => item.source === "hhkungfu");
  
  if (!hhkungfuMovie) {
    console.log("❌ No hhkungfu movies found in latest.");
    return;
  }
  console.log(`✅ Found movie: ${hhkungfuMovie.name} (${hhkungfuMovie.slug})`);

  // Step 3: Fetch movie episodes
  console.log(`\nFetching episodes for ${hhkungfuMovie.slug}...`);
  const episodesRes = await fetch(`${baseUrl}/api/movies/${hhkungfuMovie.slug}/episodes`);
  const episodesData = await episodesRes.json();
  
  if (!episodesData.status || !episodesData.episodes || episodesData.episodes.length === 0) {
    console.log("❌ Could not load episodes.");
    return;
  }
  
  const firstEpisode = episodesData.episodes[0].server_data[0];
  console.log(`✅ Found episode: ${firstEpisode.name} (ID: ${firstEpisode._id})`);

  // Step 4: Fetch episode player URL
  console.log(`\nFetching player detail for episode ${firstEpisode._id}...`);
  const detailRes = await fetch(`${baseUrl}/api/episodes/${firstEpisode._id}`);
  const detailData = await detailRes.json();

  if (!detailData.status || !detailData.episode) {
    console.log("❌ Failed to get episode detail.");
    return;
  }

  console.log(`✅ Player Type: ${detailData.episode.playerType}`);
  console.log(`✅ Link Embed: ${detailData.episode.link_embed}`);
  
  // Step 5: Test the proxy HTML
  const playerUrl = `${baseUrl}${detailData.episode.link_embed}`;
  console.log(`\nTesting Proxy Player URL: ${playerUrl}`);
  const playerHtmlRes = await fetch(playerUrl);
  const playerHtml = await playerHtmlRes.text();
  
  if (!playerHtmlRes.ok) {
    console.log(`❌ Proxy player returned status ${playerHtmlRes.status}`);
    return;
  }
  
  if (playerHtml.includes("streamfree")) {
    console.log("✅ Proxy player loaded correctly and contains streamfree iframe!");
    
    // Extract streamfree proxy URL
    const match = playerHtml.match(/src="(\/api\/streamfree\/embed\/[^"]+)"/);
    if (match && match[1]) {
      const sfUrl = `${baseUrl}${match[1]}`;
      console.log(`✅ Extracted streamfree URL: ${sfUrl}`);
      
      console.log(`\nFetching streamfree HTML to verify proxying...`);
      const sfRes = await fetch(sfUrl);
      const sfHtml = await sfRes.text();
      
      if (sfHtml.includes("jwplayer") || sfHtml.includes("MediaSource")) {
        console.log("✅ Streamfree proxy works and returned video player HTML!");
      } else {
        console.log("❌ Streamfree proxy returned unexpected HTML.");
        console.log(sfHtml.substring(0, 500));
      }
    } else {
      console.log("❌ Could not extract streamfree iframe from proxy player HTML.");
    }
  } else {
    console.log("❌ Proxy player loaded but does NOT contain expected iframe.");
  }
}

testHhkungfuVideo().catch(console.error);
