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

// ── Supported display profiles ──────────────────────────────────────────────
const PROFILES = {
  inkplate6: { w: 600, h: 800 }, // Inkplate 6  (portrait)
  waveshare75: { w: 480, h: 800 }, // Waveshare 7.5" V2 (portrait, wider)
};
const DEFAULT_PROFILE = "inkplate6";

function getProfile(profileKey) {
  return PROFILES[profileKey] || PROFILES[DEFAULT_PROFILE];
}
// ────────────────────────────────────────────────────────────────────────────

function pngPath(place, lang, mode, profile) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}_${profile}.png`);
}

function rawPath(place, lang, mode, profile) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}_${profile}.raw`);
}

function isFresh(file) {
  try {
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs < TTL;
  } catch {
    return false;
  }
}

async function renderPNGBuffer(place, lang, mode, profile) {
  const { w, h } = getProfile(profile);

  // Pass profile to the view so the HTML/CSS can adapt if needed
  const url = `http://127.0.0.1:${PORT}/view?place=${place}&lang=${lang}&mode=${mode}&profile=${profile}&render=1&t=${Date.now()}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  try {
    const page = await browser.newPage();

    page.on("console", msg => console.log("[PAGE]", msg.text()));
    page.on("pageerror", err => console.error("[PAGEERROR]", err.message));

    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    await page.waitForSelector("#title", { timeout: 30000 });

    await page.waitForFunction(
      () => window.__WF_READY__ === true,
      { timeout: 60000 }
    );

    await new Promise(r => setTimeout(r, 1200));

    const pngBuffer = await page.screenshot({ type: "png" });
    return pngBuffer;
  } finally {
    await browser.close();
  }
}

function pngToRaw1Bit(pngBuffer, profile) {
  const { w: IMG_W, h: IMG_H } = getProfile(profile);
  const RAW_SIZE = (IMG_W * IMG_H) / 8;

  const png = PNG.sync.read(pngBuffer);

  if (png.width !== IMG_W || png.height !== IMG_H) {
    throw new Error(`Unexpected PNG size ${png.width}x${png.height}, expected ${IMG_W}x${IMG_H}`);
  }

  const raw = Buffer.alloc(RAW_SIZE, 0x00);

  // 1-bit packed, 1 = BLACK, 0 = WHITE — threshold at 128
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];

      let gray = 255; // transparent → white
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

async function ensureRendered(place, lang, mode, profile) {
  const pPng = pngPath(place, lang, mode, profile);
  const pRaw = rawPath(place, lang, mode, profile);

  if (isFresh(pPng) && isFresh(pRaw)) {
    return { png: pPng, raw: pRaw };
  }

  const pngBuffer = await renderPNGBuffer(place, lang, mode, profile);

  fs.writeFileSync(pPng, pngBuffer);

  const rawBuffer = pngToRaw1Bit(pngBuffer, profile);
  fs.writeFileSync(pRaw, rawBuffer);

  return { png: pPng, raw: pRaw };
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.redirect("/view");
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "view.html"));
});

app.get("/mobile", (req, res) => {
  res.sendFile(path.join(__dirname, "mobile-light.html"));
});

app.get("/render", async (req, res) => {
  const place   = safe(req.query.place   || "sauze");
  const lang    = safe(req.query.lang    || "it");
  const mode    = safe(req.query.mode    || "auto");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);

  try {
    const files = await ensureRendered(place, lang, mode, profile);
    const { w, h } = getProfile(profile);

    res.json({
      ok: true,
      profile,
      width: w,
      height: h,
      png: `/public/renders/${path.basename(files.png)}`,
      raw: `/public/renders/${path.basename(files.raw)}`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.toString() });
  }
});

app.get("/img", async (req, res) => {
  const place   = safe(req.query.place   || "sauze");
  const lang    = safe(req.query.lang    || "it");
  const mode    = safe(req.query.mode    || "auto");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);

  try {
    const files = await ensureRendered(place, lang, mode, profile);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(files.png).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("PNG render error");
  }
});

app.get("/raw", async (req, res) => {
  const place   = safe(req.query.place   || "sauze");
  const lang    = safe(req.query.lang    || "it");
  const mode    = safe(req.query.mode    || "auto");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);

  const { w, h } = getProfile(profile);
  const RAW_SIZE = (w * h) / 8;

  try {
    const files = await ensureRendered(place, lang, mode, profile);
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
