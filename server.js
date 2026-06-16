require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const cron    = require("node-cron");
const axios   = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── CONFIG (valores fijos, sin depender del .env para filtros) ────────────────
let CFG = {
  minOdds:      0.70,   // 70% mínimo - mercados serios
  maxOdds:      0.90,   // hasta 90% (decisión del trader: rango 70-90%)
  minLiquidity: 500,    // $500 mínimo
  minVolumen:   1000,   // $1k mínimo
  liveSportsBonus: true, // mercados deportivos en vivo al 80%+
  budget:       parseFloat(process.env.DAILY_BUDGET)    || 59,
  stake:        parseFloat(process.env.STAKE_PER_TRADE) || 3,
  keyId:        process.env.POLYMARKET_KEY_ID,
  secretKey:    process.env.POLYMARKET_SECRET_KEY,
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API  = "https://data-api.polymarket.com";

// ── CLIENTE POLYMARKET.US (API real con Ed25519 corregido) ────────────────────
const ed25519 = require("@noble/ed25519");
try {
  const { sha512 } = require("@noble/hashes/sha512");
  ed25519.etc.sha512Sync = (...m) => sha512(...m);
} catch(_) {}

const PM_US_API     = "https://api.polymarket.us";
const PM_US_GATEWAY = "https://gateway.polymarket.us";

// Firma Ed25519: maneja keys de 32, 64 o 65 bytes
// Mensaje: timestamp + METHOD + path  (sin body — igual que polymarket-us package)
async function pmUsSign(secretBase64, ts, method, path) {
  const msg  = ts + method.toUpperCase() + path;
  const raw  = new Uint8Array(Buffer.from(secretBase64, "base64")); // Buffer acepta + y /
  // 64 bytes = seed(32)+pubkey(32) → tomar primeros 32 | 65 bytes = prefijo+seed+pubkey → slice(0,32)
  const seed = raw.length > 32 ? raw.slice(0, 32) : raw;
  const sig  = await ed25519.signAsync(new TextEncoder().encode(msg), seed);
  return Buffer.from(sig).toString("base64");
}

// Cliente polymarket.us
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
    const url = new URL(path, authed ? PM_US_API : PM_US_GATEWAY);
    Object.entries(params).forEach(([k,v]) => v !== undefined && url.searchParams.set(k, v));
    const headers = authed ? await this._headers("GET", path) : {};
    const r = await axios.get(url.toString(), { headers, timeout: 15000 });
    return r.data;
  },

  async post(path, body = {}) {
    const bodyStr = JSON.stringify(body);
    const headers = {
      ...await this._headers("POST", path, bodyStr),
      "Content-Type": "application/json",
    };
    const r = await axios.post(PM_US_API + path, body, { headers, timeout: 15000 });
    return r.data;
  },
};

let modoReal = !!(process.env.POLYMARKET_KEY_ID && process.env.POLYMARKET_SECRET_KEY);
if (modoReal) {
  console.log(`✅ Cliente polymarket.us listo (${process.env.POLYMARKET_KEY_ID?.slice(0,8)}…) — MODO REAL 💰`);
} else {
  console.log("⚠️  Sin credenciales — MODO SIMULACIÓN");
}

// ── HELPERS DE ÓRDENES (formato correcto de polymarket.us) ────────────────────
// El API espera intent/quantity/price{value,currency}, NO side/size.
// Mejor bid/ask/precio actual del order book
async function pmBbo(marketSlug) {
  try {
    const r  = await pmUs.get(`/v1/markets/${marketSlug}/bbo`);
    const md = r?.marketData || {};
    return {
      bid:  parseFloat(md.bestBid?.value || 0) || null,
      ask:  parseFloat(md.bestAsk?.value || 0) || null,
      last: parseFloat(md.currentPx?.value || md.lastTradePx?.value || 0) || null,
    };
  } catch(e) { return { bid: null, ask: null, last: null }; }
}
// Precio "de referencia" (último/mid) para mostrar P&L
async function pmPrecioActual(marketSlug) {
  const b = await pmBbo(marketSlug);
  return b.last || b.bid || b.ask || null;
}
// Comprar con EJECUCIÓN INMEDIATA: paga el ask (+1 tick) para que se llene ya,
// no quede como orden límite colgada. quantity = nº de shares deseado.
async function pmComprar(marketSlug, probRef, quantity) {
  const b = await pmBbo(marketSlug);
  // Pagar el ask + 1 centavo asegura el fill; si no hay ask, usar la referencia
  let precio = b.ask ? Math.min(b.ask + 0.01, 0.99) : (probRef || b.last || 0.5);
  precio = Math.round(precio * 100) / 100; // tick 0.01
  return pmUs.post("/v1/orders", {
    marketSlug,
    intent:   "ORDER_INTENT_BUY_LONG",
    type:     "ORDER_TYPE_LIMIT",
    price:    { value: precio.toFixed(2), currency: "USD" },
    quantity: Math.max(1, Math.round(quantity)),
    tif:      "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL", // se llena al instante o se cancela (sin colgar)
  });
}
// Cerrar posición completa de un mercado (para copiar las ventas del trader)
async function pmCerrar(marketSlug) {
  return pmUs.post("/v1/order/close-position", { marketSlug });
}
// Vender PARTE de una posición: SELL al bid (-1 tick) con ejecución inmediata
async function pmVender(marketSlug, quantity) {
  const b = await pmBbo(marketSlug);
  let precio = b.bid ? Math.max(b.bid - 0.01, 0.01) : (b.last || 0.5);
  precio = Math.round(precio * 100) / 100;
  return pmUs.post("/v1/orders", {
    marketSlug,
    intent:   "ORDER_INTENT_SELL_LONG",
    type:     "ORDER_TYPE_LIMIT",
    price:    { value: precio.toFixed(2), currency: "USD" },
    quantity: Math.max(1, Math.round(quantity)),
    tif:      "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
  });
}
// Cancelar una orden límite pendiente
async function pmCancelar(orderId, marketSlug) {
  return pmUs.post(`/v1/order/${orderId}/cancel`, { marketSlug });
}

