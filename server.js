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
  maxOdds:      0.92,   // hasta 92% (incluye sports live ganando)
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

// ── CLIENTE CLOB (trading real + leer posiciones) ────────────────────────────
let clobClient    = null;
let walletAddress = process.env.POLYMARKET_WALLET_ADDRESS || null;
let modoReal      = false;

try {
  const { ClobClient } = require("@polymarket/clob-client-v2");

  const creds = {
    key:        process.env.POLYMARKET_KEY_ID        || "",
    secret:     process.env.POLYMARKET_SECRET_KEY    || "",
    passphrase: process.env.POLYMARKET_PASSPHRASE    || "",
  };

  let signer = null;

  if (process.env.POLYMARKET_PRIVATE_KEY) {
    const { createWalletClient, http }  = require("viem");
    const { privateKeyToAccount }       = require("viem/accounts");
    const { polygon }                   = require("viem/chains");

    const rawKey = process.env.POLYMARKET_PRIVATE_KEY;
    const privKey = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
    const account = privateKeyToAccount(privKey);
    walletAddress = account.address;

    signer = createWalletClient({
      account,
      chain:     polygon,
      transport: http("https://polygon-rpc.com"),
    });

    modoReal = true;
    console.log(`✅ Wallet: ${walletAddress.slice(0,8)}...${walletAddress.slice(-4)} — MODO REAL 💰`);
  } else {
    console.log("⚠️  POLYMARKET_PRIVATE_KEY no configurada — MODO SIMULACIÓN");
    console.log("   Para operar con dinero real, agrega POLYMARKET_PRIVATE_KEY en .env");
  }

  clobClient = new ClobClient({
    host:   "https://clob.polymarket.com",
    chain:  137,
    signer,
    creds,
  });

  console.log("✅ CLOB Client conectado");
} catch(e) {
  console.log("⚠️ ClobClient no disponible:", e.message);
}

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

