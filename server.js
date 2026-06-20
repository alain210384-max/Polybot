require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const cron    = require("node-cron");
const axios   = require("axios");
const fs      = require("fs");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const CFG_FILE = path.join(__dirname, "cfg.json");
const CFG_DEFAULTS = {
  minOdds:          0.70,
  maxOdds:          0.85,
  minLiquidity:     300,
  budget:           parseFloat(process.env.DAILY_BUDGET)    || 59,
  stake:            parseFloat(process.env.STAKE_PER_TRADE) || 3,
  keyId:            process.env.POLYMARKET_KEY_ID,
  secretKey:        process.env.POLYMARKET_SECRET_KEY,
  autoComprar:      true,
  autoCopiar:       true,
  maxHoldHoras:     24,
  maxDiasRestantes: 7,
};
let CFG = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    // Credenciales siempre de env vars, nunca del archivo
    return { ...CFG_DEFAULTS, ...saved, keyId: CFG_DEFAULTS.keyId, secretKey: CFG_DEFAULTS.secretKey };
  } catch(_) {}
  return { ...CFG_DEFAULTS };
})();
const guardarCFG = () => {
  const { keyId, secretKey, ...sinCredenciales } = CFG;
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(sinCredenciales, null, 2)); } catch(_) {}
};

// Origen de cada posición por slug (COPY / SCREENER / MANUAL) — sobrevive reinicios
const ORIGEN_FILE = path.join(__dirname, "origen-trades.json");
let origenPorSlug = (() => {
  try { return JSON.parse(fs.readFileSync(ORIGEN_FILE, "utf8")); } catch(_) { return {}; }
})();
const marcarOrigen = (slug, origen) => {
  if (!slug || origenPorSlug[slug]) return;          // no sobrescribir el primer origen
  origenPorSlug[slug] = origen;
  try { fs.writeFileSync(ORIGEN_FILE, JSON.stringify(origenPorSlug)); } catch(_) {}
};
const fuerzaPorOrigen = slug =>
  origenPorSlug[slug] === "COPY"     ? "🔁 COPY"
: origenPorSlug[slug] === "SCREENER" ? "🤖 AUTO"
: origenPorSlug[slug] === "MANUAL"   ? "✋ MANUAL"
: "SYNC";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API  = "https://data-api.polymarket.com";

// ── CLIENTE POLYMARKET.US ──────────────────────────────────────────────────────
const ed25519 = require("@noble/ed25519");
try { const { sha512 } = require("@noble/hashes/sha512"); ed25519.etc.sha512Sync = (...m) => sha512(...m); } catch(_) {}

const PM_US_API = "https://api.polymarket.us";

async function pmUsSign(secretBase64, ts, method, path) {
  const msg  = ts + method.toUpperCase() + path;
  const raw  = new Uint8Array(Buffer.from(secretBase64, "base64"));
  const seed = raw.length > 32 ? raw.slice(0, 32) : raw;
  const sig  = await ed25519.signAsync(new TextEncoder().encode(msg), seed);
  return Buffer.from(sig).toString("base64");
}

const pmUs = {
  keyId:  process.env.POLYMARKET_KEY_ID     || "",
  secret: process.env.POLYMARKET_SECRET_KEY || "",
  async _headers(method, path) {
    if (!this.keyId || !this.secret) return {};
    const ts  = Date.now().toString();
    const sig = await pmUsSign(this.secret, ts, method, path);
    return { "X-PM-Access-Key": this.keyId, "X-PM-Timestamp": ts, "X-PM-Signature": sig };
  },
  async get(path, authed = true, params = {}) {
    const url = new URL(path, PM_US_API);
    Object.entries(params).forEach(([k,v]) => v !== undefined && url.searchParams.set(k, v));
    const headers = authed ? await this._headers("GET", path) : {};
    const r = await axios.get(url.toString(), { headers, timeout: 15000 });
    return r.data;
  },
  async post(path, body = {}) {
    const headers = { ...await this._headers("POST", path), "Content-Type": "application/json" };
    const r = await axios.post(PM_US_API + path, body, { headers, timeout: 15000 });
    return r.data;
  },
};

let modoReal = !!(process.env.POLYMARKET_KEY_ID && process.env.POLYMARKET_SECRET_KEY);
console.log(modoReal
  ? `✅ Polymarket.us (${process.env.POLYMARKET_KEY_ID?.slice(0,8)}…) — REAL 💰`
  : "⚠️  Sin credenciales — SIMULACIÓN");

// ── HELPERS ÓRDENES ────────────────────────────────────────────────────────────
async function pmBbo(slug) {
  try {
    const r  = await pmUs.get(`/v1/markets/${slug}/bbo`);
    const md = r?.marketData || {};
    return {
      bid:  parseFloat(md.bestBid?.value  || 0) || null,
      ask:  parseFloat(md.bestAsk?.value  || 0) || null,
      last: parseFloat(md.currentPx?.value || md.lastTradePx?.value || 0) || null,
    };
  } catch(e) { return { bid:null, ask:null, last:null }; }
}

async function pmPrecioActual(slug) {
  const b = await pmBbo(slug);
  return b.last || b.bid || b.ask || null;
}

async function pmComprar(slug, probRef, quantity) {
  const b = await pmBbo(slug);
  let precio = b.ask ? Math.min(b.ask + 0.01, 0.99) : (probRef || b.last || 0.5);
  precio = Math.round(precio * 100) / 100;
  return pmUs.post("/v1/orders", {
    marketSlug: slug,
    intent:   "ORDER_INTENT_BUY_LONG",
    type:     "ORDER_TYPE_LIMIT",
    price:    { value: precio.toFixed(2), currency: "USD" },
    quantity: Math.max(1, Math.round(quantity)),
    tif:      "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
  });
}

async function pmCerrar(slug) { return pmUs.post("/v1/order/close-position", { marketSlug: slug }); }

async function pmVender(slug, quantity) {
  const b = await pmBbo(slug);
  // Vender al mejor bid disponible. Si bid < 0.02 el mercado no tiene liquidez real.
  const bidPrice = b.bid || b.last || 0.01;
  const precio   = Math.max(Math.round(bidPrice * 100) / 100, 0.01);
  return pmUs.post("/v1/orders", {
    marketSlug: slug,
    intent:   "ORDER_INTENT_SELL_LONG",
    type:     "ORDER_TYPE_LIMIT",
    price:    { value: precio.toFixed(2), currency: "USD" },
    quantity: Math.max(1, Math.round(quantity)),
    tif:      "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
  });
}

