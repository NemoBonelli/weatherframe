const express = require("express");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const { PNG } = require("pngjs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const JWT_SECRET = process.env.JWT_SECRET || "wf-dev-secret-change-in-production";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "superadmin2025";

// Downscale 2x PNG to target size using box filter (average 2×2 pixels)
// This gives much sharper text than rendering at 1x
function downsample2x(pngBuffer, targetW, targetH) {
  const src = PNG.sync.read(pngBuffer);
  const dst = new PNG({ width: targetW, height: targetH });
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      let r=0, g=0, b=0, a=0;
      for (let dy=0; dy<2; dy++) for (let dx=0; dx<2; dx++) {
        const si = ((y*2+dy)*src.width + (x*2+dx)) * 4;
        r += src.data[si]; g += src.data[si+1];
        b += src.data[si+2]; a += src.data[si+3];
      }
      const di = (y*targetW + x) * 4;
      dst.data[di]=r/4; dst.data[di+1]=g/4;
      dst.data[di+2]=b/4; dst.data[di+3]=a/4;
    }
  }
  return PNG.sync.write(dst);
}

// ── Open-Meteo fetch (server-side, with cache) ───────────────
const WEATHER_CACHE = {};
const WEATHER_TTL   = 55 * 60 * 1000; // 55 min
const WEATHERAPI_KEY = "5b14deeb26e5493f9ee211416262003";

const PLACES = {
  sauze:        { lat:44.9408, lon:6.8614, town:1509, lifts:2300 },
  sestriere:    { lat:44.9570, lon:6.8789, town:2035, lifts:2700 },
  sansicario:   { lat:44.9810, lon:6.8040, town:1700, lifts:2550 },
  cesana:       { lat:44.9543, lon:6.7923, town:1354, lifts:2300 },
  claviere:     { lat:44.9369, lon:6.6615, town:1766, lifts:2500 },
  monginevro:   { lat:44.9319, lon:6.7209, town:1860, lifts:2700 },
  bardonecchia: { lat:45.0760, lon:6.7030, town:1312, lifts:2400 },
  oulx:         { lat:45.0333, lon:6.8333, town:1100, lifts:2550 },
  pragelato:    { lat:45.0173, lon:6.9422, town:1518, lifts:2500 },
  sanmarco:     { lat:45.0444, lon:6.7917, town:1212, lifts:2550 },
};

// ── WeatherAPI.com fetch ─────────────────────────────────────────
// Converte risposta WeatherAPI nel formato Open-Meteo usato da view.html
async function fetchWeatherAPI(lat, lon) {
  const key = `${lat},${lon}`;
  const cached = WEATHER_CACHE[key];
  if (cached && Date.now() - cached.ts < WEATHER_TTL) {
    console.log(`[WX] Cache hit for ${key}`);
    return cached.data;
  }

  const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHERAPI_KEY}&q=${lat},${lon}&days=7&aqi=no&alerts=no`;
  console.log(`[WX] Fetching WeatherAPI for ${key}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`WeatherAPI HTTP ${r.status}`);
  const raw = await r.json();

  // Converti in formato compatibile con view.html (Open-Meteo style)
  const data = convertWeatherAPI(raw);
  WEATHER_CACHE[key] = { data, ts: Date.now() };
  console.log(`[WX] WeatherAPI OK for ${key}`);
  return data;
}

function convertWeatherAPI(raw) {
  // Mappa i condition codes di WeatherAPI ai WMO codes di Open-Meteo
  function toWMO(code, isDay) {
    if (code === 1000) return isDay ? 0 : 0;           // Sunny/Clear
    if (code === 1003) return 2;                        // Partly cloudy
    if ([1006,1009].includes(code)) return 3;           // Cloudy/Overcast
    if ([1030,1135,1147].includes(code)) return 45;     // Fog/Mist
    if ([1063,1180,1183,1186,1189,1192,1195,1240,1243,1246].includes(code)) return 61; // Rain
    if ([1066,1114,1117,1210,1213,1216,1219,1222,1225,1255,1258].includes(code)) return 71; // Snow
    if ([1069,1204,1207,1249,1252].includes(code)) return 77; // Sleet
    if ([1087,1273,1276,1279,1282].includes(code)) return 95; // Thunder
    if ([1072,1150,1153,1168,1171].includes(code)) return 51; // Drizzle
    return 2;
  }

  const current = raw.current;
  const forecast = raw.forecast.forecastday;

  // Build hourly arrays from forecast days
  const hourlyTime = [], hourlyTemp = [], hourlyCode = [], hourlyPrec = [], hourlyWind = [];
  for (const day of forecast) {
    for (const h of day.hour) {
      hourlyTime.push(h.time.replace(" ", "T"));
      hourlyTemp.push(h.temp_c);
      hourlyCode.push(toWMO(h.condition.code, h.is_day));
      hourlyPrec.push(h.precip_mm);
      hourlyWind.push(h.wind_kph);
    }
  }

  // Build daily arrays
  const dailyTime = [], dailyCodeArr = [], dailyMin = [], dailyMax = [], dailyPrec = [];
  for (const day of forecast) {
    dailyTime.push(day.date);
    dailyCodeArr.push(toWMO(day.day.condition.code, 1));
    dailyMin.push(day.day.mintemp_c);
    dailyMax.push(day.day.maxtemp_c);
    dailyPrec.push(day.day.totalprecip_mm);
  }

  return {
    current: {
      temperature_2m:  current.temp_c,
      weather_code:    toWMO(current.condition.code, current.is_day),
      precipitation:   current.precip_mm,
      wind_speed_10m:  current.wind_kph
    },
    hourly: {
      time:              hourlyTime,
      temperature_2m:    hourlyTemp,
      weather_code:      hourlyCode,
      precipitation:     hourlyPrec,
      wind_speed_10m:    hourlyWind
    },
    daily: {
      time:                    dailyTime,
      weather_code:            dailyCodeArr,
      temperature_2m_min:      dailyMin,
      temperature_2m_max:      dailyMax,
      precipitation_sum:       dailyPrec
    }
  };
}

async function fetchWeatherForPlace(placeKey) {
  const p = PLACES[placeKey] || PLACES.sauze;
  const vF = await fetchWeatherAPI(p.lat, p.lon);
  await new Promise(r => setTimeout(r, 500));
  const lF = adjustForElevation(vF, p.lifts - p.town);
  // Ski status — non bloccante, non blocca il render se fallisce
  const ski = await getSkiStatus(placeKey, lF).catch(() => ({ status: "unknown", source: "error" }));
  return { village: vF, lifts: lF, ski };
}