// ── CATEGORÍAS ────────────────────────────────────────────────────────────────
const mapCategoria = (tags = [], question = "") => {
  const t = (tags.join(" ") + " " + question).toLowerCase();
  // Futuros e índices (prioridad alta - tu especialidad)
  if (t.includes("s&p")    || t.includes("spx")     || t.includes("sp500")    || 
      t.includes("s&p 500") || t.includes("spy")     || t.includes("es future")) return "SPX";
  if (t.includes("nasdaq") || t.includes("qqq")     || t.includes("nq")       || 
      t.includes("nasdaq 100") || t.includes("ndx"))                             return "NQ";
  if (t.includes("dow")    || t.includes("djia")    || t.includes("ym future")) return "DOW";
  if (t.includes("vix")    || t.includes("volatility"))                          return "VIX";
  // Deportes
  if (t.includes("mlb")    || t.includes("baseball") || t.includes("yankees") || 
      t.includes("dodgers") || t.includes("mets")    || t.includes("braves")  ||
      t.includes("astros")  || t.includes("red sox") || t.includes("cubs"))    return "BEISBOL";
  if (t.includes("nba")    || t.includes("lakers")   || t.includes("warriors") || 
      t.includes("celtics") || t.includes("heat")    || t.includes("nuggets")) return "NBA";
  if (t.includes("nfl")    || t.includes("chiefs")   || t.includes("cowboys")  || 
      t.includes("eagles")  || t.includes("patriots"))                          return "NFL";
  if (t.includes("ufc")    || t.includes("mma")      || t.includes("boxing"))  return "UFC";
  if (t.includes("soccer") || t.includes("madrid")   || t.includes("barcelona") || 
      t.includes("premier") || t.includes("champions"))                         return "SOCCER";
  if (t.includes("sport"))  return "SPORTS";
  // Crypto
  if (t.includes("bitcoin") || t.includes("btc")    || t.includes("eth")      || 
      t.includes("solana")   || t.includes("crypto") || t.includes("ethereum")) return "CRYPTO";
  // Macro y política
  if (t.includes("fed")    || t.includes("rate")    || t.includes("inflation") || 
      t.includes("gdp")     || t.includes("cpi")    || t.includes("recession")) return "MACRO";
  if (t.includes("elect")  || t.includes("presid")  || t.includes("trump")    || 
      t.includes("congress")|| t.includes("senate")  || t.includes("house"))   return "POLITICA";
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

  if (polyClient && slug) {
    try {
      await polyClient.orders.create({
        marketSlug: slug,
        intent:     "ORDER_INTENT_BUY_LONG",
        type:       "ORDER_TYPE_LIMIT",
        price:      { value: prob.toFixed(2), currency: "USD" },
        quantity:   Math.floor(CFG.stake / prob),
        tif:        "TIME_IN_FORCE_GOOD_TILL_CANCEL",
      });
      console.log(`✅ COPY TRADE ejecutado: ${title} @ ${(prob*100).toFixed(0)}%`);
    } catch(e) {
      console.log(`⚠️ Error ejecutando copy trade: ${e.message}`);
    }
  }

  const trade = {
    id: Date.now(), marketId: actividad.conditionId || slug,
    slug, titulo: `[COPY ${wallet.slice(0,6)}…] ${title}`,
    categoria: mapCategoria([], title),
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
    const nuevas = actividades.filter(a => {
      const id = a.id || a.hash || a.transactionHash;
      return id && !vistas.has(id) && (a.side === "BUY" || a.type === "BUY" || a.outcome === "YES");
    });

    for (const act of nuevas) {
      const id = act.id || act.hash || act.transactionHash;
      vistas.add(id);
      console.log(`🆕 Nueva actividad de ${wallet.slice(0,8)}: ${act.market?.question?.slice(0,40) || id}`);
      await ejecutarCopyTrade(act, wallet);
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
      const categoria = mapCategoria(m.tags || [], m.question || "");

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

  // Ejecutar orden REAL via CLOB si tenemos private key
  if (modoReal && clobClient && mercado.clobTokenId) {
    try {
      console.log(`🔄 Ejecutando orden REAL: ${mercado.titulo} — $${stake} @ ${(mercado.prob*100).toFixed(0)}%`);
      const orderResp = await clobClient.createAndPostOrder({
        tokenID: mercado.clobTokenId,
        price:   mercado.prob,
        side:    "BUY",
        size:    shares,
      });
      console.log(`✅ ORDEN REAL EJECUTADA: orderId=${orderResp?.orderID || orderResp?.id || "?"}`);
    } catch(e) {
      console.log(`⚠️ Error orden real: ${e.message}`);
    }
  } else if (!modoReal) {
    console.log(`📊 SIMULACIÓN: ${mercado.titulo} — agrega POLYMARKET_PRIVATE_KEY para trades reales`);
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
  res.json({
    botActivo, circuitBreaker, balance: balanceReal,
    pnlHoy: parseFloat(pnlHoy.toFixed(2)),
    tradesHoy, ganados, perdidos,
    winRate: parseFloat(wr.toFixed(1)),
    presupuestoTotal: CFG.budget,
    presupuestoUsado: parseFloat(presupuestoUsado.toFixed(2)),
    presupuestoRestante: parseFloat((CFG.budget - presupuestoUsado).toFixed(2)),
    stake: CFG.stake, minOdds: CFG.minOdds,
    mercadosEscaneados: mercadosActivos.length,
    unrealizedPnl: parseFloat(posicionesAbiertas.reduce((s,t) => s+(t.pnl||0), 0).toFixed(2)),
    apiConectada: !!CFG.keyId,
    modoReal,
    wallet: walletAddress ? walletAddress.slice(0,8)+"..."+walletAddress.slice(-4) : null,
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

// ── POSICIONES REALES DESDE POLYMARKET ───────────────────────────────────────
app.get("/api/mis-posiciones", async (req, res) => {
  if (!modoReal || !clobClient) {
    return res.json({
      error:      "Modo simulación — agrega POLYMARKET_PRIVATE_KEY en Render para ver posiciones reales",
      modoReal:   false,
      posiciones: [],
      trades:     [],
    });
  }
  try {
    const [ordersRes, tradesRes] = await Promise.all([
      clobClient.getOpenOrders().catch(e => { console.log("getOpenOrders err:", e.message); return []; }),
      clobClient.getTrades({ maker_address: walletAddress }).catch(e => { console.log("getTrades err:", e.message); return []; }),
    ]);
    const ordenes = Array.isArray(ordersRes) ? ordersRes : (ordersRes?.data || []);
    const trades  = Array.isArray(tradesRes) ? tradesRes : (tradesRes?.data || []);
    res.json({ modoReal: true, wallet: walletAddress, posiciones: ordenes.slice(0,20), trades: trades.slice(0,30) });
  } catch(e) {
    console.error("Error posiciones:", e.message);
    res.json({ error: e.message, modoReal: true, posiciones: [], trades: [] });
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
