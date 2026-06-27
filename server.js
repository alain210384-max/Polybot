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

// ════════════════════════════════════════════════════════════════════════════════
//  POLYBOT — SISTEMA DE CONSENSO (los motores viejos Screener + Copy fueron eliminados)
//  Única fuente de señales: mercados donde ≥ minOverlap top-traders coinciden en el
//  MISMO lado. Billetera, posiciones, P&L y dashboard = tu sistema de siempre.
// ════════════════════════════════════════════════════════════════════════════════

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const CFG_FILE = path.join(__dirname, "cfg.json");
const CFG_DEFAULTS = {
  minOdds:          0.55,
  maxOdds:          0.85,
  minLiquidity:     300,
  budget:           parseFloat(process.env.DAILY_BUDGET)    || 59,
  stake:            parseFloat(process.env.STAKE_PER_TRADE) || 3,
  keyId:            process.env.POLYMARKET_KEY_ID,
  secretKey:        process.env.POLYMARKET_SECRET_KEY,
  autoComprar:      true,   // auto-compra SEGURA: solo gemelos US verificados (equipo exacto + acuerdo de precio); ante duda, no compra
  maxHoldHoras:     24,
  maxDiasRestantes: 7,
  reinvertir:       false,  // auto-compounding: usa el balance real completo como presupuesto
  // ── Consenso ──
  minOverlap:       4,      // nº de top-traders que deben coincidir en el mismo mercado
  topTradersCount:  50,     // cuántos líderes del día se monitorean (pool ancho = hay overlap real)
  autoConsensus:    true,   // detectar consenso en bucle
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
  guardarBin();  // persistir también en JSONBin (cfg.json no sobrevive redeploys de Render)
};

// Origen de cada posición por slug (CONSENSO / MANUAL) — sobrevive reinicios
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
  origenPorSlug[slug] === "CONSENSO" ? "🐋 CONSENSO"
: origenPorSlug[slug] === "MANUAL"   ? "✋ MANUAL"
: "SYNC";

// Día calendario en la zona del usuario (Arizona -07:00 por defecto)
const diaCalendario = ms => Math.floor((ms + (CFG.tzOffsetHoras ?? -7) * 3600000) / 86400000);
// 0 = cierra HOY, 1 = cierra MAÑANA, 2+ más adelante (99 si no hay fecha)
const diaCierreDeMs = endMs => endMs ? (diaCalendario(endMs) - diaCalendario(Date.now())) : 99;
// Extrae fecha de cierre del nombre del slug (ej: "fifa-wc-2026-06-27-...") como fallback
const fechaDeSlug = slug => {
  const m = slug?.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}T23:59:00-07:00`).getTime();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prom  = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

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

// Valida que el mercado del consenso EXISTE y es operable en polymarket.us (tu venue).
// Devuelve { slug, prob, endMs } o null si no se puede operar ahí.
async function pmValidarMercado(slug) {
  if (!slug) return null;
  try {
    const r = await pmUs.get(`/v1/markets/${slug}`);
    const m = r?.market || (Array.isArray(r?.markets) ? r.markets[0] : null) || r || {};
    if (!m || (!m.slug && !m.marketSides)) return null;
    const longSide = (m.marketSides || []).find(s => s.long === true);
    const prob  = longSide ? parseFloat(longSide.price || 0) : null;
    const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
    if (m.closed) return null;
    return { slug: m.slug || slug, prob: prob && prob > 0 && prob < 1 ? prob : null, endMs };
  } catch(e) { return null; }
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
let ultimaPerdidaMs    = 0;   // timestamp de la última pérdida (para auto-reset)
let circuitBreaker     = false;
let senalesPendientes  = [];
let posicionesAbiertas = [];
let historialTrades    = [];
let consensosActivos   = [];  // últimos consensos detectados (para el panel)
let tradersCache       = [];  // top-traders monitoreados
const HISTORY_FILE  = path.join(__dirname, "balance-history.json");
const JSONBIN_KEY   = process.env.JSONBIN_KEY  || "";
const JSONBIN_BIN   = process.env.JSONBIN_BIN  || "";

// IDs numéricos estables por mercado (el dashboard inyecta s.id en onclick, no puede ser hex)
let _sigSeq = 1;
const _idPorMercado = {};
const idParaMercado = key => _idPorMercado[key] || (_idPorMercado[key] = _sigSeq++);

// Carga historial: primero intenta JSONBin (persistente en Render), luego archivo local
const cargarHistorialBalance = async () => {
  if (JSONBIN_KEY && JSONBIN_BIN) {
    try {
      const r = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`,
        { headers: { "X-Master-Key": JSONBIN_KEY }, timeout: 8000 });
      const data = r.data?.record?.historial;
      const cfgGuardado = r.data?.record?.config;
      if (cfgGuardado && typeof cfgGuardado === "object") {
        const { keyId, secretKey, ...rest } = cfgGuardado;
        CFG = { ...CFG, ...rest, keyId: CFG.keyId, secretKey: CFG.secretKey };
        console.log(`☁️  Config restaurada de JSONBin (stake $${CFG.stake}, budget $${CFG.budget})`);
      }
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