// CLOB client (solo para leer mercados públicos)
let clobClient = null;
try {
  const { ClobClient } = require("@polymarket/clob-client-v2");
  clobClient = new ClobClient({ host: "https://clob.polymarket.com", chain: 137 });
} catch(e) { /* opcional */ }

// ── ESTADO GLOBAL ─────────────────────────────────────────────────────────────
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
let historialBalance   = [{ dia: "Inicio", valor: CFG.budget }];

// ── COPY TRADING STATE ────────────────────────────────────────────────────────
let copiandoSet      = new Set(); // wallets actualmente copiadas
let ultimaActividad  = {};        // { wallet: Set<tradeId> } — IDs ya procesados
let tradersCache     = [];        // cache del leaderboard

// ── BALANCE REAL (de polymarket.us) ───────────────────────────────────────────
let balanceCash      = null;  // efectivo disponible
let balanceEnPos     = null;  // valor en posiciones abiertas (suma de costos)
let balanceTotalReal = null;  // cash + posiciones = lo que ves en el teléfono
let balanceBaseReal  = null;  // primer balance real visto = base para el ROI

const actualizarBalanceReal = async () => {
  if (!modoReal) return;
  try {
    const [bal, pos] = await Promise.all([
      pmUs.get("/v1/account/balances"),
      pmUs.get("/v1/portfolio/positions"),
    ]);
    const cash   = parseFloat(bal.balances?.[0]?.currentBalance || 0);
    const posObj = (pos?.positions && typeof pos.positions === "object" && !Array.isArray(pos.positions)) ? pos.positions : {};
    const enPos  = Object.values(posObj)
      .filter(p => parseFloat(p.netPosition || 0) > 0)
      .reduce((s, p) => s + parseFloat(p.cost?.value || 0), 0);
    balanceCash      = parseFloat(cash.toFixed(2));
    balanceEnPos     = parseFloat(enPos.toFixed(2));
    balanceTotalReal = parseFloat((cash + enPos).toFixed(2));
    if (balanceBaseReal === null) balanceBaseReal = balanceTotalReal; // base ROI = primer valor visto
    console.log(`💰 Balance real: $${balanceTotalReal} (cash $${balanceCash} + posiciones $${balanceEnPos})`);
  } catch(e) {
    console.log("⚠️ Error leyendo balance real:", e.response?.status || e.message);
  }
};

// ── CATEGORÍAS ────────────────────────────────────────────────────────────────
// Nombres reales en Polymarket (verificados 2026-06-16):
//   "What will S&P 500 (SPX) hit..." / "SPY (SPY) Up or Down..."
//   "Nasdaq 100 (QQQ)..." / "Nasdaq 100 (NDX) Up or Down..."
//   "Dow Jones (DJIA) Up or Down..." / "Russell 2000 (RUT) Up or Down..."
const mapCategoria = (tags = [], question = "", slug = "") => {
  // El slug es clave: los mercados de tenis traen "atp-…"/"wta-…" aunque el
  // título solo diga "Parma: Jugador vs Jugador" (sin la palabra "tennis").
  const t = (tags.join(" ") + " " + question + " " + slug).toLowerCase();

  // hasW: ticker como PALABRA completa (evita "down"→dow, "method"→eth, "inquiry"→nq)
  const hasW = (...words) => words.some(w =>
    new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t)
  );

  // ── Índices y futuros de bolsa (prioridad alta - especialidad del trader) ──
  if (t.includes("s&p 500") || t.includes("s&p500") || t.includes("sp500") ||
      hasW("s&p", "spx", "spy", "es"))                         return "SPX";
  if (t.includes("nasdaq")  ||
      hasW("qqq", "ndx", "nq"))                                return "NQ";
  if (t.includes("dow jones") ||
      hasW("djia", "ym"))                                      return "DOW";
  if (t.includes("russell") ||
      hasW("rut"))                                             return "RUSSELL";
  if (hasW("vix") || t.includes("volatility index"))          return "VIX";

  // ── Deportes (nombres reales en Polymarket verificados 2026-06-16) ──
  // Béisbol: "MLB: ..."
  if (t.includes("mlb") || t.includes("baseball") || t.includes("world series") ||
      hasW("yankees", "dodgers", "mets", "braves", "astros", "cubs") ||
      t.includes("red sox"))                                   return "BEISBOL";
  // Basket: "NBA: ...", "2026 NBA Draft: ..."
  if (t.includes("nba") || t.includes("basketball") ||
      hasW("lakers", "warriors", "celtics", "nuggets", "knicks", "bulls", "mavericks") ||
      t.includes("miami heat"))                                return "NBA";
  // Fútbol americano: OJO — Polymarket usa "Pro Football" para casi todo, no "NFL"
  if (t.includes("nfl") || t.includes("pro football") || t.includes("super bowl") ||
      hasW("chiefs", "cowboys", "eagles", "patriots"))         return "NFL";
  // Hockey: "NHL: ...", "Stanley Cup Finals: ..."
  if (t.includes("nhl") || t.includes("hockey") || t.includes("stanley cup")) return "NHL";
  // MMA: "UFC ...: X vs. Y"
  if (hasW("ufc", "mma") || t.includes("boxing"))              return "UFC";
  // Golf: "PGA Tour: ...", "FedEx Cup ...", "Masters" (antes que Tenis por "U.S. Open")
  if (t.includes("pga") || t.includes("fedex cup") || t.includes("golf") ||
      t.includes("the masters") || t.includes("ryder cup"))   return "GOLF";
  // Tenis: "...Open: X vs Y", "Wimbledon", "(Tennis)" — el trader OPERA esto
  if (t.includes("tennis") || t.includes("wimbledon") || t.includes("atp") ||
      t.includes("wta") || t.includes("roland garros") || t.includes("australian open") ||
      t.includes("french open") || t.includes("grass court") || t.includes("halle open") ||
      t.includes("hsbc championships"))                        return "TENIS";
  // Fútbol/soccer: "World Cup ...", "X vs. Y" (selecciones), ligas europeas
  if (t.includes("soccer") || t.includes("world cup") || t.includes("premier league") ||
      t.includes("champions league") || t.includes("la liga") || t.includes("bundesliga") ||
      t.includes("fc bayern") || hasW("madrid", "barcelona"))  return "SOCCER";
  // F1
  if (t.includes("formula 1") || t.includes("grand prix") || hasW("f1")) return "F1";
  if (t.includes("sport"))                                     return "SPORTS";

  // ── Crypto ──
  if (t.includes("bitcoin") || t.includes("ethereum") || t.includes("solana") ||
      t.includes("crypto")  || hasW("btc", "eth", "sol", "xrp")) return "CRYPTO";

  // ── Macro y política ──
  if (t.includes("inflation") || t.includes("recession") || t.includes("interest rate") ||
      hasW("fed", "gdp", "cpi", "fomc"))                       return "MACRO";
  if (t.includes("elect") || t.includes("presid") || t.includes("congress") ||
      t.includes("senate") || t.includes("government") || t.includes("shutdown") ||
      t.includes("shut down") || hasW("trump", "house"))        return "POLITICA";

  return "WILDCARD";
};

