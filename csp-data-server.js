import express from "express";
import cors from "cors";
import path from "path";

const app = express();
app.use(cors());
app.use(express.static("."));                 // serves files in this folder
const PORT = process.env.PORT || 3000;

// Tradier serves real options chains (with ORATS greeks/IV) reliably from cloud IPs,
// unlike Yahoo which blocks datacenter addresses. The token is provided via an
// environment variable so it never lives in the (public) repo.
//   - Free sandbox (delayed data):  https://sandbox.tradier.com/v1   (default)
//   - Production (real-time):        https://api.tradier.com/v1      (needs a funded account token)
const TRADIER_BASE = (process.env.TRADIER_BASE || "https://sandbox.tradier.com/v1").replace(/\/$/, "");
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || "";

async function tradier(pathname, params = {}) {
  if (!TRADIER_TOKEN) throw new Error("TRADIER_TOKEN is not set on the server");
  const url = new URL(TRADIER_BASE + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: "application/json" } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Tradier ${r.status} ${r.statusText}${body ? " – " + body.slice(0, 120) : ""}`);
  }
  return r.json();
}

// Tradier collapses single-element lists into a bare object, and returns null for "no data".
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const num = (x) => (x == null || x === "" ? 0 : Number(x) || 0);
const mapType = (t) => (t === "stock" ? "EQUITY" : t ? String(t).toUpperCase() : null);   // -> dashboard's quoteType
const ivOf = (g) => num(g?.mid_iv) || num(g?.smv_vol) || ((num(g?.bid_iv) + num(g?.ask_iv)) / 2) || 0;

async function getQuote(symbol) {
  const j = await tradier("/markets/quotes", { symbols: symbol });
  return arr(j?.quotes?.quote)[0] || null;
}

app.get("/quote", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) return res.status(400).json({ error: "pass ?symbols=COHR,AMD" });
    const j = await tradier("/markets/quotes", { symbols: symbols.join(",") });
    res.json(arr(j?.quotes?.quote).map(q => ({ symbol: q.symbol, price: num(q.last ?? q.close ?? q.prevclose) })));
  } catch (err) { console.error("[/quote]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/options", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });

    // 1) underlying quote — spot price, name and security type
    const q = await getQuote(symbol);
    if (!q) return res.status(500).json({ error: "no data — is that a valid ticker?" });
    const spot = num(q.last ?? q.close ?? q.prevclose);

    // 2) available expirations (nearest first)
    const ej = await tradier("/markets/options/expirations", { symbol, includeAllRoots: "true", strikes: "false" });
    const expirations = arr(ej?.expirations?.date).map(String);
    if (!expirations.length) {
      return res.json({ symbol, underlyingPrice: spot, quoteType: mapType(q.type), name: q.description || null,
        expiration: null, expirationDates: [], calls: [], puts: [] });
    }
    const wanted = String(req.query.date || "");
    const expiration = expirations.includes(wanted) ? wanted : expirations[0];

    // 3) full chain for the chosen expiration, with greeks for implied volatility
    const cj = await tradier("/markets/options/chains", { symbol, expiration, greeks: "true" });
    const map = (o) => ({
      strike: num(o.strike), bid: num(o.bid), ask: num(o.ask), lastPrice: num(o.last),
      impliedVolatility: ivOf(o.greeks), openInterest: num(o.open_interest), volume: num(o.volume),
      inTheMoney: o.option_type === "call" ? num(o.strike) < spot : num(o.strike) > spot,
    });
    const opts = arr(cj?.options?.option);
    const calls = opts.filter(o => o.option_type === "call").map(map).sort((a, b) => a.strike - b.strike);
    const puts  = opts.filter(o => o.option_type === "put").map(map).sort((a, b) => a.strike - b.strike);

    res.json({ symbol, underlyingPrice: spot, quoteType: mapType(q.type), name: q.description || null,
      expiration, expirationDates: expirations, calls, puts });
  } catch (err) { console.error("[/options]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/earnings", async (req, res) => {
  // Tradier's free sandbox has no earnings calendar; degrade gracefully so the dashboard
  // simply omits the earnings badge instead of erroring.
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  res.json({ symbol, nextEarningsDate: null });
});

app.get("/history", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });
    const start = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const j = await tradier("/markets/history", { symbol, interval: "daily", start, end });
    const closes = arr(j?.history?.day).map(d => num(d.close)).filter(c => c > 0);
    res.json({ symbol, closes });
  } catch (err) { console.error("[/history]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/", (_req, res) => res.sendFile(path.resolve("csp-dashboard.html")));
app.listen(PORT, () => console.log(`CSP dashboard -> http://localhost:${PORT}  (data source: ${TRADIER_BASE})`));