function adjustForElevation(data, elevDiff) {
  // Lapse rate: ~0.6°C per 100m di salita
  const tempOffset = -(elevDiff / 100) * 0.6;
  return {
    current: {
      ...data.current,
      temperature_2m: data.current.temperature_2m + tempOffset
    },
    hourly: {
      ...data.hourly,
      temperature_2m: data.hourly.temperature_2m.map(t => t + tempOffset)
    },
    daily: {
      ...data.daily,
      temperature_2m_min: data.daily.temperature_2m_min.map(t => t + tempOffset),
      temperature_2m_max: data.daily.temperature_2m_max.map(t => t + tempOffset)
    }
  };
}


// ── SKI STATUS — Skiinfo scraping + meteo fallback ───────────
const SKI_CACHE = {};
const SKI_TTL = 15 * 60 * 1000; // 15 min

async function fetchSkiinfoStatus(placeKey) {
  const urls = {
    sauze:        "https://www.skiinfo.it/piemonte/sauze-doulx/bollettino-neve.html",
    sestriere:    "https://www.skiinfo.it/piemonte/sestriere/bollettino-neve.html",
    sansicario:   "https://www.skiinfo.it/piemonte/sansicario/bollettino-neve.html",
    bardonecchia: "https://www.skiinfo.it/piemonte/bardonecchia/bollettino-neve.html",
    claviere:     "https://www.skiinfo.it/piemonte/claviere/bollettino-neve.html",
    cesana:       "https://www.skiinfo.it/piemonte/cesana-sansicario/bollettino-neve.html",
  };
  const url = urls[placeKey] || urls.sauze;

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 WeatherFrame/1.0" },
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) throw new Error(`Skiinfo HTTP ${resp.status}`);
  const html = await resp.text();

  // Extract lifts open/total
  const liftsM  = html.match(/(\d+)\s*\/\s*(\d+)\s*impianti/i)
                || html.match(/impianti\D{0,30}(\d+)\D{0,10}\/\D{0,10}(\d+)/i);
  const slopesM = html.match(/(\d+)\s*\/\s*(\d+)\s*piste/i)
                || html.match(/piste\D{0,30}(\d+)\D{0,10}\/\D{0,10}(\d+)/i);
  const snowM   = html.match(/(\d+)\s*cm/i);

  const liftsOpen   = liftsM  ? parseInt(liftsM[1])  : null;
  const liftsTotal  = liftsM  ? parseInt(liftsM[2])  : null;
  const slopesOpen  = slopesM ? parseInt(slopesM[1]) : null;
  const slopesTotal = slopesM ? parseInt(slopesM[2]) : null;
  const snowCm      = snowM   ? parseInt(snowM[1])   : null;

  let status = "unknown";
  if (liftsOpen != null && liftsTotal != null && liftsTotal > 0) {
    const pct = liftsOpen / liftsTotal;
    if (pct === 0) status = "closed";
    else if (pct < 0.35) status = "limited";
    else if (pct < 0.75) status = "partial";
    else status = "open";
  }

  return { status, lifts_open: liftsOpen, lifts_total: liftsTotal,
           slopes_open: slopesOpen, slopes_total: slopesTotal,
           snow_cm: snowCm, source: "skiinfo" };
}

function skiStatusFromWeather(liftWeather) {
  if (!liftWeather) return { status: "unknown", source: "model" };
  const wind  = liftWeather.current?.wind_speed_10m ?? 0;
  const month = new Date().getMonth() + 1;
  let status = "unknown";
  if (month >= 5 && month <= 11) status = "closed";
  else if (wind > 60) status = "closed";
  else if (wind > 35) status = "limited";
  else status = "open";
  return { status, source: "model" };
}

async function getSkiStatus(placeKey, liftWeather) {
  const cached = SKI_CACHE[placeKey];
  if (cached && Date.now() - cached.ts < SKI_TTL) {
    console.log(`[SKI] Cache hit for ${placeKey}`);
    return cached.data;
  }
  let data;
  try {
    console.log(`[SKI] Fetching Skiinfo for ${placeKey}...`);
    data = await fetchSkiinfoStatus(placeKey);
    console.log(`[SKI] ${placeKey}: ${data.status} (${data.lifts_open}/${data.lifts_total})`);
  } catch(e) {
    console.warn(`[SKI] Skiinfo failed: ${e.message} — using model`);
    data = skiStatusFromWeather(liftWeather);
  }
  SKI_CACHE[placeKey] = { data, ts: Date.now() };
  return data;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use("/public", express.static(path.join(__dirname, "public")));

function safe(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

// ── Directories ──────────────────────────────────────────────
const OUT_DIR = path.join(__dirname, "public", "renders");
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const FIRMWARE_DIR = path.join(__dirname, "public", "firmware");
fs.mkdirSync(FIRMWARE_DIR, { recursive: true });

// firmware/version.json structure:
// { "inkplate6": { "version": "1.0.2", "url": "https://weatherframe.onrender.com/public/firmware/inkplate6_1.0.2.bin" } }
const FIRMWARE_VERSION_FILE = path.join(FIRMWARE_DIR, "version.json");
function loadFirmwareVersions() {
  try { return JSON.parse(fs.readFileSync(FIRMWARE_VERSION_FILE, "utf8")); }
  catch { return {}; }
}
function saveFirmwareVersions(v) {
  fs.writeFileSync(FIRMWARE_VERSION_FILE, JSON.stringify(v, null, 2));
}

// ── Display profiles ─────────────────────────────────────────
const PROFILES = {
  inkplate6:   { w: 600, h: 800 },
  waveshare75: { w: 480, h: 800 },
};
const DEFAULT_PROFILE = "inkplate6";
function getProfile(k) { return PROFILES[k] || PROFILES[DEFAULT_PROFILE]; }

// ── Devices store ─────────────────────────────────────────────
// Saved to data/devices.json
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
function loadDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")); }
  catch { return {}; }
}
function saveDevices(d) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(d, null, 2));
}

// ── Users store ───────────────────────────────────────────────
const USERS_FILE = path.join(DATA_DIR, "users.json");
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch { return {}; }
}
function saveUsers(u) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
}

// ── Auth helpers ─────────────────────────────────────────────
function generateUserId() {
  return "usr_" + Math.random().toString(36).substr(2, 9);
}

function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.wf_token;
  if (!token) return res.redirect("/login");
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie("wf_token");
    res.redirect("/login");
  }
}

function requireSuperAdmin(req, res, next) {
  const token = req.cookies?.wf_super_token;
  if (!token) return res.redirect("/superadmin/login");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.superadmin) return res.redirect("/superadmin/login");
    req.superadmin = true;
    next();
  } catch {
    res.clearCookie("wf_super_token");
    res.redirect("/superadmin/login");
  }
}

// Filter devices by owner
function getDevicesForUser(userId) {
  const all = loadDevices();
  return Object.fromEntries(
    Object.entries(all).filter(([,d]) => d.owner === userId)
  );
}

