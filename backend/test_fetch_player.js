async function test() {
  const url = new URL("https://hhkungfu.ee/player/player.php");
  url.searchParams.set("action", "dox_ajax_player");
  url.searchParams.set("post_id", "840");
  url.searchParams.set("chapter_st", "tap-162");
  url.searchParams.set("type", "pro");
  url.searchParams.set("sv", "1");

  console.log("Fetching player html from hhkungfu...");
  const result = await fetch(url, {
    headers: {
      accept: "text/html",
      referer: "https://hhkungfu.ee/",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    },
  });

  console.log("Status:", result.status);
  const text = await result.text();
  console.log("HTML:", text);
}

test().catch(console.error);
