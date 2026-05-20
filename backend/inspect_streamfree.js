async function test() {
  const url = "https://streamfree.vip/public/static/app.1cc3d6a2.js";
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "referer": "https://hhkungfu.ee/"
    }
  });

  const text = await res.text();
  
  // Find all matches of fetch(
  let pos = 0;
  while (true) {
    pos = text.indexOf("fetch(", pos);
    if (pos === -1) break;
    console.log(`FOUND fetch( at pos ${pos}:`);
    console.log(text.slice(pos - 100, pos + 300));
    pos += 6;
  }
}

test().catch(console.error);
