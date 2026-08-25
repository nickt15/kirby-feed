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
const SPECIALS_PAGE =
  "https://codecraftsupport.com/Kirby/gallery_specials.html";

function loadFeed() {
  if (!fs.existsSync(FEED_PATH)) {
    return {
      latestKirby: 2800,
      kirbys: [],
      specials: []
    };
  }

  const feed = JSON.parse(
    fs.readFileSync(FEED_PATH, "utf8")
  );

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
  fs.writeFileSync(
    FEED_PATH,
    JSON.stringify(feed, null, 2)
  );
}

/*
 * Make sure the downloaded file is ACTUALLY an image.
 *
 * This prevents a 404 HTML page from being accepted
 * just because it is larger than 100 bytes.
 */
function isValidImage(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);

    if (buffer.length < 100) {
      return false;
    }

    /*
     * JPEG
     * FF D8 FF
     */
    const isJpeg =
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;

    /*
     * WEBP
     * RIFF....WEBP
     */
    const isWebp =
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";

    /*
     * PNG
     * 89 50 4E 47 0D 0A 1A 0A
     */
    const isPng =
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;

    return isJpeg || isWebp || isPng;
  } catch {
    return false;
  }
}

/*
 * Remove a Kirby number from latest.json.
 *
 * This is important if an old 404 page was previously
 * saved as something like images/3204.jpg.
 */
function removeKirbyFromFeed(feed, number) {
  const before = feed.kirbys.length;

  feed.kirbys = feed.kirbys.filter(
    kirby => Number(kirby) !== Number(number)
  );

  if (feed.kirbys.length !== before) {
    console.log(
      `🧹 Removed fake/missing Kirby ${number} from latest.json`
    );
  }
}

function downloadWithCurl(url, filePath) {
  try {
    execFileSync(
      "curl",
      [
        "-L",

        /*
         * IMPORTANT:
         *
         * --fail makes curl fail on HTTP errors such
         * as 404 instead of saving the 404 HTML page.
         */
        "--fail",

        "--http1.1",

        "--connect-timeout",
        "60",

        "--max-time",
        "300",

        "--retry",
        "0",

        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/91.0.4472.124 Safari/537.36",

        "-o",
        filePath,

        url
      ],
      {
        stdio: "inherit"
      }
    );

    if (!fs.existsSync(filePath)) {
      return false;
    }

    const size = fs.statSync(filePath).size;

    if (size < 100) {
      try {
        fs.unlinkSync(filePath);
      } catch {}

      console.log(
        `❌ Bad image size: ${path.basename(filePath)}`
      );

      return false;
    }

    /*
     * Even if curl says the request worked,
     * verify the downloaded bytes are an actual image.
     */
    if (!isValidImage(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}

      console.log(
        `❌ Not a real image, removed: ${path.basename(filePath)}`
      );

      return false;
    }

    console.log(
      `✅ Downloaded ${path.basename(filePath)} (${size} bytes)`
    );

    return true;
  } catch {
    /*
     * If curl made a partial/bad file before failing,
     * remove it.
     */
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    console.log(`❌ Not available: ${url}`);

    return false;
  }
}

async function scrapeSpecials() {
  try {
    console.log(
      "🔍 Scraping gallery_specials.html..."
    );

    const { data } = await axios.get(
      SPECIALS_PAGE,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/91.0.4472.124 Safari/537.36"
        },

        timeout: 10000
      }
    );

    const $ = cheerio.load(data);

    const specialUrls = new Set();

    /*
     * METHOD 1
     *
     * Find actual JPG/JPEG/WEBP links
     * inside href or src attributes.
     */
    $("[href], [src]").each((_, elem) => {
      const href = $(elem).attr("href");
      const src = $(elem).attr("src");

      for (let url of [href, src]) {
        if (!url) {
          continue;
        }

        if (
          /\.(?:jpe?g|webp)(\?|$)/i.test(url)
        ) {
          url = new URL(
            url,
            SPECIALS_PAGE
          ).href;

          specialUrls.add(url);
        }
      }
    });

    /*
     * METHOD 2
     *
     * Find Kirby numbers written on the page.
     *
     * Examples:
     *
     * Kirby #20181201
     * Kirby 20250428
     */
    const pageText = $.text();

    const matches = pageText.matchAll(
      /Kirby\s*#?\s*(\d{4,})/gi
    );

    for (const match of matches) {
      const number = match[1];

      specialUrls.add(
        `${BASE_URL}/${number}.webp`
      );
    }

    console.log(
      `Found ${specialUrls.size} special Kirby URLs`
    );

    for (const url of specialUrls) {
      console.log(
        `Special found: ${url}`
      );
    }

    return [...specialUrls];
  } catch (err) {
    console.log(
      `⚠️ Failed to scrape specials page: ${err.message}`
    );

    return [];
  }
}

