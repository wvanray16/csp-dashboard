import express from "express";
import cors from "cors";
import path from "path";
import YahooFinance from "yahoo-finance2";

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));   // parse the login form POST
const PORT = process.env.PORT || 3000;

/* ============================ MEMBERS-ONLY ACCESS GATE ============================
   Each student gets a unique access code. Valid codes are provided via the ACCESS_CODES
   environment variable (comma-separated) so they never live in the public repo. Revoke a
   student by removing their code from ACCESS_CODES — access dies on their next page load.
   The login cookie simply stores the code and is re-checked against ACCESS_CODES on every
   request, so revocation is instant and no database is needed. */
const CODES = new Set((process.env.ACCESS_CODES || "").split(",").map(s => s.trim()).filter(Boolean));
const COOKIE = "csp_access";

const cookieVal = (req, name) => {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};
const authed = (req) => { const c = cookieVal(req, COOKIE); return !!c && CODES.has(c); };

const loginPage = (error = "") => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cash-Secured Put Desk — Member Login</title>
<style>
 :root{--bg:#0d1117;--panel:#161b22;--border:#2a3240;--text:#e6edf3;--muted:#8b98a9;--call:#3fb68b}
 *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(1100px 600px at 50% -10%, #12213a 0%, var(--bg) 60%);
  font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text);padding:20px}
 .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:34px 30px;width:100%;
  max-width:380px;box-shadow:0 24px 70px rgba(0,0,0,.45)}
 .brand{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
 h1{font-size:22px;margin:0 0 6px} h1 span{color:var(--call)}
 .sub{color:var(--muted);font-size:13px;margin:0 0 22px;line-height:1.5}
 label{display:block;font-size:11px;letter-spacing:.05em;color:var(--muted);margin:0 0 7px;text-transform:uppercase}
 input{width:100%;font-size:16px;font-family:ui-monospace,Menlo,monospace;letter-spacing:.04em;background:var(--bg);
  color:var(--text);border:1px solid var(--border);border-radius:9px;padding:12px 13px}
 input:focus{outline:none;border-color:var(--call);box-shadow:0 0 0 2px rgba(63,182,139,.25)}
 button{width:100%;margin-top:16px;font-size:15px;font-weight:600;cursor:pointer;background:var(--call);
  color:#04120c;border:0;border-radius:9px;padding:12px}
 button:hover{filter:brightness(1.07)}
 .err{background:rgba(224,108,117,.12);border:1px solid rgba(224,108,117,.4);color:#f2b8bd;font-size:13px;
  border-radius:8px;padding:10px 12px;margin-bottom:18px}
 .foot{margin-top:20px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5}
</style></head>
<body>
 <form class="card" method="POST" action="/login" autocomplete="off">
  <div class="brand">The Wheel · Options Desk</div>
  <h1>Cash-Secured Put <span>Desk</span></h1>
  <div class="sub">Members-only access. Enter the code from your course to continue.</div>
  ${error ? `<div class="err">${error}</div>` : ""}
  <label for="code">Access code</label>
  <input id="code" name="code" type="text" placeholder="your-code" autofocus spellcheck="false" />
  <button type="submit">Enter dashboard →</button>
  <div class="foot">Don't have a code? Find it in your course members area.</div>
 </form>
</body></html>`;

app.get("/login", (req, res) => { if (authed(req)) return res.redirect("/"); res.send(loginPage()); });
app.post("/login", (req, res) => {
  const code = String(req.body.code || "").trim();
  if (CODES.has(code)) {
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(code)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}`);
    return res.redirect("/");
  }
  res.status(401).send(loginPage("That code isn't valid. Check the code in your course, or ask your instructor."));
});
app.get("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect("/login");
});

// Everything past this point requires a valid access code.
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (["/quote", "/options", "/earnings", "/earnings/status", "/history"].includes(req.path))
    return res.status(401).json({ error: "Unauthorized — sign in with your access code." });
  return res.redirect("/login");
});

app.use(express.static("."));                 // serves the dashboard (now gated)

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

/* ---- Earnings dates (Yahoo, via yahoo-finance2) ----
   Previously Finnhub: it needed a key, its free tier silently row-capped the calendar, and a
   missing FINNHUB_TOKEN produced the same bare "—" as a symbol with nothing scheduled. Yahoo
   needs no key and no quota, and yahoo-finance2 handles its cookie/crumb handshake for us.

   Lookups are per-symbol rather than one bulk calendar, so results are cached per symbol —
   including the misses. Most of this watchlist is leveraged ETFs, which legitimately have no
   earnings; without negative caching every refresh would re-ask Yahoo about all of them. */
