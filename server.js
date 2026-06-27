require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ==================== CONFIG ====================
let CFG = {
  stakeBase: 2,
  minOverlap: 3,
  topTradersCount: 20,
  maxPosiciones: 25,
  autoConsensus: true,
};

let bankrollActual = parseFloat(process.env.DAILY_BUDGET) || 65;
let posicionesAbiertas = [];
let metricas = { tradesHoy: 0, overlapsHoy: 0 };

const DATA_API = "https://data-api.polymarket.com";

// ==================== HELPERS ====================
const getBankroll = () => Math.max(10, bankrollActual);

const detectarConsensus = async () => {
  if (!CFG.autoConsensus) return;

  console.log("🔍 Buscando overlaps entre top traders...");

  try {
    const lb = await axios.get(`${DATA_API}/leaderboard`, { 
      params: { period: "daily", limit: CFG.topTradersCount } 
    });
    
    const wallets = (lb.data?.users || []).slice(0, CFG.topTradersCount).map(u => u.wallet || u.address);
    
    const allPos = [];
    for (const w of wallets) {
      try {
        const res = await axios.get(`${DATA_API}/positions`, { 
          params: { user: w, limit: 15 } 
        });
        allPos.push(...(res.data?.positions || []));
      } catch(e) {}
    }

    const groups = {};
    allPos.forEach(p => {
      const key = p.market?.slug || p.conditionId;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    });

    for (const [key, traders] of Object.entries(groups)) {
      if (traders.length < CFG.minOverlap || posicionesAbiertas.length >= CFG.maxPosiciones) continue;

      const p = traders[0];
      const stake = Math.min(6, Math.max(1, Math.round(CFG.stakeBase * (traders.length >= 4 ? 1.7 : 1))));

      posicionesAbiertas.push({
        id: Date.now(),
        titulo: p.market?.question?.slice(0, 80) || "Mercado",
        overlap: traders.length,
        stake: stake,
        prob: parseFloat(p.price || 0.5),
        estado: "abierto",
        abiertaEn: new Date().toISOString()
      });

      metricas.tradesHoy++;
      metricas.overlapsHoy++;
      console.log(`✅ OVERLAP ${traders.length} traders → $${stake}`);
    }
  } catch(e) {
    console.log("Error en consensus:", e.message);
  }
};

// ==================== TIMERS ====================
setInterval(detectarConsensus, 90000); // cada 90 segundos

// ==================== DASHBOARD ====================
app.get("/api/status", (req, res) => {
  res.json({
    bankroll: getBankroll().toFixed(2),
    posiciones: posicionesAbiertas.length,
    tradesHoy: metricas.tradesHoy,
    overlapsHoy: metricas.overlapsHoy,
    status: "✅ CONSENSO API REAL ACTIVO",
    version: "FINAL"
  });
});

app.get("/api/trades/open", (req, res) => res.json(posicionesAbiertas));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🚀 POLYBOT FINAL - CONSENSO API REAL`);
  console.log(`💰 Bankroll: $${getBankroll()}`);
  console.log(`📡 Corriendo en http://localhost:${PORT}\n`);
});