// Balance real
let balanceCash      = null;
let balanceEnPos     = null;
let balanceTotalReal = null;
let balanceBaseReal  = null;

// Guarda historial + config en el MISMO bin de JSONBin (ambos sobreviven redeploys)
const guardarBin = async () => {
  if (!(JSONBIN_KEY && JSONBIN_BIN)) return;
  const { keyId, secretKey, ...config } = CFG;   // nunca persistir credenciales
  try {
    await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`,
      { historial: historialBalance.slice(-90), config },
      { headers: { "X-Master-Key": JSONBIN_KEY, "Content-Type": "application/json" }, timeout: 8000 });
  } catch(e) { console.log("⚠️ JSONBin save:", e.message); }
};

const guardarHistorialBalance = async () => {
  const data = historialBalance.slice(-90);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data)); } catch(_) {}
  guardarBin();
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
      let endMs = (meta.endDate || meta.end_date_iso) ? new Date(meta.endDate || meta.end_date_iso).getTime() : null;
      if (!endMs) { try { endMs = await getMarketEndMs(slug, null); } catch(_) {} }
      if (!endMs) endMs = fechaDeSlug(slug);
      posicionesAbiertas.push({
        id:          idParaMercado(slug),
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
        endMs:       endMs || null,
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

// Fecha de cierre (ms) de un mercado consultando la API
const getMarketEndMs = async (slug, act) => {
  const raw = act?.market?.endDate || act?.endDate || act?.market?.end_date_iso || act?.endDateIso;
  if (raw) return new Date(raw).getTime();
  try {
    const r = await pmUs.get(`/v1/markets/${slug}`);
    const m = r?.market || (Array.isArray(r?.markets) ? r.markets[0] : null) || r || {};
    return m.endDate ? new Date(m.endDate).getTime() : null;
  } catch(_) { return null; }
};

// ── PRESUPUESTO ──────────────────────────────────────────────────────────────────
const presupuestoEfectivo = () => (CFG.reinvertir && balanceTotalReal !== null) ? balanceTotalReal : CFG.budget;
const maxPos = () => Math.max(3, Math.floor(presupuestoEfectivo() / CFG.stake));
const cashDisponible = () => balanceCash !== null ? balanceCash : (presupuestoEfectivo() - presupuestoUsado);

// ── EJECUTAR TRADE (auto-compra de consenso + compra manual) ──────────────────────
const ejecutarTrade = async (mercado, stake, fuerza, saltaBreaker = false) => {
  if (!botActivo) return null;
  if (!saltaBreaker && circuitBreaker) return null;
  if (cashDisponible() < stake) return null;
  if (posicionesAbiertas.length >= maxPos()) return null;
  if (posicionesAbiertas.find(p => p.marketId === mercado.marketId || p.slug === mercado.slug)) return null;

  const prob     = mercado.prob || 0.5;
  const shares   = parseFloat((stake / prob).toFixed(2));
  const ganancia = parseFloat((shares - stake).toFixed(2));

  if (modoReal && mercado.slug) {
    try {
      console.log(`🔄 COMPRANDO (${fuerza}): ${mercado.titulo?.slice(0,50)} — $${stake} @ ${(prob*100).toFixed(0)}%`);
      const resp = await pmComprar(mercado.slug, prob, shares);
      console.log(`✅ OK:`, JSON.stringify(resp).slice(0,80));
    } catch(e) {
      console.log(`⚠️ Error compra: ${e.response?.data?.message||e.message}`);
      return null;
    }
  } else {
    console.log(`📊 SIM (${fuerza}): ${mercado.titulo?.slice(0,40)} @ ${(prob*100).toFixed(0)}%`);
  }

  const trade = {
    id: idParaMercado(mercado.marketId || mercado.slug), marketId: mercado.marketId || mercado.slug, slug: mercado.slug,
    titulo: mercado.titulo, categoria: mercado.categoria,
    oddsEntrada: prob, oddsActual: prob,
    stake: parseFloat(stake.toFixed(2)), shares, potencial: shares, ganancia,
    pnl: 0, fuerza, endMs: mercado.endMs || null, tradersCount: mercado.tradersCount || 1,
    estado: "abierto", abiertaEn: new Date().toISOString(),
  };
  marcarOrigen(mercado.slug, fuerza.includes("MANUAL") ? "MANUAL" : "CONSENSO");
  posicionesAbiertas.push(trade);
  historialTrades.unshift({ ...trade });
  presupuestoUsado = parseFloat((presupuestoUsado + stake).toFixed(2));
  tradesHoy++;
  if (modoReal) setTimeout(actualizarBalanceReal, 2000);
  return trade;
};

// ════════════════════════════════════════════════════════════════════════════════
//  PUENTE polymarket.com (consenso) → polymarket.us (ejecución)
//  Los dos venues NO comparten slug ni conditionId. Único emparejamiento SEGURO:
//  mercados "EQUIPO gana" con coincidencia EXACTA de equipo + ACUERDO de precio.
//  Ante cualquier ambigüedad NO compra (se queda en radar). Esto evita comprar el
//  mercado equivocado (p.ej. "gana el Mundial" 10% vs "gana el partido de hoy" 86%).
// ════════════════════════════════════════════════════════════════════════════════
let indiceUS = [];   // [{slug, team, price, q, endMs}]
const PRICE_TOL = 0.05;  // tolerancia de acuerdo de precio entre venues

const teamName = t => typeof t === "string" ? t : (t?.name || t?.fullName || t?.shortName || t?.abbreviation || "");
const normTeam = s => (s||"").toLowerCase()
  .replace(/[^a-z0-9 ]/g," ")
  .replace(/\b(the|fc|cf|sc|ac|club|national|team)\b/g," ")
  .replace(/\s+/g," ").trim();

const construirIndiceUS = async () => {
  if (!modoReal) return;
  try {
    const all = [];
    for (let off = 0; off < 6000; off += 100) {
      const r = await pmUs.get("/v1/markets", true, { limit:100, offset:off, active:true, closed:false });
      const arr = r?.markets || [];
      all.push(...arr);
      if (arr.length < 100) break;
    }
    const idx = [];
    for (const m of all) {
      const L = (m.marketSides || []).find(s => s.long);
      if (!L) continue;
      const team = normTeam(teamName(L.team));
      if (!team) continue;
      idx.push({
        slug: m.slug, team, price: parseFloat(L.price || 0),
        q: m.question || m.title || "",
        endMs: m.endDate ? new Date(m.endDate).getTime() : null,
      });
    }
    indiceUS = idx;
    console.log(`🔗 Índice US: ${idx.length} mercados con equipo (de ${all.length})`);
  } catch(e) { console.log("⚠️ Índice US:", e.response?.status || e.message); }
};

// Extrae el equipo sujeto de un título "Will X win…" / "X to win…"
const equipoDeTitulo = titulo => {
  let m = /^will\s+(.+?)\s+win\b/i.exec(titulo || "");
  if (m) return m[1].trim();
  m = /^(.+?)\s+to win\b/i.exec(titulo || "");
  if (m) return m[1].trim();
  return null;
};

// Devuelve el mercado US gemelo SOLO si pasa TODOS los candados de seguridad; si no, null.
const buscarGemeloUS = (consenso) => {
  const titulo = consenso.titulo || "";
  // 1) Solo mercados "EQUIPO gana" (descarta spread / over-under / vs / draw / both teams)
  if (/spread|o\/u|over|under|\bvs\.?\b|both teams|draw|\+\d|-\d/i.test(titulo)) return null;
  // 2) El trader debe sostener el lado del equipo (largo), no No/Under/Over
  const outc = (consenso.outcome || "").toLowerCase();
  if (["no","under","over"].includes(outc)) return null;
  // 3) Equipo sujeto identificable
  const equipo = normTeam(equipoDeTitulo(titulo));
  if (!equipo || equipo.length < 3) return null;
  // 4) Gemelos con equipo EXACTO y precio que CONCUERDA (mismo mercado/escala)
  const cands = indiceUS.filter(x =>
    x.team === equipo && x.price > 0 && x.price < 1 &&
    Math.abs(x.price - (consenso.prob || 0)) <= PRICE_TOL
  );
  // 5) Debe haber EXACTAMENTE un candidato: ambiguo o sin match = no comprar
  if (cands.length !== 1) return null;
  return cands[0];
};

// ════════════════════════════════════════════════════════════════════════════════
//  MOTOR DE CONSENSO
// ════════════════════════════════════════════════════════════════════════════════

// Leaderboard de top-traders. Fuente real: lb-api.polymarket.com/profit
// Ventanas válidas: "All" (ballenas sharp históricas) y "1d" (lo caliente de hoy).
const LB_API = "https://lb-api.polymarket.com";
const fetchLBWindow = async (window, limit) => {
  try {
    const r = await axios.get(`${LB_API}/profit`, { params:{ window, limit }, timeout:12000, headers:{Accept:"application/json"} });
    const raw = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    return raw.map(t => ({
      wallet:  (t.proxyWallet || t.address || "").toLowerCase(),
      alias:   t.name || t.pseudonym || (t.proxyWallet || "??").slice(0,8)+"…",
      pnl:     parseFloat(t.amount || t.pnl || 0),
      volumen: Math.round(t.volume || 0),
    })).filter(t => t.wallet);
  } catch(e) { console.log(`⚠️ Leaderboard ${window} falló:`, e.response?.status || e.message); return []; }
};
const fetchTopTraders = async () => {
  const N = CFG.topTradersCount;
  // Líderes del DÍA = están todos operando los mismos mercados calientes de hoy → hay overlap real.
  // (Las ballenas históricas tienen carteras enormes y dispersas que nunca se solapan → 0 señales.)
  const hot = await fetchLBWindow("1d", N);
  if (hot.length) { console.log(`🏆 Top-traders del día: ${hot.length}`); return hot; }
  // Fallback: históricos si el diario falla
  const whales = await fetchLBWindow("All", N);
  if (whales.length) console.log(`🏆 Top-traders (histórico, fallback): ${whales.length}`);
  return whales;
};

// Posiciones abiertas de un trader (data-api)
const getTraderPositions = async (wallet) => {
  try {
    const r = await axios.get(`${DATA_API}/positions`, {
      params: { user: wallet, sizeThreshold: 1, limit: 50 }, timeout: 10000, headers:{Accept:"application/json"},
    });
    return Array.isArray(r.data) ? r.data : (r.data?.positions || r.data?.data || []);
  } catch(e) { return []; }
};

// Detecta consensos y (si autoComprar) los ejecuta. Esta es la ÚNICA fuente de señales.
const detectarConsensus = async () => {
  if (!CFG.autoConsensus) return;
  if (!tradersCache.length) tradersCache = await fetchTopTraders();
  const traders = tradersCache.slice(0, CFG.topTradersCount);
  if (!traders.length) { console.log("🐋 Consenso: sin traders en cache"); return; }

  console.log(`🐋 Buscando consenso entre ${traders.length} top-traders (umbral ${CFG.minOverlap})…`);

  // key (conditionId|outcome) -> { traders:Set, sample, prices:[] }
  const groups = {};
  // Escaneo en paralelo por lotes (rápido y suave con la API)
  const LOTE = 12;
  for (let i = 0; i < traders.length; i += LOTE) {
    const lote = traders.slice(i, i + LOTE);
    const resultados = await Promise.all(lote.map(t => getTraderPositions(t.wallet).then(pos => ({ wallet: t.wallet, pos }))));
    for (const { wallet, pos } of resultados) {
      for (const p of pos) {
        const size = parseFloat(p.size || p.netPosition || 0);
        if (size <= 0) continue;
        const cond    = p.conditionId || p.condition_id || p.slug || "";
        const outcome = (p.outcomeIndex ?? p.outcome ?? p.outcomeId ?? "").toString();
        const key     = `${cond}|${outcome}`;
        if (!cond) continue;
        const precio = parseFloat(p.curPrice ?? p.currentPrice ?? p.avgPrice ?? p.price ?? 0);
        if (!groups[key]) groups[key] = { traders: new Set(), sample: p, prices: [] };
        groups[key].traders.add(wallet);
        if (precio > 0 && precio < 1) groups[key].prices.push(precio);
      }
    }
    await sleep(150);
  }

  // Construir lista de consensos que pasan el umbral
  const consensos = [];
  for (const [key, g] of Object.entries(groups)) {
    const overlap = g.traders.size;
    if (overlap < CFG.minOverlap) continue;
    const p     = g.sample;
    const slug  = p.slug || p.eventSlug || p.market?.slug || "";
    const titulo = p.title || p.market?.question || p.outcome || slug || "Mercado";
    const prob  = prom(g.prices) || parseFloat(p.curPrice || p.avgPrice || 0) || 0.5;
    // Saltar mercados prácticamente resueltos (precio pegado a 0 o 1)
    if (prob <= 0.02 || prob >= 0.99) continue;
    let endMs   = (p.endDate || p.market?.endDate) ? new Date(p.endDate || p.market.endDate).getTime() : null;
    if (!endMs) endMs = fechaDeSlug(slug);
    if (endMs && endMs < Date.now()) continue;  // ya cerrado
    const diaCierre = diaCierreDeMs(endMs);
    consensos.push({
      id:        idParaMercado(slug || key),
      marketId:  slug || key,
      slug,
      titulo,
      outcome:   p.outcome || "YES",
      categoria: mapCategoria([], titulo, slug),
      overlap,
      tradersCount: overlap,
      prob:      parseFloat(Number(prob).toFixed(4)),
      endMs,
      diaCierre,
      diasRestantes: endMs ? Math.max(0, Math.ceil((endMs - Date.now()) / 86400000)) : 30,
      fuerza:    overlap >= 6 ? "MÁXIMA" : overlap >= 5 ? "FUERTE" : "MEDIA",
      stake:     CFG.stake,
    });
  }
  consensos.sort((a,b) => (b.overlap - a.overlap) || (b.prob - a.prob));
  consensosActivos = consensos.slice(0, 60);

  // Señales nuevas (no abiertas ni ya pendientes) → al feed del dashboard
  const nuevas = consensos.filter(c =>
    c.slug &&
    !senalesPendientes.find(s => s.marketId === c.marketId) &&
    !posicionesAbiertas.find(p => p.marketId === c.marketId || p.slug === c.slug)
  );
  senalesPendientes = [...nuevas, ...senalesPendientes].slice(0, 200);
  console.log(`📡 Consenso: ${consensos.length} mercados ≥${CFG.minOverlap} traders · ${nuevas.length} señales nuevas`);

  // ── AUTO-COMPRA ──
  if (!CFG.autoComprar || !botActivo || circuitBreaker) return;
  if (cashDisponible() < CFG.stake) { console.log(`💸 Auto-compra sin cash ($${cashDisponible().toFixed(2)} libre)`); return; }

  // Prioridad: mayor overlap primero, luego mercados que cierran antes
  const candidatos = consensos
    .filter(c => c.slug && !posicionesAbiertas.find(p => p.marketId === c.marketId || p.slug === c.slug))
    .sort((a,b) => (b.overlap - a.overlap) || ((a.diaCierre ?? 99) - (b.diaCierre ?? 99)) || (b.prob - a.prob));

  let compradas = 0;
  for (const c of candidatos.slice(0, 8)) {
    if (posicionesAbiertas.length >= maxPos()) break;
    if (cashDisponible() < CFG.stake) break;

    // SEGURIDAD: solo opera si hay gemelo US demostrablemente correcto (equipo exacto + acuerdo de precio)
    let prob = c.prob, slugOperable = c.slug;
    if (modoReal) {
      const twin = buscarGemeloUS(c);
      if (!twin) { console.log(`⏭️ Sin gemelo seguro en US: ${c.titulo.slice(0,40)}`); continue; }
      slugOperable = twin.slug;
      prob = twin.price;
      if (twin.endMs) c.endMs = twin.endMs;
    }
    // Filtro de odds (rango configurable en el dashboard)
    if (prob < CFG.minOdds || prob > CFG.maxOdds) {
      console.log(`⏭️ Fuera de rango odds (${(prob*100).toFixed(0)}%): ${c.titulo.slice(0,40)}`);
      continue;
    }
    const t = await ejecutarTrade({ ...c, slug: slugOperable, prob }, CFG.stake, "🐋 CONSENSO");
    senalesPendientes = senalesPendientes.filter(s => s.marketId !== c.marketId);
    if (t) compradas++;
    await sleep(700);
  }
  if (compradas > 0) console.log(`🐋 Auto-compra: ${compradas} consensos comprados (gemelo US verificado)`);
};

// ── STATS REALES: P&L / Win Rate / Trades desde resoluciones de Polymarket ──────────
let statsReales = { trades:0, ganados:0, perdidos:0, winRate:0, pnl:0, pnlHoy:0, tradesHoy:0, listo:false };
const num = v => parseFloat(v?.value ?? v ?? 0) || 0;
const parseMs = v => {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
};
const actualizarStatsReales = async () => {
  if (!modoReal) return;
  try {
    const actRes = await pmUs.get("/v1/portfolio/activities", true, { limit: 100 });
    const actArr = Array.isArray(actRes?.activities) ? actRes.activities : [];
    const hoy = diaCalendario(Date.now());
    let g = 0, p = 0, pnl = 0, pnlHoyV = 0, tradesHoyV = 0;
    for (const a of actArr) {
      if (!(a.type || "").includes("RESOLUTION")) continue;
      const r = a.positionResolution || {};
      const val = parseFloat((num((r.afterPosition||{}).realized) - num((r.beforePosition||{}).realized)).toFixed(2));
      if (val >= 0) g++; else p++;
      pnl += val;
      const ms = parseMs(r.updateTime);
      if (ms && diaCalendario(ms) === hoy) { pnlHoyV += val; tradesHoyV++; }
    }
    statsReales = {
      trades: g + p, ganados: g, perdidos: p,
      winRate: (g + p) > 0 ? parseFloat((g / (g + p) * 100).toFixed(1)) : 0,
      pnl: parseFloat(pnl.toFixed(2)),
      pnlHoy: parseFloat(pnlHoyV.toFixed(2)),
      tradesHoy: tradesHoyV, listo: true,
    };
  } catch(e) { console.log("⚠️ Stats reales:", e.message); }
};

// ── TIMERS ─────────────────────────────────────────────────────────────────────
cargarHistorialBalance().then(data => {
  historialBalance = data;
  return actualizarBalanceReal();
}).then(() => sincronizarPosiciones())
  .then(() => actualizarStatsReales())
  .then(() => construirIndiceUS())   // índice del venue de ejecución (para el puente seguro)
  .then(() => fetchTopTraders().then(t => { tradersCache = t; }))
  .then(() => setTimeout(detectarConsensus, 4000));

setInterval(construirIndiceUS,    10 * 60 * 1000);   // refrescar índice US cada 10 min
setInterval(detectarConsensus,         90 * 1000);   // consenso cada 90s
setInterval(actualizarBalanceReal,    30 * 1000);   // balance cada 30s
setInterval(sincronizarPosiciones,    60 * 1000);   // re-sync posiciones cada 1 min
setInterval(actualizarStatsReales, 2 * 60 * 1000);   // stats reales cada 2 min
setInterval(async () => { tradersCache = await fetchTopTraders(); }, 60 * 60 * 1000);  // refrescar top-traders cada hora

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
    const pnl  = parseFloat(((pos.shares||0) * odds - pos.stake).toFixed(2));
    pos.estado = "cerrado_tiempo"; pos.pnl = pnl;
    pnlHoy    = parseFloat((pnlHoy + pnl).toFixed(2));
    balanceReal = parseFloat((balanceReal + pnl).toFixed(2));
    if (pnl >= 0) { ganados++; rachaPerder = 0; }
    else          { perdidos++; rachaPerder++; ultimaPerdidaMs = Date.now(); if (rachaPerder >= 8) circuitBreaker = true; }
    presupuestoUsado = parseFloat(Math.max(0, presupuestoUsado - pos.stake).toFixed(2));
    historialTrades.unshift({ ...pos, cerradaEn: new Date().toISOString() });
    const idx = posicionesAbiertas.findIndex(p => p.id === pos.id);
    if (idx !== -1) posicionesAbiertas.splice(idx, 1);
    console.log(`⏰ Cerrado: ${pos.titulo?.slice(0,40)} | PnL $${pnl}`);
  }
  if (modoReal) setTimeout(actualizarBalanceReal, 2000);
};
setInterval(cerrarPosicionesAntiguas, 30 * 60 * 1000);

// Auto-reset circuit breaker si no llega ninguna pérdida nueva en 3 horas
setInterval(() => {
  if (rachaPerder > 0 && ultimaPerdidaMs > 0 && (Date.now() - ultimaPerdidaMs) > 3 * 3600 * 1000) {
    const prev = rachaPerder;
    rachaPerder = 0; circuitBreaker = false; ultimaPerdidaMs = 0;
    console.log(`⏰ Circuit breaker auto-reseteado (${prev} pérdidas, 3h sin nuevas)`);
  }
}, 30 * 60 * 1000);

cron.schedule("0 0 * * *", () => {
  pnlHoy=0; tradesHoy=0; ganados=0; perdidos=0;
  presupuestoUsado=0; rachaPerder=0; circuitBreaker=false; ultimaPerdidaMs=0;
  const valorDia = balanceTotalReal ?? balanceReal;
  historialBalance.push({ dia:new Date().toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit"}), valor:valorDia });
  guardarHistorialBalance();
});

// ── ENDPOINTS ──────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const wr = (ganados+perdidos)>0 ? (ganados/(ganados+perdidos)*100) : 0;
  const balanceMostrado = balanceTotalReal !== null ? balanceTotalReal : balanceReal;
  const usarReal = modoReal && statsReales.listo;
  res.json({
    botActivo, circuitBreaker, rachaPerder,
    autoResetEn: (ultimaPerdidaMs > 0 && rachaPerder > 0) ? ultimaPerdidaMs + 3 * 3600 * 1000 : null,
    balance:balanceMostrado,
    balanceCash, balanceEnPos, balanceTotalReal, balanceBase:balanceBaseReal,
    pnlHoy:    usarReal ? statsReales.pnlHoy    : parseFloat(pnlHoy.toFixed(2)),
    tradesHoy: usarReal ? statsReales.tradesHoy : tradesHoy,
    ganados:   usarReal ? statsReales.ganados   : ganados,
    perdidos:  usarReal ? statsReales.perdidos  : perdidos,
    winRate:   usarReal ? statsReales.winRate   : parseFloat(wr.toFixed(1)),
    pnlTotal:  usarReal ? statsReales.pnl       : null,
    presupuestoTotal:    balanceTotalReal !== null ? balanceTotalReal : CFG.budget,
    presupuestoUsado:    balanceEnPos     !== null ? balanceEnPos     : parseFloat(presupuestoUsado.toFixed(2)),
    presupuestoRestante: balanceCash      !== null ? balanceCash      : parseFloat((CFG.budget - presupuestoUsado).toFixed(2)),
    stake:CFG.stake, minOdds:CFG.minOdds, maxOdds:CFG.maxOdds,
    mercadosEscaneados:consensosActivos.length,
    unrealizedPnl:parseFloat(posicionesAbiertas.reduce((s,t)=>s+(t.pnl||0),0).toFixed(2)),
    apiConectada:!!CFG.keyId, modoReal,
    persistencia: !!(JSONBIN_KEY && JSONBIN_BIN),
    keyIdActivo:modoReal?pmUs.keyId?.slice(0,8)+"…":null,
    tradersCopiados:tradersCache.length,
    posicionesAbiertas:posicionesAbiertas.length,
    posicionesCopy:posicionesAbiertas.filter(p=>(p.fuerza||"").includes("CONSENSO")).length,
    autoComprar:CFG.autoComprar, autoConsensus:CFG.autoConsensus, reinvertir:CFG.reinvertir,
    minOverlap:CFG.minOverlap, topTradersCount:CFG.topTradersCount,
    consensosDetectados:consensosActivos.length,
    maxPositiones:maxPos(), maxHoldHoras:CFG.maxHoldHoras, maxDiasRestantes:CFG.maxDiasRestantes,
  });
});

app.get("/api/markets",         (req, res) => res.json(consensosActivos.slice(0,100)));
app.get("/api/consensus",       (req, res) => res.json(consensosActivos.slice(0,60)));
app.get("/api/signals/pending", (req, res) => res.json(senalesPendientes.slice(0,50)));
app.get("/api/trades/open",     (req, res) => res.json(posicionesAbiertas));

app.get("/api/trades/historial", async (req, res) => {
  const cerradosLocales = historialTrades.filter(t => t.estado && t.estado !== "abierto");
  if (modoReal) {
    try {
      const actRes = await pmUs.get("/v1/portfolio/activities", true, { limit: 50 });
      const actArr = Array.isArray(actRes?.activities) ? actRes.activities : [];
      const fromApi = actArr
        .filter(a => (a.type || "").includes("RESOLUTION"))
        .map(a => {
          const r      = a.positionResolution || {};
          const before = r.beforePosition || {};
          const after  = r.afterPosition  || {};
          const meta   = before.marketMetadata || after.marketMetadata || {};
          const titulo = r.market?.question || meta.title || meta.slug || "";
          const slug   = r.marketSlug || r.market?.slug || meta.slug || "";
          const precio = num(before.avgPx);
          const stake  = num(before.cost) || num(before.baseCost);
          const pnl    = parseFloat((num(after.realized) - num(before.realized)).toFixed(2));
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

// Top-traders monitoreados para el consenso (panel "🏆 Top Traders")
app.get("/api/traders", async (req, res) => {
  if (!tradersCache.length) tradersCache = await fetchTopTraders();
  const list = tradersCache.map(t => ({
    wallet:    t.wallet,
    alias:     t.alias,
    winRate:   Math.min(95, 60 + Math.floor((t.pnl||0)/10000)),
    roi:       t.volumen > 0 ? parseFloat(((t.pnl/t.volumen)*100).toFixed(1)) : 0,
    pnl:       parseFloat((t.pnl||0).toFixed(2)),
    volumen:   t.volumen,
    categoria: "CONSENSO", activo: "monitoreado",
    score:     Math.min(99, Math.max(50, 50 + Math.floor((t.pnl||0)/5000))),
    copiando:  true,   // monitoreado para consenso
  }));
  if (list.length) return res.json(list);
  res.json([]);
});

// Compra MANUAL de una señal de consenso (botón COMPRAR del dashboard)
app.post("/api/signals/:id/ejecutar", async (req, res) => {
  const rid = String(req.params.id);
  const s = senalesPendientes.find(x => String(x.id) === rid) || consensosActivos.find(x => String(x.id) === rid);
  if (!s) return res.status(404).json({ error:"Señal no encontrada" });
  if (!botActivo) return res.json({ success: false, error: "Bot pausado — reactívalo primero" });
  if (posicionesAbiertas.length >= maxPos()) return res.json({ success: false, error: `Máximo de posiciones (${maxPos()}) alcanzado` });
  if (posicionesAbiertas.find(p => p.marketId === s.marketId || p.slug === s.slug)) return res.json({ success: false, error: "Ya tienes esta posición abierta" });

  const stake = CFG.stake;
  if (cashDisponible() < stake) return res.json({ success: false, error: `Sin fondos ($${cashDisponible().toFixed(2)} < $${stake})` });

  // Buscar gemelo seguro en tu venue (polymarket.us) antes de comprar
  let prob = s.prob, slugOperable = s.slug;
  if (modoReal) {
    const twin = buscarGemeloUS(s);
    if (!twin) return res.json({ success:false, error:"Sin gemelo verificable en polymarket.us (equipo/precio no concuerdan). Cómpralo manual en polymarket.us." });
    slugOperable = twin.slug;
    prob = twin.price;
    if (twin.endMs) s.endMs = twin.endMs;
  }
  // Compra manual: salta el circuit breaker (decisión deliberada del usuario)
  const trade = await ejecutarTrade({ ...s, slug: slugOperable, prob }, stake, "✋ MANUAL", true);
  if (!trade) return res.json({ success:false, error:"No se pudo ejecutar la compra" });
  senalesPendientes = senalesPendientes.filter(x => String(x.id) !== rid);
  res.json({ success: true, trade });
});

app.post("/api/signals/:id/saltar", (req, res) => {
  const rid = String(req.params.id);
  senalesPendientes = senalesPendientes.filter(s=>String(s.id)!==rid);
  res.json({ success:true });
});

app.post("/api/trades/:id/cerrar", async (req, res) => {
  const idx = posicionesAbiertas.findIndex(t=>String(t.id)===String(req.params.id));
  if (idx===-1) return res.status(404).json({ error:"No encontrada" });
  const trade = posicionesAbiertas[idx];
  if (trade.slug) {
    const precioActual = await pmPrecioActual(trade.slug).catch(() => null);
    if (precioActual) trade.oddsActual = precioActual;
  }
  if (modoReal && trade.slug) {
    try { await pmCerrar(trade.slug); }
    catch(e) { console.log(`⚠️ Close err: ${e.response?.data?.message||e.message}`); }
  }
  const pnl = parseFloat(((trade.shares||0)*trade.oddsActual-trade.stake).toFixed(2));
  trade.estado="cerrado_manual"; trade.pnl=pnl;
  pnlHoy=parseFloat((pnlHoy+pnl).toFixed(2)); balanceReal=parseFloat((balanceReal+pnl).toFixed(2));
  if(pnl>=0) { ganados++; rachaPerder=0; }
  else       { perdidos++; rachaPerder++; ultimaPerdidaMs=Date.now(); if(rachaPerder>=8) { circuitBreaker=true; console.log("🚨 Circuit breaker activado"); } }
  historialTrades.unshift({...trade, cerradaEn:new Date().toISOString()});
  posicionesAbiertas.splice(idx,1);
  if (modoReal) setTimeout(actualizarBalanceReal, 2000);
  res.json({ success:true, pnl });
});

app.post("/api/trades/:id/aumentar", async (req, res) => {
  const trade = posicionesAbiertas.find(t=>String(t.id)===String(req.params.id));
  if (!trade) return res.status(404).json({ error:"No encontrada" });
  const extra = parseFloat(req.body.monto)||CFG.stake;
  if (extra <= 0) return res.json({ success:false, error:"Monto inválido" });

  let sharesExtra;
  if (modoReal && trade.slug) {
    try {
      const b  = await pmBbo(trade.slug);
      const pc = b.ask || b.last || b.bid;
      if (!pc) return res.json({ success:false, error:"Sin precio de mercado ahora" });
      sharesExtra = Math.max(1, Math.round(extra / pc));
      await pmComprar(trade.slug, pc, sharesExtra);
      trade.oddsActual = pc;
      setTimeout(actualizarBalanceReal, 2000);
    } catch(e) {
      return res.json({ success:false, error:e.response?.data?.message||e.message });
    }
  } else {
    sharesExtra = parseFloat((extra / (trade.oddsEntrada||1)).toFixed(2));
  }

  trade.stake  = parseFloat((trade.stake + extra).toFixed(2));
  trade.shares = parseFloat((trade.shares + sharesExtra).toFixed(2));
  trade.potencial = trade.shares;
  trade.ganancia  = parseFloat((trade.potencial - trade.stake).toFixed(2));
  presupuestoUsado = parseFloat((presupuestoUsado + extra).toFixed(2));
  res.json({ success:true, nuevoStake:trade.stake, nuevoPotencial:trade.potencial });
});

// ── POSICIONES REALES POLYMARKET ─────────────────────────────────────────────────
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
      return res.json({ success:false, sinLiquidez:true, bid:bidActual,
        error:`Sin compradores ahora (bid ${(bidActual*100).toFixed(0)}%). El mercado resolverá automáticamente al final.` });
    }
    const vender = Math.min(parseInt(shares) || total, total);
    const r      = await pmVender(slug, vender);
    const fills  = r?.executions?.length || r?.fills?.length || 0;
    setTimeout(actualizarBalanceReal, 2000);
    if (fills === 0) {
      return res.json({ success:false, sinFill:true, bid:bidActual,
        error:`Orden enviada pero sin fill (bid ${(bidActual*100).toFixed(0)}%). Prueba de nuevo en unos segundos.` });
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
app.post("/api/bot/reset-circuit", (req, res) => { circuitBreaker=false; rachaPerder=0; ultimaPerdidaMs=0; res.json({ success:true }); });
app.post("/api/bot/scan-ahora",    async (req,res) => { await detectarConsensus(); res.json({ consensos:consensosActivos.length }); });

// El COPY individual ya no existe (sistema viejo eliminado): toggle inocuo para no romper la UI
app.post("/api/traders/:w/toggle", (req, res) => res.json({ success:true, copiando:true, nota:"Consenso usa el leaderboard automáticamente" }));

app.post("/api/config", (req, res) => {
  const { stake, presupuesto, minOdds, maxOdds, autoComprar } = req.body;
  if (stake       !==undefined) CFG.stake      =parseFloat(stake);
  if (presupuesto !==undefined) CFG.budget     =parseFloat(presupuesto);
  if (minOdds     !==undefined) CFG.minOdds    =parseFloat(minOdds);
  if (maxOdds     !==undefined) CFG.maxOdds    =parseFloat(maxOdds);
  if (autoComprar !==undefined) CFG.autoComprar=!!autoComprar;
  if (req.body.autoConsensus    !==undefined) CFG.autoConsensus    =!!req.body.autoConsensus;
  if (req.body.minOverlap       !==undefined) CFG.minOverlap       =Math.max(2, parseInt(req.body.minOverlap));
  if (req.body.topTradersCount  !==undefined) CFG.topTradersCount  =Math.max(5, parseInt(req.body.topTradersCount));
  if (req.body.maxHoldHoras     !==undefined) CFG.maxHoldHoras     =parseInt(req.body.maxHoldHoras);
  if (req.body.maxDiasRestantes !==undefined) CFG.maxDiasRestantes =parseInt(req.body.maxDiasRestantes);
  if (req.body.reinvertir       !==undefined) CFG.reinvertir       =!!req.body.reinvertir;
  guardarCFG();
  res.json({ success:true });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🐋 POLYBOT — SISTEMA DE CONSENSO — http://localhost:${PORT}`);
  console.log(`💰 Budget: $${CFG.budget} | Stake: $${CFG.stake} | Odds: ${(CFG.minOdds*100).toFixed(0)}%-${(CFG.maxOdds*100).toFixed(0)}%`);
  console.log(`🐋 Consenso: ≥${CFG.minOverlap} de ${CFG.topTradersCount} top-traders | Auto-compra: ${CFG.autoComprar?"ON (gemelo US verificado)":"OFF"}`);
  console.log(`🔑 API: ${CFG.keyId?"✅ REAL":"❌ SIM"}\n`);
});