const EARNINGS_TTL_MS = 6 * 60 * 60 * 1000;              // earnings dates barely move
const EARNINGS_NONE_TTL_MS = 24 * 60 * 60 * 1000;        // "it's an ETF" stays true much longer
const EARNINGS_EMPTY_TTL_MS = 10 * 60 * 1000;            // an empty answer is not trustworthy — recheck soon
const EARNINGS_ERROR_TTL_MS = 60 * 1000;                 // brief backoff so failures don't storm
const EARNINGS_EMPTY_RETRIES = 2;                        // Yahoo returns an empty array ~40% of the time

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/* symbol -> { at, date, kind }  kind: 'ok' | 'none' | 'empty' | 'error' */
const _earn = new Map();
let _earnLastError = null;

const ttlFor = (kind) =>
  kind === "ok" ? EARNINGS_TTL_MS
  : kind === "none" ? EARNINGS_NONE_TTL_MS
  : kind === "empty" ? EARNINGS_EMPTY_TTL_MS
  : EARNINGS_ERROR_TTL_MS;

/* Two different "no date" answers, and conflating them is what makes the column lie:
     - THROWS "No fundamentals data found"  -> genuinely has no earnings (every leveraged ETF
       here). A settled fact, safe to cache for a day.
     - RETURNS an earnings object with an EMPTY earningsDate array -> Yahoo being flaky. GLW
       does this on roughly 2 of every 5 calls despite reporting on 2026-07-28. Caching that
       as "no earnings" would blank a real date for a day — the very bug we are fixing.
   So: retry an empty answer, and if it stays empty, cache it only briefly. */
const isNoDataError = (msg) => /no fundamentals data/i.test(msg || "");

async function earningsFor(symbol) {
  const hit = _earn.get(symbol);
  if (hit && Date.now() - hit.at < ttlFor(hit.kind)) return hit;

  let entry;
  for (let attempt = 0; attempt <= EARNINGS_EMPTY_RETRIES; attempt++) {
    try {
      const r = await yahoo.quoteSummary(symbol, { modules: ["calendarEvents"] });
      const e = r?.calendarEvents?.earnings;
      const raw = e?.earningsDate?.[0];
      _earnLastError = null;
      if (raw) {
        entry = { at: Date.now(), date: new Date(raw).toISOString().slice(0, 10),
                  kind: "ok", estimated: Boolean(e?.isEarningsDateEstimate) };
        break;                                            // got a date — done
      }
      entry = { at: Date.now(), date: null, kind: "empty" };
      continue;                                           // empty: try again before believing it
    } catch (err) {
      if (isNoDataError(err.message)) {
        entry = { at: Date.now(), date: null, kind: "none" };   // settled: no earnings exist
      } else {
        console.error("[earnings]", symbol, err.message);
        _earnLastError = `${symbol}: ${err.message}`;
        entry = { at: Date.now(), date: null, kind: "error", reason: String(err.message).slice(0, 160) };
      }
      break;
    }
  }
  _earn.set(symbol, entry);
  return entry;
}

/* A null date used to be ambiguous: a broken feed and "this is an ETF" looked identical.
   `status` separates them so a real failure announces itself instead of passing as "no
   earnings" — which is what let the column sit empty for so long without anyone noticing. */
app.get("/earnings", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });
  const e = await earningsFor(symbol);
  res.json({
    symbol,
    nextEarningsDate: e.date,
    estimated: Boolean(e.estimated),
    status: e.kind === "error" ? "error" : "ok",   // 'none' is a valid answer, not a fault
    reason: e.reason || null,                      // surfaced in the UI so the cause needs no log dig
  });
});

/* Diagnostic: answers "why is the earnings column empty?" without needing server logs. */
app.get("/earnings/status", async (_req, res) => {
  const entries = [..._earn.entries()];
  res.json({
    source: "yahoo-finance2",
    tokenRequired: false,
    status: entries.some(([, e]) => e.kind === "error") ? "error" : "ok",
    cached: entries.length,
    withDate: entries.filter(([, e]) => e.kind === "ok").length,
    noEarnings: entries.filter(([, e]) => e.kind === "none").length,
    emptyAnswer: entries.filter(([, e]) => e.kind === "empty").map(([s]) => s),  // recheck shortly
    failing: entries.filter(([, e]) => e.kind === "error").map(([s]) => s),
    lastError: _earnLastError,
  });
});

app.get("/history", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "pass ?symbol=COHR" });
    const start = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const j = await tradier("/markets/history", { symbol, interval: "daily", start, end });
    // Full daily OHLC powers the candlestick chart; `closes` stays for the IV/HV stats.
    const bars = arr(j?.history?.day)
      .map(d => ({ date: String(d.date), open: num(d.open), high: num(d.high), low: num(d.low), close: num(d.close) }))
      .filter(b => b.close > 0);
    res.json({ symbol, closes: bars.map(b => b.close), bars });
  } catch (err) { console.error("[/history]", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/", (_req, res) => res.sendFile(path.resolve("csp-dashboard.html")));
app.listen(PORT, () => console.log(`CSP dashboard -> http://localhost:${PORT}  (data: ${TRADIER_BASE}, access codes loaded: ${CODES.size})`));