// ── ESTADO GLOBAL ──────────────────────────────────────────────────────────────
let botActivo          = true;
let balanceReal        = CFG.budget;
let pnlHoy             = 0;
let tradesHoy          = 0;
let ganados            = 0;
let perdidos           = 0;
let presupuestoUsado   = 0;
let rachaPerder        = 0;
let circuitBreaker     = false;
let senalesPendientes  = [];
let posicionesAbiertas = [];
let historialTrades    = [];
let mercadosActivos    = [];
const HISTORY_FILE  = path.join(__dirname, "balance-history.json");
const JSONBIN_KEY   = process.env.JSONBIN_KEY  || "";
const JSONBIN_BIN   = process.env.JSONBIN_BIN  || "";

// Carga historial: primero intenta JSONBin (persistente en Render), luego archivo local
const cargarHistorialBalance = async () => {
  if (JSONBIN_KEY && JSONBIN_BIN) {
    try {
      const r = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`,
        { headers: { "X-Master-Key": JSONBIN_KEY }, timeout: 8000 });
      const data = r.data?.record?.historial;
      if (Array.isArray(data) && data.length) {
        console.log(`☁️  Historial cargado de JSONBin (${data.length} días)`);
        return data;
      }
    } catch(e) { console.log("⚠️ JSONBin load:", e.message); }
  }
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch(_) {}
  return [{ dia: "Inicio", valor: CFG.budget }];
};

let historialBalance = [{ dia: "Inicio", valor: CFG.budget }];

// Copy trading
let copiandoSet     = new Set();
let ultimaActividad = {};
let tradersCache    = [];

// Balance real
let balanceCash      = null;
let balanceEnPos     = null;
let balanceTotalReal = null;
let balanceBaseReal  = null;

const guardarHistorialBalance = async () => {
  const data = historialBalance.slice(-90);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data)); } catch(_) {}
  if (JSONBIN_KEY && JSONBIN_BIN) {
    try {
      await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`,
        { historial: data },
        { headers: { "X-Master-Key": JSONBIN_KEY, "Content-Type": "application/json" }, timeout: 8000 });
    } catch(e) { console.log("⚠️ JSONBin save:", e.message); }
  }
};

const actualizarBalanceReal = async () => {
  if (!modoReal) return;
  try {
    const [bal, pos] = await Promise.all([
      pmUs.get("/v1/account/balances"),
      pmUs.get("/v1/portfolio/positions"),
    ]);
    const cash   = parseFloat(bal.balances?.[0]?.currentBalance || 0);
    const posObj = (pos?.positions && typeof pos.positions==="object" && !Array.isArray(pos.positions)) ? pos.positions : {};
    const enPos  = Object.values(posObj).filter(p => parseFloat(p.netPosition||0) > 0)
                         .reduce((s,p) => s + parseFloat(p.cost?.value||0), 0);
    balanceCash      = parseFloat(cash.toFixed(2));
    balanceEnPos     = parseFloat(enPos.toFixed(2));
    balanceTotalReal = parseFloat((cash + enPos).toFixed(2));
    if (balanceBaseReal === null) balanceBaseReal = balanceTotalReal;
    console.log(`💰 Balance: $${balanceTotalReal} (cash $${balanceCash} + pos $${balanceEnPos})`);

    // Guardar punto de balance diario
    const hoy = new Date().toLocaleDateString("es-ES", { day:"2-digit", month:"2-digit" });
    const last = historialBalance[historialBalance.length - 1];
    if (!last || last.dia !== hoy) {
      historialBalance.push({ dia: hoy, valor: balanceTotalReal });
      guardarHistorialBalance();
    } else if (Math.abs((last.valor || 0) - balanceTotalReal) >= 0.5) {
      last.valor = balanceTotalReal;
      guardarHistorialBalance();
    }
  } catch(e) { console.log("⚠️ Balance err:", e.response?.status || e.message); }
};

// Sincroniza posicionesAbiertas con las posiciones reales de polymarket.us al arrancar
const sincronizarPosiciones = async () => {
  if (!modoReal) return;
  try {
    const pos    = await pmUs.get("/v1/portfolio/positions");
    const posObj = (pos?.positions && typeof pos.positions==="object" && !Array.isArray(pos.positions)) ? pos.positions : {};
    const abiertas = Object.values(posObj).filter(p => parseFloat(p.netPosition||0) > 0);
    let nuevas = 0;
    for (const p of abiertas) {
      const meta   = p.marketMetadata || {};
      const slug   = meta.slug || "";
      if (!slug || posicionesAbiertas.find(x => x.slug === slug)) continue;
      const shares = parseFloat(p.netPosition || 0);
      const costo  = parseFloat(p.cost?.value || 0);
      const avgPx  = parseFloat(p.avgPx || 0) || (shares > 0 ? costo / shares : 0);
      posicionesAbiertas.push({
        id:          Date.now() + Math.random(),
        marketId:    slug,
        slug,
        titulo:      meta.title || slug,
        categoria:   mapCategoria([], meta.title || "", slug),
        oddsEntrada: parseFloat(avgPx.toFixed(3)),
        oddsActual:  parseFloat(avgPx.toFixed(3)),
        stake:       parseFloat(costo.toFixed(2)),
        shares,
        potencial:   shares,
        ganancia:    parseFloat((shares - costo).toFixed(2)),
        pnl:         0,
        fuerza:      fuerzaPorOrigen(slug),
        estado:      "abierto",
        abiertaEn:   p.updateTime || new Date().toISOString(),
      });
      presupuestoUsado = parseFloat((presupuestoUsado + costo).toFixed(2));
      nuevas++;
    }
    if (nuevas > 0) console.log(`🔄 ${nuevas} posiciones sincronizadas ($${presupuestoUsado.toFixed(2)} invertidos)`);
  } catch(e) { console.log("⚠️ Sync posiciones:", e.message); }
};