// Detectar si es deporte en vivo
// Detectar si es mercado de índices intraday (resuelve hoy)
const esIndiceIntraday = (categoria, diasRestantes) => {
  const indices = ["SPX", "NQ", "DOW", "VIX"];
  return indices.includes(categoria) && diasRestantes <= 1;
};

// Detectar si es deporte en vivo (resuelve en menos de 24h con alta prob)
const esDeporteEnVivo = (m, prob, diasRestantes) => {
  const cat = m.categoria;
  const deportivos = ["BEISBOL", "NBA", "NFL", "SOCCER", "UFC", "SPORTS"];
  return deportivos.includes(cat) && diasRestantes <= 1 && prob >= 0.75;
};

// ── COPY TRADING — LEADERBOARD Y MOTOR ───────────────────────────────────────
const fetchLeaderboard = async () => {
  try {
    const res = await axios.get("https://polymarket.com/leaderboard", {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });

    // Extraer __NEXT_DATA__ del HTML
    const m = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("__NEXT_DATA__ no encontrado");

    const nextData = JSON.parse(m[1]);
    const queries  = nextData?.props?.pageProps?.dehydratedState?.queries || [];
    const lbQuery  = queries.find(q => Array.isArray(q?.state?.data) && q.state.data[0]?.proxyWallet);
    const raw      = lbQuery?.state?.data || [];

    if (!raw.length) throw new Error("Sin datos en leaderboard");

    // Solo traders con PnL positivo, ordenados por PnL
    const positivos = raw
      .filter(t => t.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10);

    console.log(`🏆 Leaderboard real: ${positivos.length} traders con PnL positivo`);

    return positivos.map((t, i) => {
      const roi     = t.volume > 0 ? parseFloat(((t.pnl / t.volume) * 100).toFixed(1)) : 0;
      const score   = Math.min(99, 50 + Math.floor(t.pnl / 5000));
      const winRate = Math.min(95, 60 + Math.floor(t.pnl / 10000));
      return {
        wallet:    t.proxyWallet,
        alias:     t.pseudonym || t.name || t.proxyWallet.slice(0,8) + "…",
        winRate,
        roi,
        pnl:       parseFloat(t.pnl.toFixed(2)),
        volumen:   Math.round(t.volume),
        categoria: "MIXED",
        activo:    `rank #${t.rank}`,
        copiando:  copiandoSet.has(t.proxyWallet),
        score:     Math.max(50, score),
      };
    });
  } catch(e) {
    console.log("⚠️ Leaderboard scraping falló, usando mock:", e.message);
    return [];
  }
};

const getTraderActivity = async (wallet) => {
  try {
    const res = await axios.get(`${DATA_API}/activity`, {
      params: { user: wallet, limit: 20 },
      timeout: 10000,
      headers: { "Accept": "application/json" },
    });
    return Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.history || []);
  } catch(e) {
    return [];
  }
};

