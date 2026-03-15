const express = require("express");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const { PNG } = require("pngjs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

function safe(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

// ── Directories ──────────────────────────────────────────────
const OUT_DIR = path.join(__dirname, "public", "renders");
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

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

// ── Welcome store ─────────────────────────────────────────────
const WELCOME_FILE = path.join(DATA_DIR, "welcome.json");
function loadWelcome() {
  try { return JSON.parse(fs.readFileSync(WELCOME_FILE, "utf8")); }
  catch { return {}; }
}
function saveWelcome(d) {
  fs.writeFileSync(WELCOME_FILE, JSON.stringify(d, null, 2));
}

// ── Error log ─────────────────────────────────────────────────
const LOG_FILE = path.join(DATA_DIR, "errors.json");
const MAX_LOGS = 100;
function loadLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return []; }
}
function addLog(deviceId, type, message) {
  const logs = loadLogs();
  logs.unshift({ ts: new Date().toISOString(), deviceId, type, message });
  if (logs.length > MAX_LOGS) logs.splice(MAX_LOGS);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2)); } catch {}
}

// ── Cache helpers ─────────────────────────────────────────────
// Smart cache: TTL 60 min, but can be invalidated per device
const TTL = 60 * 60 * 1000; // 60 min

function pngPath(place, lang, mode, profile) {
  return path.join(OUT_DIR, `${place}_${lang}_${mode}_${profile}.png`);
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
async function renderPNGBuffer(place, lang, mode, profile, welcomeData = null) {
  const { w, h } = getProfile(profile);
  let url = `http://127.0.0.1:${PORT}/view?place=${place}&lang=${lang}&mode=${mode}&profile=${profile}&render=1&t=${Date.now()}`;
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
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    // Wait for the right element depending on mode
    const isWelcome = url.includes("welcome=1");
    await page.waitForSelector(isWelcome ? "#wlFooter" : "#title", { timeout: 30000 });
    await page.waitForFunction(() => window.__WF_READY__ === true, { timeout: 60000 });
    await new Promise(r => setTimeout(r, 1200));
    return await page.screenshot({ type: "png" });
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
      if (gray < 128) {
        raw[y*(IMG_W/8) + Math.floor(x/8)] |= (1 << (7-(x%8)));
      }
    }
  }
  return raw;
}