// ── CATEGORÍAS ─────────────────────────────────────────────────────────────────
const mapCategoria = (tags=[], question="", slug="") => {
  const t = (tags.join(" ") + " " + question + " " + slug).toLowerCase();
  const hasW = (...ws) => ws.some(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}([^a-z0-9]|$)`).test(t));
  if (t.includes("s&p 500")||t.includes("s&p500")||t.includes("sp500")||hasW("s&p","spx","spy")) return "SPX";
  if (t.includes("nasdaq")||hasW("qqq","ndx","nq"))       return "NQ";
  if (t.includes("dow jones")||hasW("djia","ym"))         return "DOW";
  if (t.includes("russell")||hasW("rut"))                 return "RUSSELL";
  if (hasW("vix")||t.includes("volatility index"))        return "VIX";
  if (t.includes("mlb")||t.includes("baseball")||t.includes("world series")||hasW("yankees","dodgers","mets","braves","astros","cubs")||t.includes("red sox")) return "BEISBOL";
  if (t.includes("nba")||t.includes("basketball")||hasW("lakers","warriors","celtics","nuggets","knicks","bulls","mavericks")||t.includes("miami heat")) return "NBA";
  if (t.includes("nfl")||t.includes("pro football")||t.includes("super bowl")||hasW("chiefs","cowboys","eagles","patriots")) return "NFL";
  if (t.includes("nhl")||t.includes("hockey")||t.includes("stanley cup")) return "NHL";
  if (hasW("ufc","mma")||t.includes("boxing"))            return "UFC";
  if (t.includes("pga")||t.includes("fedex cup")||t.includes("golf")||t.includes("the masters")||t.includes("ryder cup")) return "GOLF";
  if (t.includes("tennis")||t.includes("wimbledon")||t.includes("atp")||t.includes("wta")||t.includes("roland garros")||t.includes("australian open")||t.includes("french open")||t.includes("grass court")) return "TENIS";
  if (t.includes("soccer")||t.includes("world cup")||t.includes("premier league")||t.includes("champions league")||t.includes("la liga")||t.includes("bundesliga")||t.includes("serie a")||hasW("madrid","barcelona")) return "SOCCER";
  if (t.includes("formula 1")||t.includes("grand prix")||hasW("f1")) return "F1";
  if (t.includes("sport")) return "SPORTS";
  if (t.includes("bitcoin")||t.includes("ethereum")||t.includes("solana")||t.includes("crypto")||hasW("btc","eth","sol","xrp")) return "CRYPTO";
  if (t.includes("inflation")||t.includes("recession")||t.includes("interest rate")||hasW("fed","gdp","cpi","fomc")) return "MACRO";
  if (t.includes("elect")||t.includes("presid")||t.includes("congress")||t.includes("senate")||t.includes("shutdown")||hasW("trump","house")) return "POLITICA";
  return "WILDCARD";
};

const DEPORTIVOS = ["BEISBOL","NBA","NFL","NHL","SOCCER","UFC","SPORTS","TENIS","GOLF","F1"];
const esDeporteEnVivo  = (cat, prob, dias) => DEPORTIVOS.includes(cat) && dias <= 2 && prob >= 0.55;
const esIndiceIntraday = (cat, dias)       => ["SPX","NQ","DOW","VIX"].includes(cat) && dias <= 1;

// ── SISTEMA 1: SCREENER — escanea todos los mercados de polymarket.us ──────────
const fetchMercadosReales = async () => {
  try {
    console.log("\n🔍 Escaneando polymarket.us...");
    const PAGE = 100, BATCH = 20;

    // Pagina en batches de 20 requests paralelos hasta agotar todos los mercados
    const allMarkets = [];
    for (let off = 0; ; off += PAGE * BATCH) {
      const offs = Array.from({length: BATCH}, (_, i) => off + i * PAGE);
      const pages = await Promise.all(offs.map(o =>
        pmUs.get("/v1/markets", true, { limit: PAGE, offset: o, active: true, closed: false })
          .then(d => d?.markets || []).catch(() => [])
      ));
      const batch = pages.flat();
      allMarkets.push(...batch);
      // Para cuando la última página del batch devuelve menos de PAGE resultados
      // Solo salir si la última página tiene datos pero menos de PAGE (fin real de la lista).
      // Si lastPage es [] por error de red, no salir — podría haber más páginas válidas.
      const lastPage = pages[pages.length - 1];
      if (batch.length < PAGE * BATCH || (lastPage && lastPage.length > 0 && lastPage.length < PAGE)) break;
    }
    console.log(`📊 ${allMarkets.length} mercados descargados`);

    const ahora = Date.now();
    const seen  = new Set();
    const validos = [];

    // Día calendario en la zona del usuario (Arizona -07:00 por defecto) para clasificar cierre
    const TZ_OFFSET_MS = (CFG.tzOffsetHoras ?? -7) * 3600000;
    const diaCal = ms => Math.floor((ms + TZ_OFFSET_MS) / 86400000);
    const diaHoy = diaCal(ahora);

    for (const m of allMarkets) {
      if (!m.active || m.closed) continue;
      const uid = String(m.id || m.slug);
      if (seen.has(uid)) continue;
      seen.add(uid);

      // Solo compramos el lado LONG (YES). Precio = probabilidad actual
      const longSide = m.marketSides?.find(s => s.long === true);
      if (!longSide) continue;
      const prob = parseFloat(longSide.price || 0);
      if (!prob || prob <= 0 || prob >= 1) continue;

      const gameStartMs  = m.gameStartTime ? new Date(m.gameStartTime).getTime() : null;
      const endMs        = m.endDate       ? new Date(m.endDate).getTime()       : null;
      const diasRestantes = endMs ? Math.ceil((endMs - ahora) / 86400000) : 30;
      // diaCierre = 0 cierra HOY, 1 cierra MAÑANA, 2+ más adelante (en zona del usuario)
      const diaCierre = endMs ? (diaCal(endMs) - diaHoy) : 99;
      // EN VIVO = juego ya empezó Y resuelve en ≤2 días (no captura eventos de meses)
      const enVivo = !!(gameStartMs && gameStartMs < ahora && endMs && endMs > ahora && diasRestantes <= 2);

      const categoria = mapCategoria(m.tags || [], m.question || "", m.slug || "");

      if (enVivo) {
        if (prob < 0.55) continue;
        console.log(`⚡ EN VIVO: ${m.question?.slice(0,55)} | ${(prob*100).toFixed(0)}%`);
      } else {
        if (prob < CFG.minOdds || prob > CFG.maxOdds) continue;
        if (diasRestantes < 0 || diasRestantes > CFG.maxDiasRestantes) continue;
        // Solo mercados que cierran HOY (0) o MAÑANA (1) — dinero rápido
        if (diaCierre > 1) continue;
      }

      validos.push({
        id: uid, slug: m.slug,
        titulo:   m.question || "Sin título",
        outcome:  longSide.description || "YES",
        categoria,
        prob: parseFloat(prob.toFixed(4)),
        diasRestantes, diaCierre, enVivo, stake: CFG.stake,
        fuerza: enVivo ? "🔴 EN VIVO"
               : prob >= 0.85 ? "MÁXIMA"
               : prob >= 0.78 ? "FUERTE"
               : prob >= 0.72 ? "MEDIA" : "DÉBIL",
      });
    }

    validos.sort((a,b) => (b.enVivo - a.enVivo) || (b.prob - a.prob));
    mercadosActivos = validos;
    console.log(`✅ Válidos: ${validos.length} (${validos.filter(m=>m.enVivo).length} EN VIVO)`);

    const nuevas = validos.filter(m =>
      !senalesPendientes.find(s => s.id === m.id) &&
      !posicionesAbiertas.find(p => p.marketId === m.id)
    );
    senalesPendientes = [...nuevas, ...senalesPendientes].slice(0, 300);
    console.log(`📡 ${nuevas.length} nuevas señales`);
    return validos;
  } catch(err) { console.error("❌ Scan err:", err.message); return []; }
};

// ── EJECUTAR TRADE ─────────────────────────────────────────────────────────────
const maxPos = () => Math.max(3, Math.floor(CFG.budget / CFG.stake));

const ejecutarTrade = async (mercado, stake, fuerza) => {
  const disponible = balanceCash !== null ? balanceCash : (CFG.budget - presupuestoUsado);
  if (disponible < stake || circuitBreaker || !botActivo) return null;
  if (posicionesAbiertas.length >= maxPos()) return null;
  if (posicionesAbiertas.find(p => p.marketId === mercado.id)) return null; // ya abierto

  const shares   = parseFloat((stake / mercado.prob).toFixed(2));
  const ganancia = parseFloat((shares - stake).toFixed(2));

  if (modoReal && mercado.slug) {
    try {
      console.log(`🔄 COMPRANDO: ${mercado.titulo?.slice(0,50)} — $${stake} @ ${(mercado.prob*100).toFixed(0)}%`);
      const resp = await pmComprar(mercado.slug, mercado.prob, shares);
      console.log(`✅ OK:`, JSON.stringify(resp).slice(0,80));
    } catch(e) {
      console.log(`⚠️ Error compra: ${e.response?.data?.message||e.message}`);
      return null;
    }
  } else {
    console.log(`📊 SIM: ${mercado.titulo?.slice(0,40)} @ ${(mercado.prob*100).toFixed(0)}%`);
  }

  const trade = {
    id:Date.now(), marketId:mercado.id, slug:mercado.slug,
    titulo:mercado.titulo, categoria:mercado.categoria,
    oddsEntrada:mercado.prob, oddsActual:mercado.prob,
    stake:parseFloat(stake.toFixed(2)), shares, potencial:shares, ganancia,
    pnl:0, fuerza, tradersCount:mercado.tradersCount||1,
    estado:"abierto", abiertaEn:new Date().toISOString(),
  };
  marcarOrigen(mercado.slug, "SCREENER");
  posicionesAbiertas.push(trade);
  historialTrades.unshift({ ...trade });
  presupuestoUsado = parseFloat((presupuestoUsado + stake).toFixed(2));
  tradesHoy++;
  return trade;
};

// Auto-buy Sistema 1: cada 3 min compra señales válidas de polymarket.us
const autoComprarSenales = async () => {
  if (!botActivo || circuitBreaker || !CFG.autoComprar) return;
  const disponible = balanceCash !== null ? balanceCash : (CFG.budget - presupuestoUsado);
  if (disponible < CFG.stake) { console.log(`💸 Sin cash ($${disponible})`); return; }

  const candidatos = senalesPendientes.filter(s =>
    s.slug && !posicionesAbiertas.find(p => p.marketId === s.id) && posicionesAbiertas.length < maxPos()
  )
  // Prioridad: cierran HOY primero (diaCierre 0 / en vivo), luego MAÑANA (1). Dentro de cada día, mayor prob.
  .sort((a, b) => ((a.diaCierre ?? 99) - (b.diaCierre ?? 99)) || (b.enVivo - a.enVivo) || (b.prob - a.prob));
  if (!candidatos.length) return;
  console.log(`🔎 Auto-buy: ${candidatos.length} candidatos (hoy: ${candidatos.filter(c=>c.diaCierre===0||c.enVivo).length}, mañana: ${candidatos.filter(c=>c.diaCierre===1&&!c.enVivo).length})`);

  let compradas = 0;
  for (const s of candidatos.slice(0, 5)) {
    if (posicionesAbiertas.length >= maxPos()) break;
    const t = await ejecutarTrade(s, CFG.stake, s.fuerza);
    // Sacar de la cola tanto si compró como si falló (evitar reintentos infinitos)
    senalesPendientes = senalesPendientes.filter(x => x.id !== s.id);
    if (t) compradas++;
    await new Promise(r => setTimeout(r, 700));
  }
  console.log(`🤖 Sistema1: ${compradas} compradas`);
};

// ── SISTEMA 2: COPY TRADING ────────────────────────────────────────────────────
const fetchLeaderboard = async () => {
  // Intentar JSON API directo primero
  try {
    const res = await axios.get(`${DATA_API}/profiles`, {
      params:{ sortBy:"pnl", limit:30 }, timeout:12000, headers:{"Accept":"application/json"},
    });
    const raw = Array.isArray(res.data) ? res.data : (res.data?.data || []);
    if (raw.length) {
      console.log(`🏆 Leaderboard API: ${raw.length} perfiles`);
      return raw.filter(t=>(t.pnl||0)>0).slice(0,25).map(t => ({
        wallet:    t.proxyWallet||t.address||"",
        alias:     t.name||t.pseudonym||(t.proxyWallet||"??").slice(0,8)+"…",
        winRate:   Math.min(95, 60+Math.floor((t.pnl||0)/10000)),
        roi:       t.volume>0 ? parseFloat(((t.pnl/t.volume)*100).toFixed(1)) : 0,
        pnl:       parseFloat((t.pnl||0).toFixed(2)),
        volumen:   Math.round(t.volume||0),
        categoria: "MIXED", activo:"activo",
        copiando:  copiandoSet.has(t.proxyWallet||t.address),
        score:     Math.min(99, Math.max(50, 50+Math.floor((t.pnl||0)/5000))),
      }));
    }
  } catch(_) {}

  // Fallback: scraping HTML
  try {
    const res = await axios.get("https://polymarket.com/leaderboard", {
      timeout:15000, headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    });
    const m = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("No __NEXT_DATA__");
    const nd  = JSON.parse(m[1]);
    const qs  = nd?.props?.pageProps?.dehydratedState?.queries || [];
    const lbq = qs.find(q => Array.isArray(q?.state?.data) && q.state.data[0]?.proxyWallet);
    const raw = lbq?.state?.data || [];
    if (!raw.length) throw new Error("Sin datos");
    const top = raw.filter(t=>t.pnl>0).sort((a,b)=>b.pnl-a.pnl).slice(0,25);
    console.log(`🏆 Scraping: ${top.length} traders`);
    return top.map(t => ({
      wallet:t.proxyWallet, alias:t.pseudonym||t.name||t.proxyWallet.slice(0,8)+"…",
      winRate:Math.min(95,60+Math.floor(t.pnl/10000)), roi:t.volume>0?parseFloat(((t.pnl/t.volume)*100).toFixed(1)):0,
      pnl:parseFloat(t.pnl.toFixed(2)), volumen:Math.round(t.volume), categoria:"MIXED", activo:`rank #${t.rank}`,
      copiando:copiandoSet.has(t.proxyWallet), score:Math.min(99,Math.max(50,50+Math.floor(t.pnl/5000))),
    }));
  } catch(e) { console.log("⚠️ Leaderboard falló:", e.message); return []; }
};