const ejecutarCopyTrade = async (actividad, wallet) => {
  if (!botActivo || circuitBreaker) return;
  if ((CFG.budget - presupuestoUsado) < CFG.stake) return;

  const slug  = actividad.market?.slug  || actividad.slug;
  const title = actividad.market?.question || actividad.title || actividad.market_slug || slug || "Copy Trade";
  const prob  = parseFloat(actividad.price || actividad.avgPrice || 0.75);

  if (!prob || prob < 0.5 || prob > 0.98) return;

  const shares  = parseFloat((CFG.stake / prob).toFixed(2));
  const ganancia = parseFloat((shares - CFG.stake).toFixed(2));

  if (modoReal && slug) {
    try {
      await pmComprar(slug, prob, shares);
      console.log(`✅ COPY TRADE ejecutado: ${title} @ ${(prob*100).toFixed(0)}%`);
    } catch(e) {
      console.log(`⚠️ Error copy trade: ${e.response?.data?.message || e.message}`);
    }
  }

  const trade = {
    id: Date.now(), marketId: actividad.conditionId || slug,
    slug, titulo: `[COPY ${wallet.slice(0,6)}…] ${title}`,
    categoria: mapCategoria([], title, slug || ""),
    oddsEntrada: prob, oddsActual: prob,
    stake: CFG.stake, shares, potencial: shares, ganancia,
    pnl: 0, fuerza: "🔁 COPY",
    estado: "abierto", abiertaEn: new Date().toISOString(),
  };

  posicionesAbiertas.push(trade);
  historialTrades.unshift({ ...trade });
  presupuestoUsado = parseFloat((presupuestoUsado + CFG.stake).toFixed(2));
  tradesHoy++;
  console.log(`📋 COPY registrado: ${trade.titulo}`);
};

// El trader vendió → cerrar NUESTRA posición copiada de ese mismo mercado
const cerrarCopyTrade = async (actividad, wallet) => {
  const slug = actividad.market?.slug || actividad.slug;
  if (!slug) return;

  // Buscar la posición que copiamos de ESTE trader en ESTE mercado
  const idx = posicionesAbiertas.findIndex(p =>
    p.slug === slug && (p.titulo || "").includes(`COPY ${wallet.slice(0,6)}`));
  if (idx === -1) return; // no tenemos posición copiada ahí, nada que cerrar

  const pos = posicionesAbiertas[idx];

  if (modoReal) {
    try {
      await pmCerrar(slug);
      console.log(`✅ COPY SALIDA: ${pos.titulo} (el trader vendió)`);
    } catch(e) {
      console.log(`⚠️ Error cerrando copy: ${e.response?.data?.message || e.message}`);
    }
  }

  // Actualizar estado local: P&L según precio de salida del trader
  const probSalida = parseFloat(actividad.price || actividad.avgPrice || pos.oddsActual || pos.oddsEntrada);
  const pnl = parseFloat(((probSalida - pos.oddsEntrada) * pos.shares).toFixed(2));
  pos.estado = "cerrado_copy"; pos.pnl = pnl; pos.oddsActual = probSalida;
  pnlHoy = parseFloat((pnlHoy + pnl).toFixed(2));
  balanceReal = parseFloat((balanceReal + pnl).toFixed(2));
  if (pnl >= 0) ganados++; else perdidos++;
  presupuestoUsado = parseFloat(Math.max(0, presupuestoUsado - pos.stake).toFixed(2));
  historialTrades.unshift({ ...pos, cerradaEn: new Date().toISOString() });
  posicionesAbiertas.splice(idx, 1);
  console.log(`📋 COPY cerrado: ${pos.titulo} | PnL $${pnl}`);
};

const copiarTrades = async () => {
  if (!botActivo || copiandoSet.size === 0) return;
  console.log(`🔁 Verificando actividad de ${copiandoSet.size} traders copiados...`);

  for (const wallet of copiandoSet) {
    const actividades = await getTraderActivity(wallet);
    if (!actividades.length) continue;

    if (!ultimaActividad[wallet]) {
      // Primera vez: guardar IDs sin ejecutar
      ultimaActividad[wallet] = new Set(actividades.map(a => a.id || a.hash || a.transactionHash));
      console.log(`📌 ${wallet.slice(0,8)}: ${actividades.length} actividades previas ignoradas`);
      continue;
    }

    const vistas = ultimaActividad[wallet];
    // Procesar TODAS las actividades nuevas (compras Y ventas), en orden cronológico
    const nuevas = actividades.filter(a => {
      const id = a.id || a.hash || a.transactionHash;
      return id && !vistas.has(id);
    });

    for (const act of nuevas) {
      const id = act.id || act.hash || act.transactionHash;
      vistas.add(id);
      const lado = (act.side || act.type || "").toUpperCase();
      const esCompra = lado === "BUY" || act.outcome === "YES";
      const esVenta  = lado === "SELL";
      console.log(`🆕 ${wallet.slice(0,8)} ${lado || "?"}: ${act.market?.question?.slice(0,38) || id}`);
      if (esCompra)      await ejecutarCopyTrade(act, wallet);
      else if (esVenta)  await cerrarCopyTrade(act, wallet);
    }
  }
};

// Copy engine: cada 2 minutos
setInterval(copiarTrades, 2 * 60 * 1000);

// Refresh leaderboard real: cada hora
setInterval(async () => {
  console.log("🔄 Actualizando leaderboard...");
  tradersCache = await fetchLeaderboard();
}, 60 * 60 * 1000);

// Cargar leaderboard al inicio
fetchLeaderboard().then(t => { tradersCache = t; });

// Balance real: al inicio y cada 30s
actualizarBalanceReal();
setInterval(actualizarBalanceReal, 30 * 1000);

