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

function isRealJpg(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);

    if (buffer.length < 100) return false;

    // JPG magic bytes
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
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
      console.log(`❌ Bad image size: ${filePath}`);
      return false;
    }

    if (!isRealJpg(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`❌ Not a real JPG, removed: ${filePath}`);
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
      if (!isRealJpg(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`❌ Removed bad cached file: ${fileName}`);
      } else {
        console.log(`Already have ${fileName}`);

        if (!feed.kirbys.includes(n)) {
          feed.kirbys.push(n);
        }

        highestFound = Math.max(highestFound, n);
        continue;
      }
    }

    console.log(`Checking Kirby ${n}`);

    const ok = downloadWithCurl(url, filePath);
await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay

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