// Auto-follow top N traders sin que el usuario presione COPY
const autoSeguirTopTraders = async (n=25) => {
  if (!CFG.autoCopiar || !tradersCache.length) return;
  let nuevos = 0;
  for (const t of tradersCache.filter(t=>t.wallet).slice(0,n)) {
    if (copiandoSet.has(t.wallet)) continue;
    copiandoSet.add(t.wallet);
    const acts = await getTraderActivity(t.wallet);
    ultimaActividad[t.wallet] = new Set(acts.map(a=>a.id||a.hash||a.transactionHash).filter(Boolean));
    nuevos++;
  }
  if (nuevos>0) console.log(`🤖 Auto-follow: +${nuevos} traders (total ${copiandoSet.size})`);
};

const getTraderActivity = async (wallet) => {
  try {
    const res = await axios.get(`${DATA_API}/activity`, {
      params:{ user:wallet, limit:20 }, timeout:10000, headers:{"Accept":"application/json"},
    });
    return Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.history || []);
  } catch(e) { return []; }
};

const ejecutarCopyTrade = async (act, wallet) => {
  if (!botActivo || circuitBreaker || !CFG.autoCopiar) return;
  const disponible = balanceCash !== null ? balanceCash : (CFG.budget - presupuestoUsado);
  if (disponible < CFG.stake || posicionesAbiertas.length >= maxPos()) return;

  const slug  = act.market?.slug || act.slug;
  const title = act.market?.question || act.title || slug || "Copy Trade";
  const prob  = parseFloat(act.price || act.avgPrice || 0.75);
  if (!prob || prob < 0.50 || prob > 0.98 || !slug) return;
  if (posicionesAbiertas.find(p => p.slug === slug)) return; // Evitar doble compra del mismo mercado

  const shares = parseFloat((CFG.stake / prob).toFixed(2));

  if (modoReal) {
    try {
      await pmComprar(slug, prob, shares);
      console.log(`✅ COPY: ${title.slice(0,40)} @ ${(prob*100).toFixed(0)}%`);
    } catch(e) { console.log(`⚠️ COPY err: ${e.response?.data?.message||e.message}`); return; }
  }

  const trade = {
    id:Date.now(), marketId:act.conditionId||slug, slug,
    titulo:`[COPY ${wallet.slice(0,6)}…] ${title}`,
    categoria:mapCategoria([],title,slug), oddsEntrada:prob, oddsActual:prob,
    stake:CFG.stake, shares, potencial:shares, ganancia:parseFloat((shares-CFG.stake).toFixed(2)),
    pnl:0, fuerza:"🔁 COPY", estado:"abierto", abiertaEn:new Date().toISOString(),
  };
  marcarOrigen(slug, "COPY");
  posicionesAbiertas.push(trade);
  historialTrades.unshift({...trade});
  presupuestoUsado = parseFloat((presupuestoUsado+CFG.stake).toFixed(2));
  tradesHoy++;
  console.log(`📋 COPY #${tradesHoy}: ${trade.titulo.slice(0,50)}`);
};

