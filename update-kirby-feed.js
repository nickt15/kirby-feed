const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const axios = require("axios");
const cheerio = require("cheerio");

const FEED_PATH = path.join(__dirname, "latest.json");
const IMAGES_DIR = path.join(__dirname, "images");
const SPECIALS_DIR = path.join(__dirname, "images", "specials");

const SCAN_AHEAD = 16;
const BACKFILL_BEHIND = 50;
const BASE_URL = "https://codecraftsupport.com/Kirby/DATA/Images";
const SPECIALS_PAGE = "https://codecraftsupport.com/Kirby/gallery_specials.html";

function loadFeed() {
  if (!fs.existsSync(FEED_PATH)) {
    return {
      latestKirby: 2800,
      kirbys: [],
      specials: []
    };
  }

  const feed = JSON.parse(fs.readFileSync(FEED_PATH, "utf8"));

  if (typeof feed.latestKirby !== "number") {
    feed.latestKirby = 2800;
  }

  if (!Array.isArray(feed.kirbys)) {
    feed.kirbys = [];
  }

  if (!Array.isArray(feed.specials)) {
    feed.specials = [];
  }

  return feed;
}

function saveFeed(feed) {
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));
}

function isValidImage(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    // Just check if file is a reasonable size
    // If curl downloaded it successfully, it's valid
    return buffer.length >= 100;
  } catch {
    return false;
  }
}

function downloadWithCurl(url, filePath) {
  try {
    execFileSync("curl", [
      "-L",
      "--http1.1",
      "--connect-timeout", "60",
      "--max-time", "300",
      "--retry", "0",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
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

    if (!isValidImage(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`❌ Not a valid image, removed: ${filePath}`);
      return false;
    }

    console.log(`��� Downloaded ${path.basename(filePath)} (${size} bytes)`);
    return true;
  } catch {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    console.log(`❌ Failed: ${url}`);
    return false;
  }
}

async function scrapeSpecials() {
  try {
    console.log("🔍 Scraping gallery_specials.html...");

    const { data } = await axios.get(SPECIALS_PAGE, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      },
      timeout: 10000
    });

    const $ = cheerio.load(data);
    const specialUrls = new Set();

    // Method 1: Find actual JPG/JPEG/WEBP links in href or src
    $("[href], [src]").each((_, elem) => {
      const href = $(elem).attr("href");
      const src = $(elem).attr("src");

      for (let url of [href, src]) {
        if (!url) continue;

        if (/\.(?:jpe?g|webp)(\?|$)/i.test(url)) {
          url = new URL(url, SPECIALS_PAGE).href;
          specialUrls.add(url);
        }
      }
    });

    // Method 2: Find Kirby numbers in page text like:
    // Kirby #20181201
    // Kirby 20250428
    const pageText = $.text();
    const matches = pageText.matchAll(/Kirby\s*#?\s*(\d{4,})/gi);

    for (const match of matches) {
      const number = match[1];
      specialUrls.add(`${BASE_URL}/${number}.webp`);
    }

    console.log(`Found ${specialUrls.size} special Kirby URLs`);

    for (const url of specialUrls) {
      console.log(`Special found: ${url}`);
    }

    return [...specialUrls];
  } catch (err) {
    console.log(`⚠️ Failed to scrape specials page: ${err.message}`);
    return [];
  }
}

async function downloadSpecials(feed) {
  const specialUrls = await scrapeSpecials();

  if (specialUrls.length === 0) {
    console.log("ℹ️ No special Kirbys found");
    return;
  }

  if (!fs.existsSync(SPECIALS_DIR)) {
    fs.mkdirSync(SPECIALS_DIR, { recursive: true });
  }

  for (const url of specialUrls) {
    const fileName = url.split("/").pop().split("?")[0];
    // Save as .jpg instead of keeping original extension
    const jpgFileName = fileName.replace(/\.(webp|jpeg?)$/i, ".jpg");
    const filePath = path.join(SPECIALS_DIR, jpgFileName);

    if (
      !fileName.toLowerCase().endsWith(".jpg") &&
      !fileName.toLowerCase().endsWith(".jpeg") &&
      !fileName.toLowerCase().endsWith(".webp")
    ) {
      continue;
    }

    if (fs.existsSync(filePath)) {
      if (isValidImage(filePath)) {
        console.log(`Already have special ${jpgFileName}`);

        if (!feed.specials.includes(jpgFileName)) {
          feed.specials.push(jpgFileName);
        }

        continue;
      } else {
        fs.unlinkSync(filePath);
        console.log(`❌ Removed bad cached special: ${jpgFileName}`);
      }
    }

    console.log(`Downloading special: ${jpgFileName}`);

    const ok = downloadWithCurl(url, filePath);

    await new Promise(resolve => setTimeout(resolve, 5000));

    if (ok && !feed.specials.includes(jpgFileName)) {
      feed.specials.push(jpgFileName);
    }
  }
}

async function main() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  if (!fs.existsSync(SPECIALS_DIR)) {
    fs.mkdirSync(SPECIALS_DIR, { recursive: true });
  }

  const feed = loadFeed();

  await downloadSpecials(feed);

  let highestFound = feed.latestKirby;
  const start = Math.max(1, feed.latestKirby - BACKFILL_BEHIND);
  const end = feed.latestKirby + SCAN_AHEAD;

  console.log(`\nStarting at ${feed.latestKirby}`);
  console.log(`Checking ${start} through ${end}`);

  for (let n = start; n <= end; n++) {
    const fileName = `${n}.jpg`;
    const filePath = path.join(IMAGES_DIR, fileName);
    const url = `${BASE_URL}/${n}.webp`;

    if (fs.existsSync(filePath)) {
      if (!isValidImage(filePath)) {
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

    await new Promise(resolve => setTimeout(resolve, 5000));

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
  feed.specials = [...new Set(feed.specials)].sort();

  saveFeed(feed);

  console.log("\n✨ Done.");
  console.log(feed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