// ── Welcome store ─────────────────────────────────────────────
const WELCOME_FILE = path.join(DATA_DIR, "welcome.json");
function loadWelcome() {
  try { return JSON.parse(fs.readFileSync(WELCOME_FILE, "utf8")); }
  catch { return {}; }
}
function saveWelcome(d) {
  fs.writeFileSync(WELCOME_FILE, JSON.stringify(d, null, 2));
}

// ── Cache helpers ─────────────────────────────────────────────
// Smart cache: TTL 60 min, but can be invalidated per device
const TTL = 60 * 60 * 1000; // 60 min

function pngPath(place, lang, mode, profile) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}_${profile}.png`);
}
function jpgPath(place, lang, mode, profile) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}_${profile}.jpg`);
}
function rawPath(place, lang, mode, profile) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}_${profile}.raw`);
}
function isFresh(file, ttl = TTL) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < ttl;
  } catch { return false; }
}
function invalidateCache(place, lang, profile) {
  // Touch file mtime to epoch to force re-render
  ["oggi","domani","auto"].forEach(mode => {
    [pngPath(place,lang,mode,profile), rawPath(place,lang,mode,profile)].forEach(f => {
      try { fs.utimesSync(f, new Date(0), new Date(0)); } catch {}
    });
  });
}

// ── Puppeteer render ─────────────────────────────────────────
async function renderPNGBuffer(place, lang, mode, profile, welcomeData = null, format = "png") {
  const { w, h } = getProfile(profile);

  // ── Fetch weather SERVER-SIDE (cached) — Puppeteer gets static JSON ──
  // This avoids 429 from Open-Meteo and 404 on Google Fonts inside headless Chrome
  let weatherJson = "null";
  if (!welcomeData) {
    try {
      const wx = await fetchWeatherForPlace(place);
      weatherJson = JSON.stringify(wx);
      console.log("[WX] Weather ready for", place);
    } catch(e) {
      console.error("[WX] Fetch failed:", e.message);
    }
  }

  // Stagione: per display fisici sempre winter (auto da mese), solo preview browser può cambiare
  const month = new Date().getMonth() + 1;
  const season = (month >= 6 && month <= 9) ? "summer" : "winter";
  let url = `http://127.0.0.1:${PORT}/view?place=${place}&lang=${lang}&mode=${mode}&profile=${profile}&season=${season}&render=1&t=${Date.now()}`;
  if (welcomeData) {
    url += `&welcome=1&guestName=${encodeURIComponent(welcomeData.guestName || "")}&wifiSsid=${encodeURIComponent(welcomeData.wifiSsid || "")}&wifiPass=${encodeURIComponent(welcomeData.wifiPass || "")}`;
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"]
  });
  try {
    const page = await browser.newPage();
    page.on("console", msg => console.log("[PAGE]", msg.text()));
    page.on("pageerror", err => console.error("[PAGEERROR]", err.message));

    // Block all external requests — weather data is already injected,
    // fonts/QR/APIs from internet would cause 404/429 in headless Chrome
    await page.setRequestInterception(true);
    page.on("request", req => {
      const url = req.url();
      // Allow localhost + cdnjs for QR library
      if (url.startsWith("http://127.0.0.1") || 
          url.startsWith("http://localhost") ||
          url.includes("cdnjs.cloudflare.com")) {
        req.continue();
      } else {
        req.abort();
      }
    });

    // Inject weather data + welcome QR data
    const qrData = welcomeData ? `WIFI:T:WPA;S:${welcomeData.wifiSsid || ""};P:${welcomeData.wifiPass || ""};;` : null;
    await page.evaluateOnNewDocument((json, qr) => {
      window.__WF_WEATHER__ = json ? JSON.parse(json) : null;
      window.__WF_QR__ = qr; // WiFi QR string for welcome screen
    }, weatherJson, qrData);

    // Render a 2x per testo più nitido, poi downsample a 1x
    await page.setViewport({ width: w * 2, height: h * 2, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    const isWelcome = url.includes("welcome=1");
    await page.waitForSelector(isWelcome ? "#wlFooter" : "#title", { timeout: 30000 });
    await page.waitForFunction(() => window.__WF_READY__ === true, { timeout: 60000 });
    await new Promise(r => setTimeout(r, 800));

    if (format === "jpeg") {
      // Per JPEG (Inkplate) renderizza a 1x direttamente — il 3-bit gestisce la scala
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__WF_READY__ === true, { timeout: 60000 });
      await new Promise(r => setTimeout(r, 500));
      return await page.screenshot({ type: "jpeg", quality: 92 });
    } else {
      // Per PNG/RAW (Waveshare) usa 2x con downsample
      const raw2x = await page.screenshot({ type: "png" });
      return downsample2x(raw2x, w, h);
    }
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
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx], g = png.data[idx+1], b = png.data[idx+2], a = png.data[idx+3];
      let gray = 255;
      if (a > 0) gray = Math.round(0.299*r + 0.587*g + 0.114*b);
      if (gray < 110) {
        raw[y*(IMG_W/8) + Math.floor(x/8)] |= (1 << (7-(x%8)));
      }
    }
  }
  return raw;
}

function hasFile(file) {
  try { return fs.existsSync(file) && fs.statSync(file).size > 0; }
  catch { return false; }
}

async function ensureRendered(place, lang, mode, profile) {
  const pPng = pngPath(place, lang, mode, profile);
  const pRaw = rawPath(place, lang, mode, profile);
  const pJpg = jpgPath(place, lang, mode, profile);

  const freshPng = isFresh(pPng);
  const freshRaw = isFresh(pRaw);
  const freshJpg = isFresh(pJpg);

  if (freshPng && freshRaw && freshJpg) {
    return { png: pPng, raw: pRaw, jpg: pJpg, stale: false };
  }

  try {
    const pngBuffer = await renderPNGBuffer(place, lang, mode, profile);
    fs.writeFileSync(pPng, pngBuffer);
    fs.writeFileSync(pRaw, pngToRaw1Bit(pngBuffer, profile));

    // Genera anche JPEG per Inkplate (supporta JPEG da URL, non PNG)
    const jpgBuffer = await renderJpgBuffer(place, lang, mode, profile);
    fs.writeFileSync(pJpg, jpgBuffer);

    return { png: pPng, raw: pRaw, jpg: pJpg, stale: false };
  } catch (err) {
    const hasPng = hasFile(pPng);
    const hasRaw = hasFile(pRaw);
    const hasJpg = hasFile(pJpg);

    if (hasPng && hasRaw) {
      console.warn(`[RENDER] Using stale cached render for ${place}/${lang}/${mode}/${profile}: ${err.message}`);
      return { png: pPng, raw: pRaw, jpg: hasJpg ? pJpg : null, stale: true };
    }

    throw err;
  }
}