async function ensureRendered(place, lang, mode, profile) {
  const pPng = pngPath(place, lang, mode, profile);
  const pRaw = rawPath(place, lang, mode, profile);
  if (isFresh(pPng) && isFresh(pRaw)) return { png: pPng, raw: pRaw };
  const pngBuffer = await renderPNGBuffer(place, lang, mode, profile);
  fs.writeFileSync(pPng, pngBuffer);
  fs.writeFileSync(pRaw, pngToRaw1Bit(pngBuffer, profile));
  return { png: pPng, raw: pRaw };
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

  const fw = safe(req.query.fw || "");
  if (!devices[id]) {
    devices[id] = {
      id, profile,
      place: "sauze", lang: "it",
      label: `Display ${Object.keys(devices).length + 1}`,
      registeredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      bootCount: 1,
      firmware: fw
    };
  } else {
    devices[id].lastSeen = new Date().toISOString();
    devices[id].profile  = profile;
    devices[id].bootCount = (devices[id].bootCount || 0) + 1;
    if (fw) devices[id].firmware = fw;
  }
  saveDevices(devices);
  console.log(`[REG] Device ${id} boot #${devices[id].bootCount}`);
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

// ── Welcome RAW endpoint ─────────────────────────────────────
app.get("/welcome-raw", async (req, res) => {
  const profile   = safe(req.query.profile   || DEFAULT_PROFILE);
  const place     = safe(req.query.place     || "sauze");
  const lang      = safe(req.query.lang      || "it");
  const guestName = req.query.guestName      || "";
  const wifiSsid  = req.query.wifiSsid       || "";
  const wifiPass  = req.query.wifiPass       || "";
  const deviceId  = safe(req.query.id        || "");

  const { w, h } = getProfile(profile);
  const RAW_SIZE = (w * h) / 8;

  // Cache key for welcome (per device, changes with guest data)
  const cacheKey = `welcome_${deviceId}_${profile}`;
  const pPng = path.join(OUT_DIR, `${cacheKey}.png`);
  const pRaw = path.join(OUT_DIR, `${cacheKey}.raw`);

  try {
    // Welcome screen is cached for 1 hour
    if (!isFresh(pPng, 60*60*1000)) {
      const pngBuffer = await renderPNGBuffer(place, lang, "auto", profile, {guestName, wifiSsid, wifiPass});
      fs.writeFileSync(pPng, pngBuffer);
      fs.writeFileSync(pRaw, pngToRaw1Bit(pngBuffer, profile));
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", RAW_SIZE);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(pRaw).pipe(res);
  } catch(e) {
    console.error(e);
    res.status(500).send("Welcome render error");
  }
});

// ── RAW endpoint (used by ESP32) ──────────────────────────────
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
    addLog(safe(req.query.id||"unknown"), "render_error", e.toString().slice(0,200));
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
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(files.png).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("PNG render error");
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

// POST /admin/devices/:id — update device settings
app.post("/admin/devices/:id", (req, res) => {
  const id = req.params.id;
  const devices = loadDevices();
  if (!devices[id]) return res.status(404).json({ ok: false, error: "not found" });
  const { place, lang, label } = req.body;
  if (place) devices[id].place = safe(place);
  if (lang)  devices[id].lang  = safe(lang);
  if (label) devices[id].label = label.slice(0, 40);
  // Invalidate cache so next wake picks up new settings
  invalidateCache(devices[id].place, devices[id].lang, devices[id].profile);
  saveDevices(devices);
  res.json({ ok: true, device: devices[id] });
});

// POST /admin/welcome/:id — set welcome screen
app.post("/admin/welcome/:id", (req, res) => {
  const id = req.params.id;
  const welcome = loadWelcome();
  const { guestName, arrivalDate, wifiSsid, wifiPass } = req.body;
  welcome[id] = { guestName, arrivalDate, wifiSsid, wifiPass };
  saveWelcome(welcome);
  res.json({ ok: true });
});

// DELETE /admin/welcome/:id — clear welcome
app.delete("/admin/welcome/:id", (req, res) => {
  const welcome = loadWelcome();
  delete welcome[req.params.id];
  saveWelcome(welcome);
  res.json({ ok: true });
});

// ── Admin log endpoint ───────────────────────────────────────
app.get("/admin/logs", (req, res) => {
  res.json(loadLogs());
});

// ── Admin status — device offline check ──────────────────────
// A device is "offline" if last seen > 3h (should wake every hour)
app.get("/admin/status", (req, res) => {
  const devices = loadDevices();
  const now = Date.now();
  const status = Object.values(devices).map(d => ({
    id: d.id,
    label: d.label,
    online: (now - new Date(d.lastSeen||0).getTime()) < 3 * 60 * 60 * 1000,
    lastSeen: d.lastSeen,
    bootCount: d.bootCount || 0,
    firmware: d.firmware || "unknown"
  }));
  res.json(status);
});

// ── Admin UI ──────────────────────────────────────────────────
app.get("/admin", (req, res) => {
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
  <h1>WeatherFrame</h1>
  <p>Gestione display remota</p>
</div>

<div class="section">
  <h2>Display registrati</h2>
  <div id="deviceList"><div class="empty">Caricamento...</div></div>
</div>

<div class="section">
  <h2>Log errori recenti</h2>
  <div id="logList"><div class="empty">Caricamento...</div></div>
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
    list.innerHTML = '<div class="empty">Nessun display registrato ancora.<br>Accendi il Waveshare per registrarlo.</div>';
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
          <div class="device-meta">ID: \${id} · \${d.profile||'inkplate6'} · FW: \${d.firmware||'?'} · Boot: \${d.bootCount||0} · Visto: \${formatDate(d.lastSeen)}</div>
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

async function loadLogs() {
  const res = await fetch('/admin/logs');
  const logs = await res.json();
  const list = document.getElementById('logList');
  if (!logs.length) {
    list.innerHTML = '<div class="empty">Nessun errore registrato.</div>';
    return;
  }
  list.innerHTML = logs.slice(0,20).map(l => \`
    <div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;font-weight:800;color:#b03030;">\${l.type}</span>
        <span style="font-size:11px;color:#aaa;">\${formatDate(l.ts)}</span>
      </div>
      <div style="font-size:12px;color:#555;margin-top:4px;">\${l.deviceId} — \${l.message}</div>
    </div>
  \`).join('');
}

loadDevices();
loadLogs();
setInterval(loadDevices, 60000);  // auto-refresh ogni minuto
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`WeatherFrame running on port ${PORT}`);
});