// ── FETCH MERCADOS REALES ─────────────────────────────────────────────────────
const fetchMercadosReales = async () => {
  try {
    console.log("\n🔍 Escaneando Polymarket...");

    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { active: true, closed: false, limit: 100 },
      timeout: 20000,
      headers: { "Accept": "application/json" },
    });

    const markets = Array.isArray(res.data) ? res.data : (res.data?.markets || res.data?.data || []);
    console.log(`📊 Total recibidos: ${markets.length}`);

    if (markets.length > 0) {
      const sample = markets[0];
      console.log("🔎 Muestra mercado:", JSON.stringify({
        question:     sample.question,
        outcomePrices: sample.outcomePrices,
        liquidity:    sample.liquidity,
        volume:       sample.volume,
        tags:         sample.tags,
      }, null, 2));
    }

    const validos = [];

    for (const m of markets) {
      // Obtener probabilidad YES
      let prob = 0;
      if (m.outcomePrices) {
        try {
          let raw = String(m.outcomePrices);
          // Extract first number from string like ["0.82", "0.18"] or [\"0.82\", \"0.18\"]
          const numMatch = raw.match(/([0-9]+\.?[0-9]*)/);
          prob = numMatch ? parseFloat(numMatch[1]) : 0;
        } catch(e) {
          const match = String(m.outcomePrices).match(/[0-9]+\.?[0-9]*/);
          prob = match ? parseFloat(match[0]) : 0;
        }
      }
      if (!prob && m.bestBid)  prob = parseFloat(m.bestBid)  || 0;
      if (!prob && m.lastPrice) prob = parseFloat(m.lastPrice) || 0;

      const liquidez  = parseFloat(m.liquidity || m.liquidityNum || 0);
      const volumen   = parseFloat(m.volume    || m.volumeNum    || 0);
      const categoria = mapCategoria(m.tags || [], m.question || "", m.slug || "");

      const resolveDate   = m.endDate || m.resolutionDate || m.endDateIso;
      const diasRestantes = resolveDate
        ? Math.ceil((new Date(resolveDate) - Date.now()) / 86400000)
        : 30;

      // Debug primeros 3 mercados
      if (validos.length === 0 && markets.indexOf(m) < 3) {
        console.log(`  Mercado: ${m.question?.slice(0,40)} | prob:${prob} | liq:${liquidez} | dias:${diasRestantes}`);
      }

      const mercadoTemp = { categoria };
      const enVivo    = esDeporteEnVivo(mercadoTemp, prob, diasRestantes);
      const intraday  = esIndiceIntraday(categoria, diasRestantes);

      // Filtros según tipo de mercado
      if (enVivo) {
        // Deporte en vivo: 75%+ y $200 liquidez mínimo
        if (prob < 0.75) continue;
        if (liquidez < 200) continue;
        console.log(`⚡ DEPORTE EN VIVO: ${m.question?.slice(0,50)} | ${(prob*100).toFixed(0)}%`);
      } else if (intraday) {
        // Índices intraday (SPX/NQ mismo día): 65%+ porque tú conoces el mercado
        if (prob < 0.65) continue;
        if (liquidez < 300) continue;
        console.log(`📈 ÍNDICE INTRADAY: ${m.question?.slice(0,50)} | ${(prob*100).toFixed(0)}% | ${categoria}`);
      } else {
        // Mercados normales: 70%+ y $500 liquidez
        if (prob < CFG.minOdds || prob > CFG.maxOdds) continue;
        if (liquidez < CFG.minLiquidity) continue;
        if (diasRestantes < 1 || diasRestantes > 90) continue;
      }

      // clobTokenIds[0] = token YES, clobTokenIds[1] = token NO
      let clobTokenId = null;
      if (m.clobTokenIds) {
        try {
          const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          clobTokenId = ids[0] || null;
        } catch(_) {}
      }

      validos.push({
        id:           m.id || m.conditionId || m.slug,
        slug:         m.slug,
        conditionId:  m.conditionId,
        clobTokenId,
        titulo:       m.question || m.title || "Sin título",
        categoria,
        prob:         parseFloat(prob.toFixed(4)),
        volumen:      Math.round(volumen),
        liquidez:     Math.round(liquidez),
        diasRestantes,
        enVivo,
        stake:        CFG.stake,
        tradersCount: Math.floor(Math.random() * 5) + 1,
        fuerza:       enVivo   ? "🔴 EN VIVO" :
                      intraday ? "📈 INTRADAY" :
                      prob >= 0.85 ? "MÁXIMA" :
                      prob >= 0.78 ? "FUERTE" :
                      prob >= 0.72 ? "MEDIA" : "DÉBIL",
        intraday,
      });
    }

    mercadosActivos = validos;
    console.log(`✅ Válidos encontrados: ${validos.length}`);

    if (botActivo && !circuitBreaker && validos.length > 0) {
      // Priorizar deportes en vivo, luego por probabilidad
      const ordenadas = [...validos].sort((a, b) => {
        if (a.enVivo && !b.enVivo) return -1;
        if (!a.enVivo && b.enVivo) return 1;
        return b.prob - a.prob;
      });
      const nuevas = ordenadas.slice(0, 15).filter(m =>
        !senalesPendientes.find(s => s.id === m.id) &&
        !posicionesAbiertas.find(p => p.marketId === m.id)
      );
      senalesPendientes = [...nuevas, ...senalesPendientes].slice(0, 20);
      const liveCount = nuevas.filter(s => s.enVivo).length;
      console.log(`📡 ${nuevas.length} nuevas señales (${liveCount} en vivo) agregadas`);
    }

    return validos;
  } catch (err) {
    console.error("❌ Error API:", err.message);
    if (err.response) console.error("Response:", err.response.status, JSON.stringify(err.response.data).slice(0, 200));
    return [];
  }
};

