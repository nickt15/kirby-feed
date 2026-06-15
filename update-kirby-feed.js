const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FEED_PATH = path.join(__dirname, "latest.json");
const IMAGES_DIR = path.join(__dirname, "images");

const SCAN_AHEAD = 5;
const BASE_URL = "https://codecraftsupport.com/Kirby/DATA/Images";

function loadFeed() {
  if (!fs.existsSync(FEED_PATH)) {
    return {
      latestKirby: 2800,
      kirbys: []
    };
  }

  const feed = JSON.parse(fs.readFileSync(FEED_PATH, "utf8"));

  if (typeof feed.latestKirby !== "number") {
    feed.latestKirby = 2800;
  }

  if (!Array.isArray(feed.kirbys)) {
    feed.kirbys = [];
  }

  return feed;
}

function saveFeed(feed) {
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));
}

function downloadWithCurl(url, filePath) {
  try {
    execFileSync("curl", [
      "-L",
      "--http1.1",
      "--connect-timeout", "30",
      "--max-time", "120",
      "--retry", "3",
      "--retry-delay", "10",
      "-A", "Mozilla/5.0",
      "-o", filePath,
      url
    ], {
      stdio: "inherit"
    });

    if (!fs.existsSync(filePath)) return false;

    const size = fs.statSync(filePath).size;

    if (size < 100) {
      fs.unlinkSync(filePath);
      return false;
    }

    console.log(`✅ Downloaded ${path.basename(filePath)} (${size} bytes)`);
    return true;

  } catch (err) {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }

    console.log(`❌ Failed: ${url}`);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  const feed = loadFeed();

  let highestFound = feed.latestKirby;
  const start = feed.latestKirby + 1;
  const end = feed.latestKirby + SCAN_AHEAD;

  console.log(`Starting at ${feed.latestKirby}`);
  console.log(`Checking ${start} through ${end}`);

  for (let n = start; n <= end; n++) {
    const fileName = `${n}.jpg`;
    const filePath = path.join(IMAGES_DIR, fileName);
    const url = `${BASE_URL}/${fileName}`;

    if (fs.existsSync(filePath)) {
      console.log(`Already have ${fileName}`);
      highestFound = Math.max(highestFound, n);
      continue;
    }

    console.log(`Checking Kirby ${n}`);

    const ok = downloadWithCurl(url, filePath);

    if (!ok) continue;

    if (!feed.kirbys.includes(n)) {
      feed.kirbys.push(n);
    }

    if (n > highestFound) {
      highestFound = n;
    }
  }

  feed.latestKirby = highestFound;
  feed.updatedAt = new Date().toISOString();
  feed.kirbys = [...new Set(feed.kirbys)].sort((a, b) => a - b);

  saveFeed(feed);

  console.log("Done.");
  console.log(feed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