const cerrarCopyTrade = async (act, wallet) => {
  const slug = act.market?.slug || act.slug;
  if (!slug) return;
  const idx = posicionesAbiertas.findIndex(p => p.slug===slug && (p.titulo||"").includes(`COPY ${wallet.slice(0,6)}`));
  if (idx===-1) return;
  const pos = posicionesAbiertas[idx];
  if (modoReal) { try { await pmCerrar(slug); } catch(e) { console.log(`⚠️ COPY close:${e.message}`); } }
  const probSalida = parseFloat(act.price||act.avgPrice||pos.oddsActual||pos.oddsEntrada);
  const pnl = parseFloat(((probSalida-pos.oddsEntrada)*pos.shares).toFixed(2));
  pos.estado="cerrado_copy"; pos.pnl=pnl; pos.oddsActual=probSalida;
  pnlHoy=parseFloat((pnlHoy+pnl).toFixed(2)); balanceReal=parseFloat((balanceReal+pnl).toFixed(2));
  if(pnl>=0) { ganados++; rachaPerder=0; }
  else       { perdidos++; rachaPerder++; if(rachaPerder>=5) { circuitBreaker=true; console.log("🚨 Circuit breaker activado"); } }
  presupuestoUsado=parseFloat(Math.max(0,presupuestoUsado-pos.stake).toFixed(2));
  historialTrades.unshift({...pos, cerradaEn:new Date().toISOString()});
  posicionesAbiertas.splice(idx,1);
  console.log(`📋 COPY cerrado PnL $${pnl} | racha: ${rachaPerder}`);
};

const copiarTrades = async () => {
  if (!botActivo || !CFG.autoCopiar) return;
  // Auto-follow si no hay traders todavía
  if (copiandoSet.size===0 && tradersCache.length>0) await autoSeguirTopTraders(25);
  if (copiandoSet.size===0) { console.log("🔁 Copy: sin traders en cache"); return; }

  console.log(`🔁 Chequeando ${copiandoSet.size} traders...`);
  for (const wallet of copiandoSet) {
    const actividades = await getTraderActivity(wallet);
    if (!actividades.length) continue;

    if (!ultimaActividad[wallet]) {
      ultimaActividad[wallet] = new Set(actividades.map(a=>a.id||a.hash||a.transactionHash).filter(Boolean));
      continue;
    }

    const vistas = ultimaActividad[wallet];
    const nuevas = actividades.filter(a => { const id=a.id||a.hash||a.transactionHash; return id&&!vistas.has(id); });
    for (const act of nuevas) {
      const id = act.id||act.hash||act.transactionHash; vistas.add(id);
      const lado = (act.side||act.type||"").toUpperCase();
      console.log(`🆕 ${wallet.slice(0,8)} ${lado||"?"}: ${act.market?.question?.slice(0,38)||id}`);
      if (lado==="BUY"||act.outcome==="YES") await ejecutarCopyTrade(act, wallet);
      else if (lado==="SELL")               await cerrarCopyTrade(act, wallet);
    }
  }
};

// ── TIMERS ─────────────────────────────────────────────────────────────────────
// Al arrancar: carga historial (JSONBin o archivo), luego inicia el bot
cargarHistorialBalance().then(data => {
  historialBalance = data;
  return actualizarBalanceReal();
}).then(() => sincronizarPosiciones()).then(() =>
  fetchMercadosReales().then(() => setTimeout(autoComprarSenales, 5000))
);
setInterval(fetchMercadosReales,      5*60*1000);  // scan cada 5 min
setInterval(autoComprarSenales,       3*60*1000);  // Sistema1: compra cada 3 min
setInterval(copiarTrades,             2*60*1000);  // Sistema2: copy cada 2 min
setInterval(actualizarBalanceReal,      30*1000);  // balance cada 30s
setInterval(sincronizarPosiciones,      60*1000);  // re-sync posiciones cada 1 min