// ── EJECUTAR TRADE REAL ───────────────────────────────────────────────────────
const ejecutarTrade = async (mercado, stake, fuerza) => {
  if ((CFG.budget - presupuestoUsado) < stake || circuitBreaker || !botActivo) return null;

  const shares   = parseFloat((stake / mercado.prob).toFixed(2));
  const ganancia = parseFloat((shares - stake).toFixed(2));

  // Ejecutar orden REAL via polymarket.us
  if (modoReal && mercado.slug) {
    try {
      console.log(`🔄 Ejecutando orden REAL: ${mercado.titulo} — $${stake} @ ${(mercado.prob*100).toFixed(0)}%`);
      const orderResp = await pmComprar(mercado.slug, mercado.prob, shares);
      console.log(`✅ ORDEN REAL: ${JSON.stringify(orderResp).slice(0,120)}`);
    } catch(e) {
      console.log(`⚠️ Error orden real: ${e.response?.data?.message || e.message}`);
    }
  } else if (!modoReal) {
    console.log(`📊 SIMULACIÓN: ${mercado.titulo}`);
  }

  const trade = {
    id: Date.now(), marketId: mercado.id, slug: mercado.slug,
    titulo: mercado.titulo, categoria: mercado.categoria,
    oddsEntrada: mercado.prob, oddsActual: mercado.prob,
    stake: parseFloat(stake.toFixed(2)), shares, potencial: shares, ganancia,
    pnl: 0, fuerza, tradersCount: mercado.tradersCount || 1,
    estado: "abierto", abiertaEn: new Date().toISOString(),
  };

  posicionesAbiertas.push(trade);
  historialTrades.unshift({ ...trade });
  presupuestoUsado = parseFloat((presupuestoUsado + stake).toFixed(2));
  tradesHoy++;
  console.log(`📊 TRADE REGISTRADO: ${mercado.titulo} — $${stake} @ ${(mercado.prob*100).toFixed(0)}%`);
  return trade;
};

// Auto-ejecutar señales fuertes cada 2 minutos
setInterval(() => {
  if (!botActivo || circuitBreaker) return;
  const fuertes = senalesPendientes.filter(s => s.fuerza === "FUERTE" || s.fuerza === "MÁXIMA");
  fuertes.slice(0, 2).forEach(s => {
    ejecutarTrade(s, CFG.stake * (s.fuerza === "MÁXIMA" ? 2 : 1.5), s.fuerza);
    senalesPendientes = senalesPendientes.filter(x => x.id !== s.id);
  });
}, 2 * 60 * 1000);

// Scan inicial y cada 5 minutos
fetchMercadosReales();
setInterval(fetchMercadosReales, 5 * 60 * 1000);

// Reset diario
cron.schedule("0 0 * * *", () => {
  pnlHoy = 0; tradesHoy = 0; ganados = 0; perdidos = 0;
  presupuestoUsado = 0; rachaPerder = 0; circuitBreaker = false;
  historialBalance.push({ dia: new Date().toLocaleDateString("es-ES", {day:"2-digit",month:"2-digit"}), valor: balanceReal });
});

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const wr = (ganados+perdidos) > 0 ? (ganados/(ganados+perdidos)*100) : 0;
  // Balance mostrado = REAL de polymarket.us si está disponible; si no, el presupuesto
  const balanceMostrado = (balanceTotalReal !== null) ? balanceTotalReal : balanceReal;
  res.json({
    botActivo, circuitBreaker, balance: balanceMostrado,
    balanceCash, balanceEnPos, balanceTotalReal, balanceBase: balanceBaseReal,
    pnlHoy: parseFloat(pnlHoy.toFixed(2)),
    tradesHoy, ganados, perdidos,
    winRate: parseFloat(wr.toFixed(1)),
    presupuestoTotal: CFG.budget,
    presupuestoUsado: parseFloat(presupuestoUsado.toFixed(2)),
    presupuestoRestante: (balanceCash !== null) ? balanceCash : parseFloat((CFG.budget - presupuestoUsado).toFixed(2)),
    stake: CFG.stake, minOdds: CFG.minOdds,
    mercadosEscaneados: mercadosActivos.length,
    unrealizedPnl: parseFloat(posicionesAbiertas.reduce((s,t) => s+(t.pnl||0), 0).toFixed(2)),
    apiConectada: !!CFG.keyId,
    modoReal,
    keyIdActivo: modoReal ? pmUs.keyId?.slice(0,8)+"…" : null,
    tradersCopiados: copiandoSet.size,
  });
});

app.get("/api/markets",           (req, res) => res.json(mercadosActivos.slice(0,50)));
app.get("/api/signals/pending",   (req, res) => res.json(senalesPendientes));
app.get("/api/trades/open",       (req, res) => res.json(posicionesAbiertas));
app.get("/api/trades/historial",  (req, res) => res.json(historialTrades.slice(0,50)));
app.get("/api/balance/historial", (req, res) => res.json(historialBalance));
app.get("/api/traders", async (req, res) => {
  if (!tradersCache.length) tradersCache = await fetchLeaderboard();
  if (tradersCache.length) {
    return res.json(tradersCache.map(t => ({ ...t, copiando: copiandoSet.has(t.wallet) })));
  }
  // Fallback mock si la API no responde
  res.json([
    { wallet:"0x7f3a", alias:"Theo4",     winRate:84, roi:340, categoria:"CRYPTO",  activo:"2h", copiando:copiandoSet.has("0x7f3a"), score:94 },
    { wallet:"0x9b2c", alias:"beachboy4", winRate:79, roi:280, categoria:"SPORTS",  activo:"5h", copiando:copiandoSet.has("0x9b2c"), score:88 },
    { wallet:"0x4e1d", alias:"HorizonS",  winRate:77, roi:195, categoria:"MACRO",   activo:"1d", copiando:copiandoSet.has("0x4e1d"), score:72 },
    { wallet:"0xAB21", alias:"gopfan2",   winRate:75, roi:142, categoria:"CRYPTO",  activo:"3h", copiando:copiandoSet.has("0xAB21"), score:68 },
    { wallet:"0xC932", alias:"reachingS", winRate:76, roi:168, categoria:"POLITICA",activo:"6h", copiando:copiandoSet.has("0xC932"), score:80 },
  ]);
});

