// Refreshes share prices, market values and index moves in data/players.json and data/market.json.
// Runs in GitHub Actions every 15 minutes during US market hours. No API key needed.
// Sources: CNBC's public quote feed (one batched request per run), with Yahoo Finance as a backup.
// Week, month and year-start prices come from daily bars and are cached per company once a day (p.ref).
import fs from "node:fs/promises";

const DATA = new URL("../data/", import.meta.url);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const readJson = async f => JSON.parse(await fs.readFile(new URL(f, DATA), "utf8"));
const writeJson = async (f, v) => fs.writeFile(new URL(f, DATA), JSON.stringify(v, null, 1) + "\n");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (x, d = 2) => (x == null || !isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;
const pct = (now, base) => (now && base) ? round((now / base - 1) * 100) : null;
const toNum = v => { if (typeof v === "number") return v; if (typeof v !== "string") return null; const n = parseFloat(v.replace(/[,%+]/g, "")); return isFinite(n) ? n : null; };
const errors = [];

// Our symbols -> CNBC symbols
const CNBC = {"^IXIC": ".IXIC", "^GSPC": ".SPX", "JPY=X": "JPY=", "9984.T": "9984-JP"};
const cnbcSym = s => CNBC[s] || s;

async function getJson(url, headers = {}){
  const r = await fetch(url, {headers: {"User-Agent": UA, "Accept": "application/json", ...headers}, signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------- dates (US Eastern) ---------- */
const etDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"}).format(d);
function refDays(today){
  const t = new Date(today + "T12:00:00Z");
  const monday = new Date(t); monday.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return {week: monday.toISOString().slice(0, 10), month: today.slice(0, 8) + "01", year: today.slice(0, 5) + "01-01"};
}
// last close strictly before each reference day
function basesFrom(bars, today){
  const R = refDays(today), out = {day: today};
  for (const k of ["week", "month", "year"]){
    let c = null; for (const b of bars) if (b.d < R[k]) c = b.c; out[k] = c;
  }
  return out;
}

/* ---------- CNBC ---------- */
async function cnbcQuotes(symbols){
  const url = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" +
    encodeURIComponent(symbols.map(cnbcSym).join("|")) + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1";
  const j = await getJson(url);
  let list = j?.FormattedQuoteResult?.FormattedQuote || [];
  if (!Array.isArray(list)) list = [list];
  const map = {};
  for (const sym of symbols){
    const q = list.find(x => x && (x.symbol === cnbcSym(sym) || x.altSymbol === cnbcSym(sym)));
    if (!q || toNum(q.last) == null) continue;
    const fd = q.FundamentalData || {};
    map[sym] = {
      price: toNum(q.last),
      prevClose: toNum(q.previous_day_closing),
      chgPct: toNum(q.change_pct),
      currency: q.currencyCode || "USD",
      time: q.last_time || "",
      mktcap: toNum(fd.mktcap)
    };
  }
  return map;
}
async function cnbcBars(sym, today){
  const y = Number(today.slice(0, 4));
  const end = today.replace(/-/g, "") + "235959";
  const url = `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(cnbcSym(sym))}/1D/${y - 1}1215000000/${end}/adjusted/EST5EDT.json`;
  const j = await getJson(url);
  const bars = (j?.barData?.priceBars || []).map(b => {
    const t = String(b.tradeTime || "");
    return {d: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`, c: toNum(b.close)};
  }).filter(b => b.c != null && /^\d{4}-\d{2}-\d{2}$/.test(b.d)).sort((a, b) => a.d < b.d ? -1 : 1);
  if (!bars.length) throw new Error("no bars");
  return bars;
}

/* ---------- Yahoo (backup) ---------- */
async function yahoo(sym){
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=ytd&interval=1d`);
  const res = j?.chart?.result?.[0];
  const m = res?.meta; if (!m?.regularMarketPrice) throw new Error("no price");
  const off = m.gmtoffset || 0, day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const closes = res.indicators?.quote?.[0]?.close || [];
  const bars = (res.timestamp || []).map((t, i) => ({d: day(t), c: closes[i]})).filter(b => b.c != null);
  const today = day(m.regularMarketTime);
  let prev = null; for (const b of bars) if (b.d < today) prev = b.c;
  const bases = basesFrom(bars, today); bases.year = m.chartPreviousClose || bases.year;
  return {price: m.regularMarketPrice, prevClose: prev, currency: m.currency || "USD", time: new Date(m.regularMarketTime * 1000).toISOString(), today, bases};
}

/* ---------- run ---------- */
const players = await readJson("players.json");
const market = await readJson("market.json");
const today = etDate();
const tracked = players.items.filter(p => p.public && (p.yahoo || p.ticker));
const symOf = p => p.yahoo || p.ticker;
const symbols = [...tracked.map(symOf), "^IXIC", "^GSPC", "JPY=X"];

let quotes = {}, source = "CNBC";
try { quotes = await cnbcQuotes(symbols); } catch (e){ errors.push("CNBC quotes: " + e.message); }
if (Object.keys(quotes).length < tracked.length / 2){
  // CNBC unavailable: fall back to Yahoo one symbol at a time
  source = "Yahoo Finance";
  for (const s of symbols){
    try { const y = await yahoo(s); quotes[s] = y; } catch (e){ errors.push(`Yahoo ${s}: ${e.message}`); if (/429/.test(e.message)) break; }
    await sleep(300);
  }
}

// week / month / year-start closes, refreshed once per day per symbol
const refs = market.refs || (market.refs = {});
async function basesFor(sym){
  const q = quotes[sym];
  if (q?.bases) return q.bases;
  if (refs[sym]?.day === today) return refs[sym];
  try { refs[sym] = basesFrom(await cnbcBars(sym, today), today); }
  catch (e){ errors.push(`bars ${sym}: ${e.message}`); }
  await sleep(150);
  return refs[sym] || {};
}

const fx = quotes["JPY=X"]?.price || null; // yen per dollar
let updated = 0;
for (const p of tracked){
  const sym = symOf(p), q = quotes[sym];
  if (!q){ errors.push(`${sym}: no quote`); continue; }
  const b = await basesFor(sym);
  const usd = q.currency === "USD" ? 1 : (q.currency === "JPY" && fx ? 1 / fx : null);
  if (usd == null){ errors.push(`${sym}: no FX for ${q.currency}`); continue; }
  let value = q.mktcap ? q.mktcap * usd : (p.shares ? p.shares * q.price * usd : null);
  // sanity check against the last value: ignore a market cap that moved more than 40% in one step
  if (value && p.value && Math.abs(value / p.value - 1) > 0.4 && p.shares) value = p.shares * q.price * usd;
  Object.assign(p, {
    price: round(q.price, 2),
    chg1d: q.prevClose ? pct(q.price, q.prevClose) : (q.chgPct ?? null),
    chg1w: pct(q.price, b.week),
    chgYtd: pct(q.price, b.year),
    valueDate: today,
    note: `Quote ${q.time ? new Date(q.time).toLocaleString("en-US", {timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) + " ET" : "today"} from ${source}.`,
    source: source === "CNBC" ? `https://www.cnbc.com/quotes/${encodeURIComponent(cnbcSym(sym))}` : `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
    sourceName: source
  });
  if (value){
    p.value = Math.round(value);
    p.valueLabel = value >= 1e12 ? "$" + (value / 1e12).toFixed(2) + "T" : value >= 1e11 ? "$" + Math.round(value / 1e9) + "B" : "$" + (value / 1e9).toFixed(1) + "B";
    p.valueKind = "market cap";
  }
  updated++;
}

for (const [sym, key1d, keyM] of [["^IXIC", "nasdaq1d", "nasdaqMonth"], ["^GSPC", "sp1d", null]]){
  const q = quotes[sym]; if (!q) continue;
  market[key1d] = q.prevClose ? pct(q.price, q.prevClose) : (q.chgPct ?? null);
  if (keyM){ const b = await basesFor(sym); market[keyM] = pct(q.price, b.month); }
}

const now = new Date().toISOString();
if (updated){
  players.asOf = now;
  market.asOf = now;
  await writeJson("players.json", players);
}
await writeJson("market.json", market);
console.log(`Updated ${updated}/${tracked.length} companies from ${source}.` + (errors.length ? ` Problems: ${errors.join("; ")}` : ""));
if (errors.length) console.log(`::warning::Price problems (${errors.length}): ${errors.slice(0, 5).join(" | ").replace(/[\r\n]+/g, " ").slice(0, 700)}`);
if (!updated){ console.log("::warning::No prices updated"); }