fetchLeaderboard().then(t => {
  tradersCache = t;
  autoSeguirTopTraders(25); // Auto-follow al arrancar
});
setInterval(async () => {
  tradersCache = await fetchLeaderboard();
  autoSeguirTopTraders(25);
}, 60*60*1000);

// Cierra posiciones que llevan más de maxHoldHoras abiertas
const cerrarPosicionesAntiguas = async () => {
  const limiteMs = CFG.maxHoldHoras * 60 * 60 * 1000;
  const ahora    = Date.now();
  const antiguas = posicionesAbiertas.filter(p =>
    p.abiertaEn && (ahora - new Date(p.abiertaEn).getTime()) > limiteMs
  );
  if (!antiguas.length) return;
  console.log(`⏰ Cerrando ${antiguas.length} posiciones con más de ${CFG.maxHoldHoras}h`);
  for (const pos of antiguas) {
    if (modoReal && pos.slug) {
      try { await pmCerrar(pos.slug); }
      catch(e) { console.log(`⚠️ Auto-close err ${pos.slug}: ${e.message}`); }
    }
    const precioActual = pos.slug ? await pmPrecioActual(pos.slug).catch(()=>null) : null;
    const odds = precioActual || pos.oddsActual || pos.oddsEntrada;
    const pnl  = parseFloat((pos.stake * odds - pos.stake).toFixed(2));
    pos.estado = "cerrado_tiempo"; pos.pnl = pnl;
    pnlHoy    = parseFloat((pnlHoy + pnl).toFixed(2));
    balanceReal = parseFloat((balanceReal + pnl).toFixed(2));
    if (pnl >= 0) { ganados++; rachaPerder = 0; }
    else          { perdidos++; rachaPerder++; if (rachaPerder >= 5) circuitBreaker = true; }
    presupuestoUsado = parseFloat(Math.max(0, presupuestoUsado - pos.stake).toFixed(2));
    historialTrades.unshift({ ...pos, cerradaEn: new Date().toISOString() });
    const idx = posicionesAbiertas.findIndex(p => p.id === pos.id);
    if (idx !== -1) posicionesAbiertas.splice(idx, 1);
    console.log(`⏰ Cerrado: ${pos.titulo?.slice(0,40)} | PnL $${pnl}`);
  }
  if (modoReal) setTimeout(actualizarBalanceReal, 2000);
};
setInterval(cerrarPosicionesAntiguas, 30*60*1000); // cierre automático cada 30 min

cron.schedule("0 0 * * *", () => {
  pnlHoy=0; tradesHoy=0; ganados=0; perdidos=0;
  presupuestoUsado=0; rachaPerder=0; circuitBreaker=false;
  const valorDia = balanceTotalReal ?? balanceReal;
  historialBalance.push({ dia:new Date().toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit"}), valor:valorDia });
  guardarHistorialBalance();
});

// ── ENDPOINTS ──────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const wr = (ganados+perdidos)>0 ? (ganados/(ganados+perdidos)*100) : 0;
  const balanceMostrado = balanceTotalReal !== null ? balanceTotalReal : balanceReal;
  res.json({
    botActivo, circuitBreaker, balance:balanceMostrado,
    balanceCash, balanceEnPos, balanceTotalReal, balanceBase:balanceBaseReal,
    pnlHoy:parseFloat(pnlHoy.toFixed(2)), tradesHoy, ganados, perdidos,
    winRate:parseFloat(wr.toFixed(1)),
    presupuestoTotal:    balanceTotalReal !== null ? balanceTotalReal : CFG.budget,
    presupuestoUsado:    balanceEnPos     !== null ? balanceEnPos     : parseFloat(presupuestoUsado.toFixed(2)),
    presupuestoRestante: balanceCash      !== null ? balanceCash      : parseFloat((CFG.budget - presupuestoUsado).toFixed(2)),
    stake:CFG.stake, minOdds:CFG.minOdds, maxOdds:CFG.maxOdds,
    mercadosEscaneados:mercadosActivos.length,
    unrealizedPnl:parseFloat(posicionesAbiertas.reduce((s,t)=>s+(t.pnl||0),0).toFixed(2)),
    apiConectada:!!CFG.keyId, modoReal,
    keyIdActivo:modoReal?pmUs.keyId?.slice(0,8)+"…":null,
    tradersCopiados:copiandoSet.size,
    posicionesAbiertas:posicionesAbiertas.length,
    posicionesCopy:posicionesAbiertas.filter(p=>(p.fuerza||"").includes("COPY")).length,
    autoComprar:CFG.autoComprar, autoCopiar:CFG.autoCopiar,
    maxPositiones:maxPos(), maxHoldHoras:CFG.maxHoldHoras, maxDiasRestantes:CFG.maxDiasRestantes,
  });
});

app.get("/api/markets",           (req, res) => res.json(mercadosActivos.slice(0,100)));
app.get("/api/signals/pending",   (req, res) => res.json(senalesPendientes.slice(0,50)));
app.get("/api/trades/open",       (req, res) => res.json(posicionesAbiertas));
const num = v => parseFloat(v?.value ?? v ?? 0) || 0;
app.get("/api/trades/historial", async (req, res) => {
  const cerradosLocales = historialTrades.filter(t => t.estado && t.estado !== "abierto");
  // En modo real, leer actividades directamente desde polymarket.us
  if (modoReal) {
    try {
      const actRes = await pmUs.get("/v1/portfolio/activities", true, { limit: 50 });
      const actArr = Array.isArray(actRes?.activities) ? actRes.activities : [];
      if (req.query.debug) {
        const resol = actArr.find(a => (a.type || "").includes("RESOLUTION"));
        return res.json(resol || { sinResolucion: true });
      }
      // Solo RESOLUCIONES = mercados liquidados con P&L real.
      // (Las COMPRAS son posiciones abiertas; los cierres del bot ya estan en cerradosLocales.)
      const fromApi = actArr
        .filter(a => (a.type || "").includes("RESOLUTION"))
        .map(a => {
          const r      = a.positionResolution || {};
          const before = r.beforePosition || {};
          const after  = r.afterPosition  || {};
          const meta   = before.marketMetadata || after.marketMetadata || {};
          const titulo = r.market?.question || meta.title || meta.slug || "";
          const slug   = r.marketSlug || r.market?.slug || meta.slug || "";
          const precio = num(before.avgPx);                          // precio de entrada
          const stake  = num(before.cost) || num(before.baseCost);   // costo invertido
          const pnl    = parseFloat((num(after.realized) - num(before.realized)).toFixed(2)); // P&L realizado
          const estado = pnl >= 0 ? "ganado" : "perdido";
          return { titulo, slug, oddsEntrada: precio, stake, pnl, estado, abiertaEn: r.updateTime };
        })
        .filter(t => t.titulo);
      const slugsLocales = new Set(cerradosLocales.map(t => t.slug).filter(Boolean));
      const fromApiUnico = fromApi.filter(a => !a.slug || !slugsLocales.has(a.slug));
      return res.json([...cerradosLocales, ...fromApiUnico].slice(0, 50));
    } catch(e) { /* fallback */ }
  }
  res.json(cerradosLocales.slice(0, 50));
});
app.get("/api/balance/historial", (req, res) => res.json(historialBalance));