app.post("/api/signals/:id/ejecutar", (req, res) => {
  const s = senalesPendientes.find(x => x.id === parseInt(req.params.id));
  if (!s) return res.status(404).json({ error: "No encontrada" });
  const t = ejecutarTrade(s, s.stake, s.fuerza);
  senalesPendientes = senalesPendientes.filter(x => x.id !== s.id);
  res.json({ success: !!t, trade: t });
});

app.post("/api/signals/:id/saltar", (req, res) => {
  senalesPendientes = senalesPendientes.filter(s => s.id !== parseInt(req.params.id));
  res.json({ success: true });
});

app.post("/api/trades/:id/cerrar", (req, res) => {
  const idx = posicionesAbiertas.findIndex(t => t.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "No encontrada" });
  const trade = posicionesAbiertas[idx];
  const pnl = parseFloat((trade.stake * trade.oddsActual - trade.stake).toFixed(2));
  trade.estado = "cerrado_manual"; trade.pnl = pnl;
  pnlHoy += pnl; balanceReal = parseFloat((balanceReal + pnl).toFixed(2));
  if (pnl > 0) ganados++; else perdidos++;
  historialTrades.unshift({ ...trade, cerradaEn: new Date().toISOString() });
  posicionesAbiertas.splice(idx, 1);
  res.json({ success: true, pnl });
});

app.post("/api/trades/:id/aumentar", (req, res) => {
  const trade = posicionesAbiertas.find(t => t.id === parseInt(req.params.id));
  if (!trade) return res.status(404).json({ error: "No encontrada" });
  const extra = parseFloat(req.body.monto) || CFG.stake;
  if (extra > (CFG.budget - presupuestoUsado)) return res.status(400).json({ error: "Presupuesto insuficiente" });
  trade.stake = parseFloat((trade.stake + extra).toFixed(2));
  trade.shares = parseFloat((trade.stake / trade.oddsEntrada).toFixed(2));
  trade.potencial = trade.shares;
  trade.ganancia = parseFloat((trade.potencial - trade.stake).toFixed(2));
  presupuestoUsado += extra;
  res.json({ success: true, nuevoStake: trade.stake, nuevoPotencial: trade.potencial });
});

// ── POSICIONES REALES DESDE POLYMARKET.US ────────────────────────────────────
app.get("/api/mis-posiciones", async (req, res) => {
  if (!modoReal) {
    return res.json({ error: "Sin credenciales — modo simulación", modoReal: false, posiciones: [], trades: [] });
  }
  try {
    const [posRes, actRes] = await Promise.all([
      pmUs.get("/v1/portfolio/positions").catch(e => { console.log("positions err:", e.message); return {}; }),
      pmUs.get("/v1/portfolio/activities", true, { limit: 30 }).catch(e => { console.log("activities err:", e.message); return {}; }),
    ]);

    // positions viene como OBJETO { slug: {...} } — convertir a array y normalizar
    const posObj = (posRes?.positions && typeof posRes.positions === "object" && !Array.isArray(posRes.positions))
      ? posRes.positions : {};
    const posBase = Object.values(posObj)
      .filter(p => parseFloat(p.netPosition || 0) > 0)   // solo posiciones abiertas
      .map(p => {
        const shares = parseFloat(p.netPosition || 0);
        const costo  = parseFloat(p.cost?.value || 0);
        const meta   = p.marketMetadata || {};
        return {
          titulo:     meta.title || meta.slug || "Posición",
          slug:       meta.slug || "",
          outcome:    meta.outcome || "",
          icono:      meta.team?.logo || meta.team?.longIcon || meta.icon || "",
          shares,
          costo:      parseFloat(costo.toFixed(2)),
          precioProm: shares > 0 ? parseFloat((costo / shares).toFixed(3)) : 0,
        };
      });

    // Enriquecer cada posición con el precio actual del mercado + P&L
    const posiciones = await Promise.all(posBase.map(async (p) => {
      const precioActual = await pmPrecioActual(p.slug);
      if (precioActual === null) return { ...p, precioActual: null, valorActual: null, pnl: null, pnlPct: null };
      const valorActual = parseFloat((p.shares * precioActual).toFixed(2));
      const pnl    = parseFloat((valorActual - p.costo).toFixed(2));
      const pnlPct = p.costo > 0 ? parseFloat(((pnl / p.costo) * 100).toFixed(1)) : 0;
      return { ...p, precioActual: parseFloat(precioActual.toFixed(3)), valorActual, pnl, pnlPct };
    }));

    // activities (historial) — normalizado y legible
    const actArr = Array.isArray(actRes?.activities) ? actRes.activities : [];
    const trades = actArr.slice(0, 30).map(a => {
      const r    = a.positionResolution || a.trade || a.fill || a.order || {};
      const meta = r.marketMetadata || r.beforePosition?.marketMetadata || {};
      return {
        titulo: meta.title || meta.slug || (a.type || "").replace("ACTIVITY_TYPE_", "") || "Actividad",
        tipo:   (a.type || "").replace("ACTIVITY_TYPE_", "").replace(/_/g, " "),
      };
    });

    res.json({ modoReal: true, keyId: pmUs.keyId?.slice(0,8)+"…", posiciones, trades });
  } catch(e) {
    console.error("Error posiciones:", e.message);
    res.json({ error: e.message, modoReal: true, posiciones: [], trades: [] });
  }
});