async function renderJpgBuffer(place, lang, mode, profile) {
  // Riusa renderPNGBuffer ma con screenshot JPEG
  return await renderPNGBuffer(place, lang, mode, profile, null, "jpeg");
}

// ── Welcome screen helpers ────────────────────────────────────
function isWelcomeActive(deviceId) {
  const welcome = loadWelcome();
  const w = welcome[deviceId];
  if (!w || !w.arrivalDate) return null;
  const now = new Date();
  const arrival = new Date(w.arrivalDate);
  const midnight = new Date(arrival);
  midnight.setHours(23, 59, 59, 999);
  if (now >= arrival && now <= midnight) return w;
  return null;
}

// ── Routes ───────────────────────────────────────────────────

app.get("/", (req, res) => res.redirect("/view"));

app.get("/view", (req, res) => res.sendFile(path.join(__dirname, "view.html")));
app.get("/mobile", (req, res) => res.sendFile(path.join(__dirname, "mobile-light.html")));

// ── Device registration ───────────────────────────────────────
// Called by ESP32 at boot: GET /register?id=AA:BB:CC:DD:EE:FF&profile=waveshare75
app.get("/register", (req, res) => {
  const id      = safe(req.query.id || "unknown");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);
  const devices = loadDevices();

  if (!devices[id]) {
    devices[id] = {
      id, profile,
      owner: null,  // assigned by superadmin or claimed by user
      place: "sauze", lang: "it",
      label: `Display ${Object.keys(devices).length + 1}`,
      registeredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
  } else {
    devices[id].lastSeen = new Date().toISOString();
    devices[id].profile = profile;
  }
  saveDevices(devices);
  console.log(`[REG] Device ${id} registered`);
  res.json({ ok: true, device: devices[id] });
});

// ── Device settings ───────────────────────────────────────────
// Called by ESP32 at every wake: GET /settings?id=AA:BB:CC
app.get("/settings", (req, res) => {
  const id = safe(req.query.id || "");
  const devices = loadDevices();
  const device = devices[id];

  if (!device) {
    return res.json({ ok: false, error: "unknown device" });
  }

  // Update last seen
  device.lastSeen = new Date().toISOString();
  saveDevices(devices);

  // Check if welcome screen is active
  const welcome = isWelcomeActive(id);

  res.json({
    ok: true,
    place:   device.place   || "sauze",
    lang:    device.lang    || "it",
    profile: device.profile || DEFAULT_PROFILE,
    welcome: welcome ? {
      active:    true,
      guestName: welcome.guestName || "",
      wifiSsid:  welcome.wifiSsid  || "",
      wifiPass:  welcome.wifiPass  || ""
    } : { active: false }
  });
});

// ── Welcome JPG endpoint for Inkplate ────────────────────────
app.get("/welcome-jpg", async (req, res) => {
  const profile    = safe(req.query.profile   || DEFAULT_PROFILE);
  const place      = safe(req.query.place     || "sauze");
  const lang       = safe(req.query.lang      || "it");
  const guestName  = req.query.guestName      || "";
  const wifiSsid   = req.query.wifiSsid       || "";
  const wifiPass   = req.query.wifiPass       || "";
  const deviceId   = safe(req.query.id        || "");

  const cacheKey = `welcome_${deviceId}_${profile}`;
  const pJpg = path.join(OUT_DIR, `${cacheKey}.jpg`);

  try {
    if (!isFresh(pJpg, 60*60*1000)) {
      const jpgBuffer = await renderPNGBuffer(place, lang, "auto", profile,
        { guestName, wifiSsid, wifiPass }, "jpeg");
      fs.writeFileSync(pJpg, jpgBuffer);
    }
    const stat = fs.statSync(pJpg);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(pJpg).pipe(res);
  } catch(e) {
    console.error(e);
    res.status(500).send("Welcome JPEG error");
  }
});

// ── Welcome RAW endpoint for Waveshare ───────────────────────
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
    res.setHeader("X-WeatherFrame-Stale", files.stale ? "1" : "0");
    fs.createReadStream(files.raw).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("RAW render error");
  }
});

app.get("/img", async (req, res) => {
  const place   = safe(req.query.place   || "sauze");
  const lang    = safe(req.query.lang    || "it");
  const mode    = safe(req.query.mode    || "auto");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);
  try {
    const files = await ensureRendered(place, lang, mode, profile);
    const stat = fs.statSync(files.png);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-WeatherFrame-Stale", files.stale ? "1" : "0");
    fs.createReadStream(files.png).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("PNG render error");
  }
});

// ── JPEG endpoint for Inkplate (supports JPEG from URL, not PNG) ──
app.get("/jpg", async (req, res) => {
  const place   = safe(req.query.place   || "sauze");
  const lang    = safe(req.query.lang    || "it");
  const mode    = safe(req.query.mode    || "auto");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);
  try {
    const files = await ensureRendered(place, lang, mode, profile);
    const jpgFile = files.jpg || jpgPath(place, lang, mode, profile);
    const stat = fs.statSync(jpgFile);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-WeatherFrame-Stale", files.stale ? "1" : "0");
    fs.createReadStream(jpgFile).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("JPEG render error");
  }
});

