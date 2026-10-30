// Refreshes share prices, market values and index moves in data/players.json and data/market.json.
// Runs in GitHub Actions every 15 minutes during US market hours. No API key needed.
// Source: Yahoo Finance's public chart endpoint. Market value = price x shares outstanding (stored per company).
import fs from "node:fs/promises";

const DATA = new URL("../data/", import.meta.url);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const readJson = async f => JSON.parse(await fs.readFile(new URL(f, DATA), "utf8"));
const writeJson = async (f, v) => fs.writeFile(new URL(f, DATA), JSON.stringify(v, null, 1) + "\n");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (x, d = 2) => (x == null || !isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;
const pct = (now, base) => (now && base) ? round((now / base - 1) * 100) : null;

async function chart(symbol){
  let lastErr;
  for (const host of ["query1", "query2"]){
    for (let attempt = 0; attempt < 2; attempt++){
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=ytd&interval=1d&includePrePost=false`;
        const r = await fetch(url, {headers: {"User-Agent": UA, "Accept": "application/json"}, signal: AbortSignal.timeout(20000)});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if (!res?.meta?.regularMarketPrice) throw new Error(j?.chart?.error?.description || "no price");
        return res;
      } catch (e){ lastErr = e; await sleep(800 * (attempt + 1)); }
    }
  }
  throw new Error(`${symbol}: ${lastErr?.message}`);
}

// Turn a year-to-date daily chart into price + day / week / month / YTD changes.
function analyze(res){
  const m = res.meta;
  const off = m.gmtoffset || 0;
  const day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const closes = res.indicators?.quote?.[0]?.close || [];
  const bars = (res.timestamp || []).map((t, i) => ({d: day(t), c: closes[i]})).filter(b => b.c != null);
  const price = m.regularMarketPrice;
  const today = day(m.regularMarketTime);
  const before = d => { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].d < d) return bars[i].c; return null; };
  const t = new Date(today + "T12:00:00Z");
  const monday = new Date(t); monday.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  const monthStart = today.slice(0, 8) + "01";
  return {
    price,
    currency: m.currency,
    time: m.regularMarketTime,
    quoteDay: today,
    chg1d: pct(price, before(today)),
    chg1w: pct(price, before(monday.toISOString().slice(0, 10))),
    chgMonth: pct(price, before(monthStart)),
    chgYtd: pct(price, m.chartPreviousClose)
  };
}

function label(v){
  if (v >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
  if (v >= 1e11) return "$" + Math.round(v / 1e9) + "B";
  return "$" + (v / 1e9).toFixed(1) + "B";
}
function etTime(sec){
  return new Date(sec * 1000).toLocaleString("en-US", {timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) + " ET";
}

const players = await readJson("players.json");
const market = await readJson("market.json");
let fx = null; // JPY per USD, for SoftBank
let updated = 0, failed = [];

for (const p of players.items){
  if (!p.public || !(p.yahoo || p.ticker)) continue;
  const sym = p.yahoo || p.ticker;
  try {
    const q = analyze(await chart(sym));
    let value = null;
    if (p.shares){
      let usdPrice = q.price;
      if (q.currency && q.currency !== "USD"){
        if (q.currency === "JPY"){
          if (!fx) fx = (await chart("JPY=X")).meta.regularMarketPrice;
          usdPrice = q.price / fx;
        } else throw new Error("unsupported currency " + q.currency);
      }
      value = Math.round(p.shares * usdPrice);
    }
    Object.assign(p, {
      price: round(q.price, 2),
      chg1d: q.chg1d, chg1w: q.chg1w, chgYtd: q.chgYtd,
      valueDate: q.quoteDay,
      note: `Quote ${etTime(q.time)}. Market value = price × shares outstanding.` + (q.currency !== "USD" ? ` Converted from ${q.currency}.` : ""),
      source: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
      sourceName: "Yahoo Finance"
    });
    if (value){ p.value = value; p.valueLabel = label(value); p.valueKind = "market cap"; }
    updated++;
  } catch (e){
    failed.push(e.message);
  }
  await sleep(250);
}

try {
  const nq = analyze(await chart("^IXIC"));
  const sp = analyze(await chart("^GSPC"));
  Object.assign(market, {nasdaq1d: nq.chg1d, nasdaqMonth: nq.chgMonth, sp1d: sp.chg1d});
  const src = "https://finance.yahoo.com/quote/%5EIXIC";
  market.sources = [src, ...(market.sources || []).filter(u => u !== src)].slice(0, 6);
} catch (e){ failed.push(e.message); }

const now = new Date().toISOString();
if (updated){
  players.asOf = now;
  market.asOf = now;
  await writeJson("players.json", players);
  await writeJson("market.json", market);
}
console.log(`Updated ${updated} companies.` + (failed.length ? ` Failed: ${failed.join("; ")}` : ""));
if (!updated) { console.log("::warning::No prices updated"); }