// Comprar MÁS de una posición existente
app.post("/api/mis-posiciones/comprar", async (req, res) => {
  if (!modoReal) return res.status(400).json({ error: "Modo simulación" });
  const { slug, monto } = req.body;
  if (!slug) return res.status(400).json({ error: "Falta slug" });
  try {
    const b = await pmBbo(slug);
    const precioCompra = b.ask || b.last || b.bid;
    if (!precioCompra) return res.status(400).json({ error: "No hay precio de mercado" });
    const dolares  = parseFloat(monto) || CFG.stake;
    const quantity = Math.max(1, Math.round(dolares / precioCompra));
    const r = await pmComprar(slug, precioCompra, quantity);
    console.log(`✅ Compra manual: ${slug} +$${dolares} (${quantity} sh @ ~${(precioCompra*100).toFixed(0)}¢)`);
    setTimeout(actualizarBalanceReal, 2000);
    res.json({ success: true, comprado: quantity, precio: precioCompra, order: r });
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Vender una posición — completa o PARCIAL (sacar el dinero)
app.post("/api/mis-posiciones/vender", async (req, res) => {
  if (!modoReal) return res.status(400).json({ error: "Modo simulación" });
  const { slug, shares } = req.body;
  if (!slug) return res.status(400).json({ error: "Falta slug" });
  try {
    // Cuántos shares tiene la posición
    const pos   = await pmUs.get("/v1/portfolio/positions");
    const p     = (pos?.positions || {})[slug];
    const total = p ? parseFloat(p.netPosition || 0) : 0;
    if (total <= 0) return res.status(400).json({ error: "No tienes esa posición" });

    const pedido = parseInt(shares) || total;
    const vender = Math.min(pedido, total);

    let r;
    if (vender >= total) {
      r = await pmCerrar(slug);                 // todo → close-position
      console.log(`✅ Venta TOTAL: ${slug} (${total} sh)`);
    } else {
      r = await pmVender(slug, vender);          // parcial → SELL limit al bid
      console.log(`✅ Venta PARCIAL: ${slug} ${vender}/${total} sh`);
    }
    setTimeout(actualizarBalanceReal, 2000);
    res.json({ success: true, vendido: vender, total, order: r });
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// (compat) Cerrar posición completa
app.post("/api/mis-posiciones/cerrar", async (req, res) => {
  if (!modoReal) return res.status(400).json({ error: "Modo simulación" });
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: "Falta slug" });
  try {
    const r = await pmCerrar(slug);
    console.log(`✅ Venta manual (cierre): ${slug}`);
    setTimeout(actualizarBalanceReal, 2000);
    res.json({ success: true, order: r });
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.post("/api/bot/pausar",        (req, res) => { botActivo = false; res.json({ botActivo }); });
app.post("/api/bot/reanudar",      (req, res) => { botActivo = true;  res.json({ botActivo }); });
app.post("/api/bot/reset-circuit", (req, res) => { circuitBreaker = false; rachaPerder = 0; res.json({ success: true }); });
app.post("/api/bot/scan-ahora",    async (req, res) => { const m = await fetchMercadosReales(); res.json({ mercados: m.length }); });
app.post("/api/traders/:w/toggle", (req, res) => {
  const wallet = req.params.w;
  if (copiandoSet.has(wallet)) {
    copiandoSet.delete(wallet);
    delete ultimaActividad[wallet];
    console.log(`🔴 Dejando de copiar: ${wallet.slice(0,8)}…`);
    res.json({ success: true, copiando: false });
  } else {
    copiandoSet.add(wallet);
    // Inicializar actividad previa para no re-ejecutar trades viejos
    getTraderActivity(wallet).then(acts => {
      ultimaActividad[wallet] = new Set(acts.map(a => a.id || a.hash || a.transactionHash).filter(Boolean));
      console.log(`✅ Copiando ${wallet.slice(0,8)}… (${ultimaActividad[wallet].size} actividades previas ignoradas)`);
    });
    res.json({ success: true, copiando: true });
  }
});
app.post("/api/config", (req, res) => {
  const { stake, presupuesto, minOdds } = req.body;
  if (stake)       CFG.stake   = parseFloat(stake);
  if (presupuesto) CFG.budget  = parseFloat(presupuesto);
  if (minOdds)     CFG.minOdds = parseFloat(minOdds);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       🤖 POLYBOT INICIADO            ║");
  console.log(`║  Dashboard: http://localhost:${PORT}   ║`);
  console.log("╚══════════════════════════════════════╝");
  console.log(`\n💰 Balance: $${CFG.budget} | 🎯 Stake: $${CFG.stake} | 📊 Min Odds: ${CFG.minOdds*100}%`);
  console.log(`🔑 API: ${CFG.keyId ? "✅ configurada" : "❌ falta"}\n`);
});
