const express = require("express");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const { PNG } = require("pngjs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use("/public", express.static(path.join(__dirname, "public")));

function safe(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

const OUT_DIR = path.join(__dirname, "public", "renders");
fs.mkdirSync(OUT_DIR, { recursive: true });

const TTL = 30 * 60 * 1000; // 30 min

const IMG_W = 600;
const IMG_H = 800;
const RAW_SIZE = (IMG_W * IMG_H) / 8; // 60000 bytes

function pngPath(place, lang, mode) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}.png`);
}

function rawPath(place, lang, mode) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}.raw`);
}

function isFresh(file) {
  try {
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs < TTL;
  } catch {
    return false;
  }
}

async function renderPNGBuffer(place, lang, mode) {
  const url = `http://127.0.0.1:${PORT}/view?place=${place}&lang=${lang}&mode=${mode}&render=1&t=${Date.now()}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: IMG_W,
      height: IMG_H,
      deviceScaleFactor: 1
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForFunction(() => window.__WF_READY__ === true, { timeout: 90000 });

    const pngBuffer = await page.screenshot({
      type: "png"
    });

    return pngBuffer;
  } finally {
    await browser.close();
  }
}

function pngToRaw1Bit(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);

  if (png.width !== IMG_W || png.height !== IMG_H) {
    throw new Error(`Unexpected PNG size ${png.width}x${png.height}, expected ${IMG_W}x${IMG_H}`);
  }

  const raw = Buffer.alloc(RAW_SIZE, 0x00);

  // 1-bit packed, 1 = BLACK, 0 = WHITE
  // We threshold grayscale at 128
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];

      // alpha handling: transparent -> white
      let gray = 255;
      if (a > 0) {
        gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }

      const isBlack = gray < 128;

      const byteIndex = y * (IMG_W / 8) + Math.floor(x / 8);
      const bitIndex = 7 - (x % 8);

      if (isBlack) {
        raw[byteIndex] |= (1 << bitIndex);
      }
    }
  }

  return raw;
}

async function ensureRendered(place, lang, mode) {
  const pPng = pngPath(place, lang, mode);
  const pRaw = rawPath(place, lang, mode);

  if (isFresh(pPng) && isFresh(pRaw)) {
    return { png: pPng, raw: pRaw };
  }

  const pngBuffer = await renderPNGBuffer(place, lang, mode);

  fs.writeFileSync(pPng, pngBuffer);

  const rawBuffer = pngToRaw1Bit(pngBuffer);
  fs.writeFileSync(pRaw, rawBuffer);

  return { png: pPng, raw: pRaw };
}

app.get("/", (req, res) => {
  res.redirect("/view");
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "view.html"));
});

app.get("/render", async (req, res) => {
  const place = safe(req.query.place || "sauze");
  const lang = safe(req.query.lang || "it");
  const mode = safe(req.query.mode || "auto");

  try {
    const files = await ensureRendered(place, lang, mode);

    res.json({
      ok: true,
      png: `/public/renders/${path.basename(files.png)}`,
      raw: `/public/renders/${path.basename(files.raw)}`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.toString()
    });
  }
});

app.get("/img", async (req, res) => {
  const place = safe(req.query.place || "sauze");
  const lang = safe(req.query.lang || "it");
  const mode = safe(req.query.mode || "auto");

  try {
    const files = await ensureRendered(place, lang, mode);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(files.png).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("PNG render error");
  }
});

app.get("/raw", async (req, res) => {
  const place = safe(req.query.place || "sauze");
  const lang = safe(req.query.lang || "it");
  const mode = safe(req.query.mode || "auto");

  try {
    const files = await ensureRendered(place, lang, mode);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", RAW_SIZE);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(files.raw).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("RAW render error");
  }
});

app.listen(PORT, () => {
  console.log(`WeatherFrame running on port ${PORT}`);
});