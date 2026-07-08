import express from "express";
import cors from "cors";
import path from "path";
import YahooFinance from "yahoo-finance2";

// Yahoo throttles the library's default self-identifying User-Agent from cloud/datacenter
// IPs, causing "Failed to get crumb, status 429" (works fine from home IPs). Presenting a
// real browser User-Agent gets past it. See gadicc/yahoo-finance2 issue #977.
const CHROME = 120 + Math.floor(Math.random() * 20);
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  fetchOptions: {
    headers: {
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME}.0.0.0 Safari/537.36`,
    },
  },
});
const app = express();
app.use(cors());
app.use(express.static("."));                 // serves files in this folder
const PORT = process.env.PORT || 3000;

app.get("/quote", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) return res.status(400).json({ error: "pass ?symbols=COHR,AMD" });
    const q = await yahooFinance.quote(symbols);
    const arr = Array.isArray(q) ? q : [q];
    res.json(arr.map(x => ({ symbol: x.symbol, price: x.regularMarketPrice })));
  } catch (err) { console.error("[/quote]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/options", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });
    const opts = req.query.date ? { date: new Date(req.query.date) } : {};
    const data = await yahooFinance.options(symbol, opts);
    const chain = data.options?.[0] || { calls: [], puts: [] };
    const map = (c) => ({ strike: c.strike, bid: c.bid ?? 0, ask: c.ask ?? 0, lastPrice: c.lastPrice ?? 0,
      impliedVolatility: c.impliedVolatility ?? 0, openInterest: c.openInterest ?? 0, volume: c.volume ?? 0, inTheMoney: !!c.inTheMoney });
    res.json({ symbol, underlyingPrice: data.quote?.regularMarketPrice ?? 0,
      quoteType: data.quote?.quoteType ?? null,
      name: data.quote?.longName || data.quote?.shortName || null,
      expiration: chain.expirationDate ? new Date(chain.expirationDate).toISOString().slice(0,10) : (req.query.date || null),
      expirationDates: (data.expirationDates || []).map(d => new Date(d).toISOString().slice(0,10)),
      calls: (chain.calls || []).map(map), puts: (chain.puts || []).map(map) });
  } catch (err) { console.error("[/options]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/earnings", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });
    const qs = await yahooFinance.quoteSummary(symbol, { modules: ["calendarEvents"] });
    const dates = qs?.calendarEvents?.earnings?.earningsDate || [];
    const next = dates.length ? new Date(dates[0]).toISOString().slice(0,10) : null;
    res.json({ symbol, nextEarningsDate: next });
  } catch (err) { console.error("[/earnings]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/history", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });
    const period1 = new Date(Date.now() - 420 * 86400000);
    const chart = await yahooFinance.chart(symbol, { period1, interval: "1d" });
    const closes = (chart.quotes || []).map(q => q.close).filter(c => c != null);
    res.json({ symbol, closes });
  } catch (err) { console.error("[/history]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/", (_req, res) => res.sendFile(path.resolve("csp-dashboard.html")));
app.listen(PORT, () => console.log(`CSP dashboard -> http://localhost:${PORT}`));
