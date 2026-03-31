const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

const WIDTH = 480;
const HEIGHT = 800;

async function renderPNGBuffer(url) {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  // 🔥 render at 2x
  await page.setViewport({ width: WIDTH * 2, height: HEIGHT * 2, deviceScaleFactor: 1 });

  await page.goto(url, { waitUntil: "networkidle0" });

  await page.waitForFunction("window.__WF_READY__ === true");

  const buffer = await page.screenshot({ type: "png" });

  await browser.close();

  // 🔥 downsample to improve sharpness
  return downsample2x(buffer);
}

async function downsample2x(buffer) {
  return await sharp(buffer)
    .resize(WIDTH, HEIGHT, { kernel: sharp.kernel.nearest })
    .toBuffer();
}

async function pngToRaw1Bit(buffer) {
  const img = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const data = img.data;

  const raw = Buffer.alloc((WIDTH * HEIGHT) / 8);

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      let gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

      // 🔥 contrast boost
      gray = gray < 200 ? gray * 0.75 : gray;

      // 🔥 higher threshold for e-ink
      if (gray < 185) {
        raw[y * (WIDTH / 8) + Math.floor(x / 8)] |= (1 << (7 - (x % 8)));
      }
    }
  }

  return raw;
}

app.get("/img", async (req, res) => {
  const url = `http://localhost:${PORT}/view?${req.url.split("?")[1] || ""}`;
  const png = await renderPNGBuffer(url);
  res.set("Content-Type", "image/png");
  res.send(png);
});

app.get("/raw", async (req, res) => {
  const url = `http://localhost:${PORT}/view?${req.url.split("?")[1] || ""}`;
  const png = await renderPNGBuffer(url);
  const raw = await pngToRaw1Bit(png);

  res.set("Content-Type", "application/octet-stream");
  res.send(raw);
});

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "view_display_safe.html"));
});

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