async function downloadSpecials(feed) {
  const specialUrls =
    await scrapeSpecials();

  if (specialUrls.length === 0) {
    console.log(
      "ℹ️ No special Kirbys found"
    );

    return;
  }

  if (!fs.existsSync(SPECIALS_DIR)) {
    fs.mkdirSync(
      SPECIALS_DIR,
      {
        recursive: true
      }
    );
  }

  for (const url of specialUrls) {
    const fileName = url
      .split("/")
      .pop()
      .split("?")[0];

    /*
     * Keep your existing naming setup.
     *
     * WEBP/JPEG files are stored using
     * a .jpg filename in the repository.
     */
    const jpgFileName =
      fileName.replace(
        /\.(webp|jpeg?)$/i,
        ".jpg"
      );

    const filePath = path.join(
      SPECIALS_DIR,
      jpgFileName
    );

    if (
      !fileName
        .toLowerCase()
        .endsWith(".jpg") &&
      !fileName
        .toLowerCase()
        .endsWith(".jpeg") &&
      !fileName
        .toLowerCase()
        .endsWith(".webp")
    ) {
      continue;
    }

    /*
     * Already downloaded.
     */
    if (fs.existsSync(filePath)) {
      if (isValidImage(filePath)) {
        console.log(
          `Already have special ${jpgFileName}`
        );

        if (
          !feed.specials.includes(
            jpgFileName
          )
        ) {
          feed.specials.push(
            jpgFileName
          );
        }

        continue;
      }

      /*
       * Existing file is actually HTML,
       * broken, or otherwise invalid.
       */
      try {
        fs.unlinkSync(filePath);
      } catch {}

      feed.specials =
        feed.specials.filter(
          special =>
            special !== jpgFileName
        );

      console.log(
        `❌ Removed bad cached special: ${jpgFileName}`
      );
    }

    console.log(
      `Downloading special: ${jpgFileName}`
    );

    const ok = downloadWithCurl(
      url,
      filePath
    );

    /*
     * Keep the existing delay so the
     * source website isn't hammered.
     */
    await new Promise(resolve =>
      setTimeout(resolve, 5000)
    );

    if (
      ok &&
      !feed.specials.includes(
        jpgFileName
      )
    ) {
      feed.specials.push(
        jpgFileName
      );
    }
  }
}

async function main() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(
      IMAGES_DIR,
      {
        recursive: true
      }
    );
  }

  if (!fs.existsSync(SPECIALS_DIR)) {
    fs.mkdirSync(
      SPECIALS_DIR,
      {
        recursive: true
      }
    );
  }

  const feed = loadFeed();

  /*
   * SPECIAL KIRBYS
   */
  await downloadSpecials(feed);

  /*
   * Use the current latest number only to determine
   * what area we need to scan.
   *
   * We DO NOT permanently trust latestKirby anymore,
   * because previous runs may have accidentally set it
   * to a fake future Kirby such as 3208.
   */
  const oldLatestKirby =
    feed.latestKirby;

  const start = Math.max(
    1,
    oldLatestKirby - BACKFILL_BEHIND
  );

  const end =
    oldLatestKirby + SCAN_AHEAD;

  console.log(
    `\nStarting at ${oldLatestKirby}`
  );

  console.log(
    `Checking ${start} through ${end}`
  );

  for (
    let n = start;
    n <= end;
    n++
  ) {
    const fileName =
      `${n}.jpg`;

    const filePath =
      path.join(
        IMAGES_DIR,
        fileName
      );

    const url =
      `${BASE_URL}/${n}.webp`;

    /*
     * If we already have this file,
     * make sure it is a REAL image.
     */
    if (
      fs.existsSync(filePath)
    ) {
      if (
        !isValidImage(filePath)
      ) {
        /*
         * This catches the old fake
         * 404 .jpg files.
         */
        try {
          fs.unlinkSync(filePath);
        } catch {}

        console.log(
          `🧹 Removed bad cached file: ${fileName}`
        );

        /*
         * Also remove the number from
         * latest.json.
         */
        removeKirbyFromFeed(
          feed,
          n
        );
      } else {
        console.log(
          `Already have ${fileName}`
        );

        if (
          !feed.kirbys.includes(n)
        ) {
          feed.kirbys.push(n);
        }

        continue;
      }
    }

    console.log(
      `Checking Kirby ${n}`
    );

    const ok =
      downloadWithCurl(
        url,
        filePath
      );

    /*
     * Wait 5 seconds between requests.
     */
    await new Promise(resolve =>
      setTimeout(resolve, 5000)
    );

    /*
     * 404 / bad file / failed download.
     *
     * Do NOT add it to latest.json.
     */
    if (!ok) {
      continue;
    }

    if (
      !feed.kirbys.includes(n)
    ) {
      feed.kirbys.push(n);
    }
  }

  /*
   * Remove duplicates and sort.
   */
  feed.kirbys = [
    ...new Set(
      feed.kirbys.map(Number)
    )
  ]
    .filter(
      number =>
        Number.isFinite(number)
    )
    .sort(
      (a, b) => a - b
    );

  feed.specials = [
    ...new Set(
      feed.specials
    )
  ].sort();

  /*
   * IMPORTANT FIX:
   *
   * Recalculate latestKirby using the actual
   * valid Kirby list.
   *
   * So if 3201-3208 were fake 404 files and
   * Kirby 3200 is the real latest one:
   *
   * latestKirby becomes 3200 again.
   */
  if (
    feed.kirbys.length > 0
  ) {
    feed.latestKirby =
      Math.max(
        ...feed.kirbys
      );
  } else {
    feed.latestKirby = 2800;
  }

  feed.updatedAt =
    new Date().toISOString();

  saveFeed(feed);

  console.log(
    "\n✨ Done."
  );

  console.log(
    `Latest REAL Kirby: ${feed.latestKirby}`
  );

  console.log(feed);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
