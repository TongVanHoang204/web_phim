async function testProduction() {
  console.log("Testing TSVERSE production endpoints...");
  const targetHost = "https://tsverse.vercel.app";
  const slug = "su-huynh-a-su-huynh";
  const episodeSlug = "tap-142";

  try {
    // 1. Fetch episodes
    console.log(`\n1. Fetching episodes from production: ${targetHost}/api/movies/${slug}/episodes`);
    const epRes = await fetch(`${targetHost}/api/movies/${slug}/episodes`);
    if (!epRes.ok) {
      console.log(`❌ Failed to fetch episodes. Status: ${epRes.status}`);
      return;
    }
    const epData = await epRes.json();
    console.log("✅ Episodes loaded successfully.");

    // Find the episode
    let targetEpisode = null;
    for (const server of epData.episodes) {
      const found = server.server_data.find(ep => ep.slug === episodeSlug);
      if (found) {
        targetEpisode = found;
        console.log(`✅ Found episode ${episodeSlug} on server "${server.server_name}". ID: ${found._id}`);
        break;
      }
    }

    if (!targetEpisode) {
      console.log(`❌ Could not find episode "${episodeSlug}" in the production list.`);
      return;
    }

    // 2. Fetch player details
    const playerDetailUrl = `${targetHost}/api/episodes/${targetEpisode._id}`;
    console.log(`\n2. Fetching player details: ${playerDetailUrl}`);
    const detailRes = await fetch(playerDetailUrl);
    if (!detailRes.ok) {
      console.log(`❌ Failed to fetch player details. Status: ${detailRes.status}`);
      return;
    }
    const detailData = await detailRes.json();
    console.log("✅ Player detail response:", JSON.stringify(detailData, null, 2));

    const embedUrl = detailData.episode.link_embed;
    console.log(`\n3. Loading embed player HTML from: ${targetHost}${embedUrl}`);
    const embedRes = await fetch(`${targetHost}${embedUrl}`);
    if (!embedRes.ok) {
      console.log(`❌ Failed to load player HTML. Status: ${embedRes.status}`);
      return;
    }
    const embedHtml = await embedRes.text();
    console.log("✅ Player HTML successfully fetched!");

    // Extract streamfree proxy url
    const match = embedHtml.match(/src="(\/api\/streamfree\/embed\/[^"]+)"/);
    if (match && match[1]) {
      const sfUrl = `${targetHost}${match[1]}`;
      console.log(`\n4. Testing streamfree proxy URL: ${sfUrl}`);
      const sfRes = await fetch(sfUrl);
      if (!sfRes.ok) {
        console.log(`❌ Streamfree proxy returned status ${sfRes.status}`);
        return;
      }
      const sfHtml = await sfRes.text();
      if (sfHtml.includes("jwplayer") || sfHtml.includes("MediaSource")) {
        console.log("✅ SUCCESS! Deployed streamfree proxy works and returned valid player HTML!");
      } else {
        console.log("❌ Deployed streamfree proxy returned unexpected HTML.");
        console.log(sfHtml.substring(0, 500));
      }
    } else {
      console.log("❌ Could not extract streamfree iframe URL from proxy player HTML.");
      console.log(embedHtml.substring(0, 500));
    }
  } catch (e) {
    console.log("❌ Error during production test:", e.message);
  }
}

testProduction();