app.get("/render", async (req, res) => {
  const place   = safe(req.query.place   || "sauze");
  const lang    = safe(req.query.lang    || "it");
  const mode    = safe(req.query.mode    || "auto");
  const profile = safe(req.query.profile || DEFAULT_PROFILE);
  try {
    const files = await ensureRendered(place, lang, mode, profile);
    const { w, h } = getProfile(profile);
    res.json({ ok:true, profile, width:w, height:h,
      png: `/public/renders/${path.basename(files.png)}`,
      raw: `/public/renders/${path.basename(files.raw)}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.toString() });
  }
});

// ── Admin API ─────────────────────────────────────────────────

// GET /admin/devices — list all devices
app.get("/admin/devices", (req, res) => {
  res.json(loadDevices());
});

// ── Auth routes ──────────────────────────────────────────────

// GET /login
app.get("/login", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeatherFrame — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,Arial,sans-serif;background:#f5f5f3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:#fff;border-radius:20px;padding:36px 28px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08);}
  h1{font-size:26px;font-weight:900;letter-spacing:-0.5px;margin-bottom:4px;}
  .sub{font-size:13px;color:#888;margin-bottom:28px;}
  label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:4px;margin-top:18px;}
  input{width:100%;padding:12px;font-size:16px;border:1.5px solid #ddd;border-radius:10px;}
  input:focus{outline:none;border-color:#111;}
  button{margin-top:24px;width:100%;padding:14px;font-size:16px;font-weight:700;background:#111;color:#fff;border:none;border-radius:10px;cursor:pointer;}
  .err{margin-top:14px;padding:10px;background:#fef0f0;color:#b03030;border-radius:8px;font-size:13px;display:none;}
  .signup{margin-top:16px;text-align:center;font-size:13px;color:#888;}
  .signup a{color:#111;font-weight:700;text-decoration:none;}
</style></head><body>
<div class="card">
  <h1>WeatherFrame</h1>
  <div class="sub">Accedi al tuo account</div>
  <div class="err" id="err"></div>
  <label>Email</label>
  <input id="email" type="email" placeholder="nome@email.com" autocomplete="email">
  <label>Password</label>
  <input id="pass" type="password" placeholder="Password">
  <button onclick="login()">Accedi</button>
  <div class="signup">Non hai un account? <a href="/signup">Registrati</a></div>
</div>
<script>
async function login() {
  const email = document.getElementById('email').value.trim();
  const pass = document.getElementById('pass').value;
  const r = await fetch('/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,pass})});
  const d = await r.json();
  if (d.ok) location.href = '/admin';
  else { const e = document.getElementById('err'); e.textContent = d.error; e.style.display='block'; }
}
document.addEventListener('keydown', e => e.key==='Enter' && login());
</script></body></html>`);
});

// GET /signup
app.get("/signup", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeatherFrame — Registrazione</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,Arial,sans-serif;background:#f5f5f3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:#fff;border-radius:20px;padding:36px 28px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08);}
  h1{font-size:26px;font-weight:900;letter-spacing:-0.5px;margin-bottom:4px;}
  .sub{font-size:13px;color:#888;margin-bottom:28px;}
  label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:4px;margin-top:18px;}
  input{width:100%;padding:12px;font-size:16px;border:1.5px solid #ddd;border-radius:10px;}
  input:focus{outline:none;border-color:#111;}
  button{margin-top:24px;width:100%;padding:14px;font-size:16px;font-weight:700;background:#111;color:#fff;border:none;border-radius:10px;cursor:pointer;}
  .err{margin-top:14px;padding:10px;background:#fef0f0;color:#b03030;border-radius:8px;font-size:13px;display:none;}
  .ok{margin-top:14px;padding:10px;background:#e8f8ef;color:#1a7a40;border-radius:8px;font-size:13px;display:none;}
  .login{margin-top:16px;text-align:center;font-size:13px;color:#888;}
  .login a{color:#111;font-weight:700;text-decoration:none;}
</style></head><body>
<div class="card">
  <h1>WeatherFrame</h1>
  <div class="sub">Crea il tuo account</div>
  <div class="err" id="err"></div>
  <div class="ok" id="ok"></div>
  <label>Nome</label>
  <input id="name" placeholder="Mario Rossi">
  <label>Email</label>
  <input id="email" type="email" placeholder="nome@email.com">
  <label>Password</label>
  <input id="pass" type="password" placeholder="Minimo 8 caratteri">
  <button onclick="signup()">Crea account</button>
  <div class="login">Hai già un account? <a href="/login">Accedi</a></div>
</div>
<script>
async function signup() {
  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();
  const pass = document.getElementById('pass').value;
  const r = await fetch('/auth/signup', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,pass})});
  const d = await r.json();
  if (d.ok) { document.getElementById('ok').textContent='Account creato! Reindirizzamento...'; document.getElementById('ok').style.display='block'; setTimeout(()=>location.href='/admin',1500); }
  else { const e = document.getElementById('err'); e.textContent = d.error; e.style.display='block'; }
}
</script></body></html>`);
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  const { email, pass } = req.body;
  if (!email || !pass) return res.json({ ok: false, error: "Email e password richieste" });
  const users = loadUsers();
  const user = Object.values(users).find(u => u.email === email.toLowerCase());
  if (!user) return res.json({ ok: false, error: "Email o password non corretti" });
  const match = await bcrypt.compare(pass, user.password);
  if (!match) return res.json({ ok: false, error: "Email o password non corretti" });
  const token = createToken({ userId: user.id, email: user.email, name: user.name });
  res.cookie("wf_token", token, { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: "lax" });
  res.json({ ok: true });
});

// POST /auth/signup
app.post("/auth/signup", async (req, res) => {
  const { name, email, pass } = req.body;
  if (!name || !email || !pass) return res.json({ ok: false, error: "Tutti i campi sono richiesti" });
  if (pass.length < 8) return res.json({ ok: false, error: "Password minimo 8 caratteri" });
  const users = loadUsers();
  if (Object.values(users).find(u => u.email === email.toLowerCase())) {
    return res.json({ ok: false, error: "Email già registrata" });
  }
  const id = generateUserId();
  const hashed = await bcrypt.hash(pass, 10);
  users[id] = { id, name, email: email.toLowerCase(), password: hashed, createdAt: new Date().toISOString() };
  saveUsers(users);
  const token = createToken({ userId: id, email: email.toLowerCase(), name });
  res.cookie("wf_token", token, { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: "lax" });
  res.json({ ok: true });
});

// POST /auth/logout
app.post("/auth/logout", (req, res) => {
  res.clearCookie("wf_token");
  res.redirect("/login");
});

// ── Admin API (auth-protected) ────────────────────────────────

// GET /admin/devices — only user's own devices
app.get("/admin/devices", requireAuth, (req, res) => {
  res.json(getDevicesForUser(req.user.userId));
});

// POST /admin/devices/:id — update (must own device)
app.post("/admin/devices/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const devices = loadDevices();
  if (!devices[id]) return res.status(404).json({ ok: false, error: "not found" });
  if (devices[id].owner !== req.user.userId) return res.status(403).json({ ok: false, error: "forbidden" });
  const { place, lang, label } = req.body;
  if (place) devices[id].place = safe(place);
  if (lang)  devices[id].lang  = safe(lang);
  if (label) devices[id].label = label.slice(0, 40);
  invalidateCache(devices[id].place, devices[id].lang, devices[id].profile);
  saveDevices(devices);
  res.json({ ok: true, device: devices[id] });
});

// POST /admin/welcome/:id
app.post("/admin/welcome/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const devices = loadDevices();
  if (!devices[id] || devices[id].owner !== req.user.userId) return res.status(403).json({ ok: false, error: "forbidden" });
  const welcome = loadWelcome();
  const { guestName, arrivalDate, wifiSsid, wifiPass } = req.body;
  welcome[id] = { guestName, arrivalDate, wifiSsid, wifiPass };
  saveWelcome(welcome);
  res.json({ ok: true });
});

// DELETE /admin/welcome/:id
app.delete("/admin/welcome/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const devices = loadDevices();
  if (!devices[id] || devices[id].owner !== req.user.userId) return res.status(403).json({ ok: false, error: "forbidden" });
  const welcome = loadWelcome();
  delete welcome[id];
  saveWelcome(welcome);
  res.json({ ok: true });
});

// ── Admin UI (auth-protected) ────────────────────────────────
app.get("/admin", requireAuth, (req, res) => {
  const PLACES_LIST = [
    ["sauze","Sauze d'Oulx"],["sestriere","Sestriere"],["sansicario","San Sicario"],
    ["cesana","Cesana"],["claviere","Claviere"],["monginevro","Monginevro"],
    ["bardonecchia","Bardonecchia"],["oulx","Oulx"]
  ];
  const placeOptions = PLACES_LIST.map(([v,l]) => `<option value="${v}">${l}</option>`).join("");

  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeatherFrame Admin</title>
<style>
  :root{--ink:#111;--bg:#f5f5f3;--white:#fff;--soft:#d8d8d6;--r:14px;--accent:#111;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,Arial,sans-serif;background:var(--bg);color:var(--ink);padding:0 0 60px;}
  .header{background:var(--white);border-bottom:2px solid var(--ink);padding:20px 20px 16px;}
  .header h1{font-size:24px;font-weight:900;letter-spacing:-0.5px;}
  .header p{font-size:13px;color:#888;margin-top:4px;}
  .section{padding:20px;}
  .section h2{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#888;margin-bottom:14px;}
  .card{background:var(--white);border:1px solid var(--soft);border-radius:var(--r);padding:16px;margin-bottom:12px;}
  .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
  .device-name{font-size:17px;font-weight:800;}
  .device-meta{font-size:11px;color:#999;margin-top:2px;}
  .badge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;background:#f0f0ee;color:#555;}
  .badge.online{background:#e8f8ef;color:#1a7a40;}
  .profile-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;margin-top:5px;}
  .profile-badge.inkplate{background:#eef4ff;color:#2255cc;border:1px solid #c5d8ff;}
  .profile-badge.waveshare{background:#f5f0ff;color:#6622cc;border:1px solid #ddc5ff;}
  label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:4px;margin-top:12px;}
  select,input{width:100%;padding:10px;font-size:15px;border:1px solid var(--soft);border-radius:10px;background:var(--white);}
  .btn{display:block;width:100%;padding:13px;font-size:15px;font-weight:700;background:var(--ink);color:#fff;border:none;border-radius:10px;cursor:pointer;margin-top:14px;}
  .btn.secondary{background:#fff;color:var(--ink);border:1.5px solid var(--soft);}
  .btn.danger{background:#fef0f0;color:#b03030;border:1px solid #f5c0c0;}
  .welcome-section{margin-top:14px;padding-top:14px;border-top:1px solid var(--soft);}
  .welcome-section h3{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:10px;}
  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:12px 24px;border-radius:12px;font-size:14px;font-weight:600;opacity:0;transition:opacity 0.3s;pointer-events:none;z-index:999;}
  .toast.show{opacity:1;}
  .empty{text-align:center;padding:40px 20px;color:#aaa;font-size:14px;}
</style>
</head>
<body>
<div class="header">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <div>
      <h1>WeatherFrame</h1>
      <p>Ciao, ${req.user.name} · <a href="/auth/logout" style="color:#888;font-size:13px;">Esci</a></p>
    </div>
  </div>
</div>

<div class="section">
  <h2>Display registrati</h2>
  <div id="deviceList"><div class="empty">Caricamento...</div></div>
</div>

<div class="toast" id="toast"></div>

<script>
const PLACES = ${JSON.stringify(PLACES_LIST)};

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function profileBadge(profile) {
  if (profile === 'inkplate6') {
    return '<span class="profile-badge inkplate">▦ Inkplate 6</span>';
  }
  if (profile === 'waveshare75') {
    return '<span class="profile-badge waveshare">▩ Waveshare 7.5"</span>';
  }
  return '<span class="profile-badge">' + (profile || 'unknown') + '</span>';
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 60 * 1000; // 2h
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('it-IT', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}

function placeOptions(selected) {
  return PLACES.map(([v,l]) =>
    '<option value="'+v+'"'+(v===selected?' selected':'')+'>'+l+'</option>'
  ).join('');
}

async function loadDevices() {
  const res = await fetch('/admin/devices');
  const devices = await res.json();
  const list = document.getElementById('deviceList');
  const keys = Object.keys(devices);
  if (!keys.length) {
    list.innerHTML = '<div class="empty">Nessun display registrato ancora.<br>Accendi un display per registrarlo.</div>';
    return;
  }
  list.innerHTML = keys.map(id => {
    const d = devices[id];
    const online = isOnline(d.lastSeen);
    return \`
    <div class="card" id="card-\${id}">
      <div class="card-header">
        <div>
          <div class="device-name">\${d.label || id}</div>
          <div class="device-meta">ID: \${id} · Visto: \${formatDate(d.lastSeen)}</div>
          \${profileBadge(d.profile)}
        </div>
        <span class="badge \${online?'online':''}">
          \${online ? '● Online' : '○ Offline'}
        </span>
      </div>

      <label>Localit&agrave;</label>
      <select id="place-\${id}">\${placeOptions(d.place)}</select>

      <label>Lingua</label>
      <select id="lang-\${id}">
        <option value="it" \${d.lang==='it'?'selected':''}>🇮🇹 Italiano</option>
        <option value="en" \${d.lang==='en'?'selected':''}>🇬🇧 English</option>
        <option value="fr" \${d.lang==='fr'?'selected':''}>🇫🇷 Français</option>
      </select>

      <label>Nome display</label>
      <input id="label-\${id}" value="\${d.label || ''}" placeholder="Es. Soggiorno, Camera ospiti...">

      <button class="btn" onclick="saveDevice('\${id}')">Salva impostazioni</button>

      <div class="welcome-section">
        <h3>🎉 Schermata benvenuto</h3>
        <label>Nome ospite</label>
        <input id="wg-name-\${id}" placeholder="Es. Marco e Laura">
        <label>Data arrivo</label>
        <input id="wg-date-\${id}" type="date">
        <label>Nome rete WiFi</label>
        <input id="wg-ssid-\${id}" placeholder="NomeRete">
        <label>Password WiFi</label>
        <input id="wg-pass-\${id}" placeholder="Password">
        <button class="btn secondary" onclick="saveWelcome('\${id}')">Attiva benvenuto</button>
        <button class="btn danger" onclick="clearWelcome('\${id}')">Rimuovi benvenuto</button>
      </div>
    </div>\`;
  }).join('');
}

async function saveDevice(id) {
  const place = document.getElementById('place-'+id).value;
  const lang  = document.getElementById('lang-'+id).value;
  const label = document.getElementById('label-'+id).value;
  const res = await fetch('/admin/devices/'+id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({place, lang, label})
  });
  const data = await res.json();
  if (data.ok) showToast('✓ Impostazioni salvate — aggiornamento al prossimo risveglio');
  else showToast('Errore: '+data.error);
}

async function saveWelcome(id) {
  const guestName  = document.getElementById('wg-name-'+id).value;
  const arrivalDate = document.getElementById('wg-date-'+id).value;
  const wifiSsid   = document.getElementById('wg-ssid-'+id).value;
  const wifiPass   = document.getElementById('wg-pass-'+id).value;
  if (!guestName || !arrivalDate) { showToast('Inserisci nome ospite e data'); return; }
  const res = await fetch('/admin/welcome/'+id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({guestName, arrivalDate, wifiSsid, wifiPass})
  });
  const data = await res.json();
  if (data.ok) showToast('✓ Benvenuto attivato per '+guestName);
}

async function clearWelcome(id) {
  await fetch('/admin/welcome/'+id, {method:'DELETE'});
  showToast('Benvenuto rimosso');
}

loadDevices();
</script>
</body>
</html>`);
});

// ── Firmware OTA endpoints ───────────────────────────────────

// GET /firmware/version?profile=inkplate6
// Called by ESP32 at boot to check for updates
app.get("/firmware/version", (req, res) => {
  const profile = safe(req.query.profile || "inkplate6");
  const versions = loadFirmwareVersions();
  const fw = versions[profile];
  if (!fw) return res.json({ version: "0.0.0", url: "" });
  res.json({ version: fw.version, url: fw.url });
});

// ── Super Admin ──────────────────────────────────────────────

app.get("/superadmin/login", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeatherFrame — Super Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,Arial,sans-serif;background:#111;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:#1a1a1a;border-radius:20px;padding:36px 28px;width:100%;max-width:360px;border:1px solid #333;}
  h1{font-size:22px;font-weight:900;color:#fff;margin-bottom:4px;}
  .sub{font-size:13px;color:#666;margin-bottom:28px;}
  label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px;margin-top:18px;}
  input{width:100%;padding:12px;font-size:16px;border:1px solid #333;border-radius:10px;background:#222;color:#fff;}
  button{margin-top:24px;width:100%;padding:14px;font-size:16px;font-weight:700;background:#fff;color:#111;border:none;border-radius:10px;cursor:pointer;}
  .err{margin-top:14px;padding:10px;background:#3a1010;color:#ff6b6b;border-radius:8px;font-size:13px;display:none;}
</style></head><body>
<div class="card">
  <h1>⚡ Super Admin</h1>
  <div class="sub">WeatherFrame internal</div>
  <div class="err" id="err"></div>
  <label>Password</label>
  <input id="pass" type="password" placeholder="Super admin password">
  <button onclick="login()">Accedi</button>
</div>
<script>
async function login() {
  const pass = document.getElementById('pass').value;
  const r = await fetch('/superadmin/auth', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass})});
  const d = await r.json();
  if (d.ok) location.href = '/superadmin';
  else { const e = document.getElementById('err'); e.textContent = d.error; e.style.display='block'; }
}
document.addEventListener('keydown', e => e.key==='Enter' && login());
</script></body></html>`);
});

app.post("/superadmin/auth", (req, res) => {
  const { pass } = req.body;
  console.log(`[SA] Auth attempt, env password length: ${SUPER_ADMIN_PASSWORD.length}`);
  if (pass !== SUPER_ADMIN_PASSWORD) return res.json({ ok: false, error: "Password errata" });
  const token = jwt.sign({ superadmin: true }, JWT_SECRET, { expiresIn: "1d" });
  res.cookie("wf_super_token", token, { httpOnly: true, maxAge: 24*60*60*1000, sameSite: "lax" });
  res.json({ ok: true });
});

app.get("/superadmin", requireSuperAdmin, (req, res) => {
  const users = loadUsers();
  const devices = loadDevices();
  const userList = Object.values(users);
  const deviceList = Object.values(devices);

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeatherFrame — Super Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,Arial,sans-serif;background:#111;color:#fff;padding:0 0 60px;}
  .header{background:#1a1a1a;border-bottom:1px solid #333;padding:20px;}
  .header h1{font-size:22px;font-weight:900;}
  .header p{font-size:13px;color:#666;margin-top:4px;}
  .section{padding:20px;}
  h2{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#666;margin-bottom:14px;}
  .card{background:#1a1a1a;border:1px solid #333;border-radius:14px;padding:16px;margin-bottom:10px;}
  .row{display:flex;justify-content:space-between;align-items:center;gap:12px;}
  .name{font-size:16px;font-weight:800;}
  .meta{font-size:12px;color:#666;margin-top:3px;}
  select{padding:8px;font-size:14px;border:1px solid #333;border-radius:8px;background:#222;color:#fff;flex:1;}
  .btn{padding:10px 18px;font-size:14px;font-weight:700;border:none;border-radius:8px;cursor:pointer;}
  .btn-assign{background:#fff;color:#111;}
  .btn-del{background:#3a1010;color:#ff6b6b;}
  .unassigned{background:#2a2000;border-color:#554400;}
  .tag{font-size:10px;font-weight:700;padding:2px 8px;border-radius:5px;background:#333;color:#aaa;}
  .tag.assigned{background:#1a2a1a;color:#5dde8f;}
</style></head>
<body>
<div class="header">
  <h1>⚡ Super Admin</h1>
  <p>${userList.length} clienti · ${deviceList.length} display · <a href="/superadmin/logout" style="color:#666;font-size:13px;">Esci</a></p>
</div>

<div class="section">
  <h2>Firmware OTA</h2>
  <div class="card" style="background:#1a1a1a;">
    <div style="margin-bottom:12px;font-size:14px;color:#aaa;">
      Versioni correnti: Inkplate6 = <strong id="fw-inkplate6">—</strong> · Waveshare = <strong id="fw-waveshare75">—</strong>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <div>
        <div style="font-size:11px;color:#666;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Profile</div>
        <select id="fw-profile" style="background:#222;color:#fff;border:1px solid #333;padding:8px;border-radius:8px;">
          <option value="inkplate6">Inkplate 6</option>
          <option value="waveshare75">Waveshare 7.5"</option>
        </select>
      </div>
      <div>
        <div style="font-size:11px;color:#666;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Versione</div>
        <input id="fw-version" placeholder="es. 1.0.3" style="background:#222;color:#fff;border:1px solid #333;padding:8px;border-radius:8px;width:120px;">
      </div>
      <div>
        <div style="font-size:11px;color:#666;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">File .bin</div>
        <input id="fw-file" type="file" accept=".bin" style="color:#aaa;font-size:13px;">
      </div>
      <button class="btn btn-assign" onclick="uploadFirmware()" style="margin-top:0;">Carica firmware</button>
    </div>
    <div id="fw-status" style="margin-top:10px;font-size:13px;color:#5dde8f;display:none;"></div>
  </div>
  <h2 style="margin-top:24px;">Display da assegnare</h2>
  <div id="unassigned"></div>
  <h2 style="margin-top:24px;">Clienti</h2>
  <div id="userList"></div>
</div>

<script>
const users = ${JSON.stringify(userList.map(u => ({id:u.id,name:u.name,email:u.email,createdAt:u.createdAt})))};
const devices = ${JSON.stringify(deviceList)};

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('it-IT');
}

function render() {
  const unassigned = devices.filter(d => !d.owner);
  const uEl = document.getElementById('unassigned');
  if (!unassigned.length) {
    uEl.innerHTML = '<div style="color:#666;font-size:14px;padding:10px 0">Nessun display non assegnato</div>';
  } else {
    uEl.innerHTML = unassigned.map(d => \`
    <div class="card unassigned">
      <div class="row">
        <div>
          <div class="name">\${d.label || d.id}</div>
          <div class="meta">ID: \${d.id} · \${d.profile || 'unknown'} · Registrato: \${formatDate(d.registeredAt)}</div>
        </div>
        <select id="assign-\${d.id}">
          <option value="">— Assegna a cliente —</option>
          \${users.map(u => '<option value="'+u.id+'">'+u.name+' ('+u.email+')'+'</option>').join('')}
        </select>
        <button class="btn btn-assign" onclick="assignDevice('\${d.id}')">Assegna</button>
      </div>
    </div>\`).join('');
  }

  const uList = document.getElementById('userList');
  uList.innerHTML = users.map(u => {
    const myDevices = devices.filter(d => d.owner === u.id);
    return \`
    <div class="card">
      <div class="row" style="margin-bottom:10px;">
        <div>
          <div class="name">\${u.name}</div>
          <div class="meta">\${u.email} · \${myDevices.length} display · Dal \${formatDate(u.createdAt)}</div>
        </div>
        <button class="btn btn-del" onclick="deleteUser('\${u.id}')">Elimina</button>
      </div>
      \${myDevices.map(d => \`
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #333;">
          <span class="tag assigned">● online</span>
          <span style="font-size:14px;font-weight:700;">\${d.label || d.id}</span>
          <span style="font-size:12px;color:#666;">\${d.profile}</span>
          <button class="btn btn-del" style="margin-left:auto;padding:6px 12px;font-size:12px;" onclick="unassignDevice('\${d.id}')">Rimuovi</button>
        </div>\`).join('')}
    </div>\`;
  }).join('');
}

async function loadFirmwareVersions() {
  const r = await fetch('/firmware/version?profile=inkplate6');
  const d = await r.json();
  document.getElementById('fw-inkplate6').textContent = d.version || '—';
  const r2 = await fetch('/firmware/version?profile=waveshare75');
  const d2 = await r2.json();
  document.getElementById('fw-waveshare75').textContent = d2.version || '—';
}

async function uploadFirmware() {
  const file = document.getElementById('fw-file').files[0];
  const version = document.getElementById('fw-version').value.trim();
  const profile = document.getElementById('fw-profile').value;
  if (!file || !version) return alert('Seleziona file e inserisci versione');
  const status = document.getElementById('fw-status');
  status.textContent = 'Caricamento...'; status.style.display='block';
  const buf = await file.arrayBuffer();
  const r = await fetch('/superadmin/firmware?profile='+profile+'&version='+version, {
    method: 'POST',
    headers: {'Content-Type':'application/octet-stream'},
    body: buf
  });
  const d = await r.json();
  if (d.ok) {
    status.textContent = '✓ Firmware ' + d.version + ' caricato — i display si aggiorneranno al prossimo risveglio';
    loadFirmwareVersions();
  } else {
    status.textContent = 'Errore: ' + (d.error || 'unknown');
    status.style.color = '#ff6b6b';
  }
}

async function assignDevice(deviceId) {
  const userId = document.getElementById('assign-'+deviceId).value;
  if (!userId) return alert('Seleziona un cliente');
  const r = await fetch('/superadmin/assign', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,userId})});
  const d = await r.json();
  if (d.ok) location.reload();
  else alert('Errore: '+d.error);
}

async function unassignDevice(deviceId) {
  if (!confirm('Rimuovere assegnazione?')) return;
  const r = await fetch('/superadmin/assign', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,userId:null})});
  if ((await r.json()).ok) location.reload();
}

async function deleteUser(userId) {
  if (!confirm('Eliminare questo cliente? I suoi display diventeranno non assegnati.')) return;
  const r = await fetch('/superadmin/users/'+userId, {method:'DELETE'});
  if ((await r.json()).ok) location.reload();
}

render();
loadFirmwareVersions();
</script>
</body></html>`);
});

// POST /superadmin/firmware — upload new firmware version
app.post("/superadmin/firmware", requireSuperAdmin, express.raw({ type: "application/octet-stream", limit: "2mb" }), (req, res) => {
  const profile = safe(req.query.profile || "inkplate6");
  const version = req.query.version || "1.0.0";
  const filename = `${profile}_${version}.bin`;
  const filepath = path.join(FIRMWARE_DIR, filename);
  fs.writeFileSync(filepath, req.body);
  const url = `${req.protocol}://${req.get("host")}/public/firmware/${filename}`;
  const versions = loadFirmwareVersions();
  versions[profile] = { version, url, uploadedAt: new Date().toISOString() };
  saveFirmwareVersions(versions);
  console.log(`[FW] Uploaded ${filename} — version ${version}`);
  res.json({ ok: true, version, url });
});

// POST /superadmin/assign
app.post("/superadmin/assign", requireSuperAdmin, (req, res) => {
  const { deviceId, userId } = req.body;
  const devices = loadDevices();
  if (!devices[deviceId]) return res.status(404).json({ ok: false, error: "device not found" });
  devices[deviceId].owner = userId || null;
  saveDevices(devices);
  console.log(`[SA] Device ${deviceId} assigned to ${userId}`);
  res.json({ ok: true });
});

// DELETE /superadmin/users/:id
app.delete("/superadmin/users/:id", requireSuperAdmin, (req, res) => {
  const users = loadUsers();
  if (!users[req.params.id]) return res.status(404).json({ ok: false, error: "user not found" });
  // Unassign all devices
  const devices = loadDevices();
  Object.values(devices).forEach(d => { if (d.owner === req.params.id) d.owner = null; });
  saveDevices(devices);
  delete users[req.params.id];
  saveUsers(users);
  res.json({ ok: true });
});

app.get("/superadmin/logout", (req, res) => {
  res.clearCookie("wf_super_token");
  res.redirect("/superadmin/login");
});

app.listen(PORT, () => {
  console.log(`WeatherFrame running on port ${PORT}`);
  // Pre-warm weather cache after 5 minutes — avoids 429 on cold start
  setTimeout(async () => {
    console.log("[WX] Pre-warming cache for sauze...");
    try {
      await fetchWeatherForPlace("sauze");
      console.log("[WX] Cache warmed successfully");
    } catch(e) {
      console.warn("[WX] Warmup failed:", e.message);
    }
  }, 5 * 60 * 1000); // 5 minuti
});