app.get("/api/traders", async (req, res) => {
  if (!tradersCache.length) tradersCache = await fetchLeaderboard();
  if (tradersCache.length) return res.json(tradersCache.map(t=>({...t, copiando:copiandoSet.has(t.wallet)})));
  res.json([
    {wallet:"0x7f3a1234",alias:"Theo4",    winRate:84,roi:340,categoria:"CRYPTO",  activo:"2h",score:94,copiando:copiandoSet.has("0x7f3a1234")},
    {wallet:"0x9b2c5678",alias:"beachboy4",winRate:79,roi:280,categoria:"SPORTS",  activo:"5h",score:88,copiando:copiandoSet.has("0x9b2c5678")},
    {wallet:"0x4e1d9abc",alias:"HorizonS", winRate:77,roi:195,categoria:"MACRO",   activo:"1d",score:72,copiando:copiandoSet.has("0x4e1d9abc")},
    {wallet:"0xAB21cdef",alias:"gopfan2",  winRate:75,roi:142,categoria:"CRYPTO",  activo:"3h",score:68,copiando:copiandoSet.has("0xAB21cdef")},
    {wallet:"0xC932ef01",alias:"reachingS",winRate:76,roi:168,categoria:"POLITICA",activo:"6h",score:80,copiando:copiandoSet.has("0xC932ef01")},
  ]);
});

app.post("/api/signals/:id/ejecutar", async (req, res) => {
  const rid = req.params.id;
  const s = senalesPendientes.find(x => String(x.id) === rid);
  if (!s) return res.status(404).json({ error:"No encontrada", id: rid, total: senalesPendientes.length });
  const t = await ejecutarTrade(s, s.stake, s.fuerza);
  if (t) senalesPendientes = senalesPendientes.filter(x=>String(x.id)!==rid);
  res.json({ success:!!t, trade:t });
});

app.post("/api/signals/:id/saltar", (req, res) => {
  const rid = req.params.id;
  senalesPendientes = senalesPendientes.filter(s=>String(s.id)!==rid);
  res.json({ success:true });
});

app.post("/api/trades/:id/cerrar", async (req, res) => {
  const idx = posicionesAbiertas.findIndex(t=>t.id===parseInt(req.params.id));
  if (idx===-1) return res.status(404).json({ error:"No encontrada" });
  const trade = posicionesAbiertas[idx];
  // Precio de mercado actual para P&L real (oddsActual nunca se actualiza solo)
  if (trade.slug) {
    const precioActual = await pmPrecioActual(trade.slug).catch(() => null);
    if (precioActual) trade.oddsActual = precioActual;
  }
  // Cerrar en Polymarket si es modo real
  if (modoReal && trade.slug) {
    try { await pmCerrar(trade.slug); }
    catch(e) { console.log(`⚠️ Close err: ${e.response?.data?.message||e.message}`); }
  }
  const pnl = parseFloat((trade.stake*trade.oddsActual-trade.stake).toFixed(2));
  trade.estado="cerrado_manual"; trade.pnl=pnl;
  pnlHoy=parseFloat((pnlHoy+pnl).toFixed(2)); balanceReal=parseFloat((balanceReal+pnl).toFixed(2));
  if(pnl>=0) { ganados++; rachaPerder=0; }
  else       { perdidos++; rachaPerder++; if(rachaPerder>=5) { circuitBreaker=true; console.log("🚨 Circuit breaker activado"); } }
  historialTrades.unshift({...trade, cerradaEn:new Date().toISOString()});
  posicionesAbiertas.splice(idx,1);
  if (modoReal) setTimeout(actualizarBalanceReal, 2000);
  res.json({ success:true, pnl });
});

app.post("/api/trades/:id/aumentar", (req, res) => {
  const trade = posicionesAbiertas.find(t=>t.id===parseInt(req.params.id));
  if (!trade) return res.status(404).json({ error:"No encontrada" });
  const extra = parseFloat(req.body.monto)||CFG.stake;
  trade.stake = parseFloat((trade.stake+extra).toFixed(2));
  trade.shares = parseFloat((trade.stake/trade.oddsEntrada).toFixed(2));
  trade.potencial=trade.shares; trade.ganancia=parseFloat((trade.potencial-trade.stake).toFixed(2));
  presupuestoUsado=parseFloat((presupuestoUsado+extra).toFixed(2));
  res.json({ success:true, nuevoStake:trade.stake, nuevoPotencial:trade.potencial });
});

// ── POSICIONES REALES ──────────────────────────────────────────────────────────
app.get("/api/mis-posiciones", async (req, res) => {
  if (!modoReal) return res.json({ error:"Sin credenciales", modoReal:false, posiciones:[], trades:[] });
  try {
    const [posRes, actRes] = await Promise.all([
      pmUs.get("/v1/portfolio/positions").catch(e=>{ console.log("pos err:",e.message); return {}; }),
      pmUs.get("/v1/portfolio/activities", true, { limit:30 }).catch(e=>{ console.log("act err:",e.message); return {}; }),
    ]);
    const posObj = (posRes?.positions&&typeof posRes.positions==="object"&&!Array.isArray(posRes.positions))?posRes.positions:{};
    const posBase = Object.values(posObj).filter(p=>parseFloat(p.netPosition||0)>0).map(p=>{
      const shares=parseFloat(p.netPosition||0), costo=parseFloat(p.cost?.value||0), meta=p.marketMetadata||{};
      return { titulo:meta.title||meta.slug||"Posición", slug:meta.slug||"", outcome:meta.outcome||"",
               icono:meta.team?.logo||meta.team?.longIcon||meta.icon||"",
               shares, costo:parseFloat(costo.toFixed(2)), precioProm:shares>0?parseFloat((costo/shares).toFixed(3)):0 };
    });
    const posiciones = await Promise.all(posBase.map(async p => {
      const precioActual = await pmPrecioActual(p.slug);
      if (precioActual===null) return {...p, precioActual:null, valorActual:null, pnl:null, pnlPct:null};
      const valorActual = parseFloat((p.shares*precioActual).toFixed(2));
      const pnl    = parseFloat((valorActual-p.costo).toFixed(2));
      const pnlPct = p.costo>0 ? parseFloat(((pnl/p.costo)*100).toFixed(1)) : 0;
      return {...p, precioActual:parseFloat(precioActual.toFixed(3)), valorActual, pnl, pnlPct};
    }));
    const actArr = Array.isArray(actRes?.activities)?actRes.activities:[];
    const trades = actArr.slice(0,30).map(a=>{
      const r=a.positionResolution||a.trade||a.fill||a.order||{};
      const meta=r.marketMetadata||r.beforePosition?.marketMetadata||{};
      return { titulo:meta.title||meta.slug||(a.type||"").replace("ACTIVITY_TYPE_","")||"Actividad", tipo:(a.type||"").replace("ACTIVITY_TYPE_","").replace(/_/g," ") };
    });
    res.json({ modoReal:true, keyId:pmUs.keyId?.slice(0,8)+"…", posiciones, trades });
  } catch(e) { console.error("Error posiciones:", e.message); res.json({ error:e.message, modoReal:true, posiciones:[], trades:[] }); }
});

