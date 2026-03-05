const express = require("express");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use("/public", express.static(path.join(__dirname, "public")));

function safe(s){
  return String(s||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");
}

const OUT_DIR = path.join(__dirname,"public","renders");
fs.mkdirSync(OUT_DIR,{recursive:true});

const TTL = 30 * 60 * 1000;

function filePath(place,lang,mode){
  return path.join(OUT_DIR,`${place}_${lang}_${mode}.png`);
}

function isFresh(file){
  try{
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs < TTL;
  }catch{
    return false;
  }
}

async function render(place,lang,mode){

  const out = filePath(place,lang,mode);

  const url = `http://localhost:${PORT}/view?place=${place}&lang=${lang}&mode=${mode}&t=${Date.now()}`;

  const browser = await puppeteer.launch({
    headless:"new",
    args:["--no-sandbox","--disable-setuid-sandbox"]
  });

  try{

    const page = await browser.newPage();

    await page.setViewport({
      width:600,
      height:800,
      deviceScaleFactor:1
    });

    await page.goto(url,{waitUntil:"networkidle2"});

    await page.waitForFunction(()=>window.__WF_READY__ === true);

    await page.screenshot({
      path:out,
      type:"png"
    });

    return out;

  }finally{
    await browser.close();
  }
}

app.get("/",(req,res)=>{
  res.redirect("/view");
});

app.get("/view",(req,res)=>{
  res.sendFile(path.join(__dirname,"view.html"));
});

app.get("/render",async(req,res)=>{

  const place = safe(req.query.place || "sauze");
  const lang  = safe(req.query.lang || "it");
  const mode  = safe(req.query.mode || "auto");

  try{

    const file = await render(place,lang,mode);

    res.json({
      ok:true,
      file:file
    });

  }catch(e){

    res.status(500).json({
      ok:false,
      error:e.toString()
    });

  }

});

app.get("/img",async(req,res)=>{

  const place = safe(req.query.place || "sauze");
  const lang  = safe(req.query.lang || "it");
  const mode  = safe(req.query.mode || "auto");

  const file = filePath(place,lang,mode);

  try{

    if(!isFresh(file)){
      await render(place,lang,mode);
    }

    res.setHeader("Content-Type","image/png");

    fs.createReadStream(file).pipe(res);

  }catch(e){

    res.status(500).send("Render error");

  }

});

app.listen(PORT,()=>{
  console.log("WeatherFrame running on port",PORT);
});