app.post("/api/mis-posiciones/comprar", async (req, res) => {
  if (!modoReal) return res.status(400).json({ error:"Modo simulación" });
  const { slug, monto } = req.body;
  if (!slug) return res.status(400).json({ error:"Falta slug" });
  try {
    const b = await pmBbo(slug);
    const pc = b.ask||b.last||b.bid;
    if (!pc) return res.status(400).json({ error:"Sin precio" });
    const dolares  = parseFloat(monto)||CFG.stake;
    const quantity = Math.max(1,Math.round(dolares/pc));
    const r = await pmComprar(slug, pc, quantity);
    marcarOrigen(slug, "MANUAL");
    setTimeout(actualizarBalanceReal, 2000);
    res.json({ success:true, comprado:quantity, precio:pc, order:r });
  } catch(e) { res.status(500).json({ error:e.response?.data?.message||e.message }); }
});

app.post("/api/mis-posiciones/vender", async (req, res) => {
  if (!modoReal) return res.status(400).json({ error:"Modo simulación" });
  const { slug, shares } = req.body;
  if (!slug) return res.status(400).json({ error:"Falta slug" });
  try {
    const [pos, bbo] = await Promise.all([
      pmUs.get("/v1/portfolio/positions"),
      pmBbo(slug),
    ]);
    const p     = (pos?.positions||{})[slug];
    const total = p ? parseFloat(p.netPosition||0) : 0;
    if (total <= 0) return res.status(400).json({ error:"Sin posición abierta" });

    const bidActual = bbo.bid || 0;
    if (bidActual < 0.02) {
      // Sin liquidez real — informar al usuario en vez de ejecutar y fallar silenciosamente
      return res.json({
        success:   false,
        sinLiquidez: true,
        bid:       bidActual,
        error:     `Sin compradores ahora (bid ${(bidActual*100).toFixed(0)}%). El mercado resolverá automáticamente al final del partido.`,
      });
    }

    const vender = Math.min(parseInt(shares) || total, total);
    const r      = await pmVender(slug, vender);
    const fills  = r?.executions?.length || r?.fills?.length || 0;
    setTimeout(actualizarBalanceReal, 2000);
    if (fills === 0) {
      return res.json({
        success:  false,
        sinFill:  true,
        bid:      bidActual,
        error:    `Orden enviada pero sin fill (bid ${(bidActual*100).toFixed(0)}%). Prueba de nuevo en unos segundos.`,
      });
    }
    res.json({ success:true, vendido:vender, total, order:r });
  } catch(e) { res.status(500).json({ error:e.response?.data?.message||e.message }); }
});

app.post("/api/mis-posiciones/cerrar", async (req, res) => {
  if (!modoReal) return res.status(400).json({ error:"Modo simulación" });
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error:"Falta slug" });
  try { const r=await pmCerrar(slug); setTimeout(actualizarBalanceReal,2000); res.json({ success:true, order:r }); }
  catch(e) { res.status(500).json({ error:e.response?.data?.message||e.message }); }
});

app.post("/api/bot/pausar",        (req, res) => { botActivo=false; res.json({ botActivo }); });
app.post("/api/bot/reanudar",      (req, res) => { botActivo=true;  res.json({ botActivo }); });
app.post("/api/bot/reset-circuit", (req, res) => { circuitBreaker=false; rachaPerder=0; res.json({ success:true }); });
app.post("/api/bot/scan-ahora",    async (req,res) => { const m=await fetchMercadosReales(); await autoComprarSenales(); res.json({ mercados:m.length }); });

app.post("/api/traders/:w/toggle", (req, res) => {
  const wallet = req.params.w;
  if (copiandoSet.has(wallet)) {
    copiandoSet.delete(wallet); delete ultimaActividad[wallet];
    res.json({ success:true, copiando:false });
  } else {
    copiandoSet.add(wallet);
    getTraderActivity(wallet).then(acts => {
      ultimaActividad[wallet] = new Set(acts.map(a=>a.id||a.hash||a.transactionHash).filter(Boolean));
    });
    res.json({ success:true, copiando:true });
  }
});

app.post("/api/config", (req, res) => {
  const { stake, presupuesto, minOdds, maxOdds, autoComprar, autoCopiar } = req.body;
  if (stake       !==undefined) CFG.stake      =parseFloat(stake);
  if (presupuesto !==undefined) CFG.budget     =parseFloat(presupuesto);
  if (minOdds     !==undefined) CFG.minOdds    =parseFloat(minOdds);
  if (maxOdds     !==undefined) CFG.maxOdds    =parseFloat(maxOdds);
  if (autoComprar       !==undefined) CFG.autoComprar      =!!autoComprar;
  if (autoCopiar        !==undefined) CFG.autoCopiar       =!!autoCopiar;
  if (req.body.maxHoldHoras     !==undefined) CFG.maxHoldHoras     =parseInt(req.body.maxHoldHoras);
  if (req.body.maxDiasRestantes !==undefined) CFG.maxDiasRestantes =parseInt(req.body.maxDiasRestantes);
  guardarCFG();
  res.json({ success:true });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🤖 POLYBOT v2 — http://localhost:${PORT}`);
  console.log(`💰 Budget: $${CFG.budget} | Stake: $${CFG.stake} | Odds: ${CFG.minOdds*100}%-${CFG.maxOdds*100}%`);
  console.log(`🔑 API: ${CFG.keyId?"✅":"❌"} | 🤖 Auto-buy: ON | 📋 Copy: ON\n`);
});
