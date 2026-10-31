// Builds data/model.json for the "What's next" simulation page.
// Runs in GitHub Actions once a day after the US close (and on demand).
//
// 1. Daily closes since 2012 for every public US-listed company on the map, plus the Nasdaq-100 (CNBC public bars).
//    Raw closes are cached in model-src/closes.json so later runs only fetch recent days.
// 2. An "AI basket": the map companies weighted by today's market value.
// 3. A GJR-GARCH(1,1) volatility model per series (fit by maximum likelihood). Its standardized residuals are what the
//    browser simulation replays ("filtered historical simulation"): whole historical days are resampled, so fat tails and
//    cross-company co-movement come from real data, while today's volatility level comes from the model.
// 4. An event study: every day since 2012 the basket fell 3%+ and what followed.
// 5. A calibration backtest: how often real outcomes landed inside the model's ranges.
import fs from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const START_YEAR = 2012;
const DRIFT_YEAR = 0.08;            // assumed long-run market return; each stock gets beta x this (no hot-hand extrapolation)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = m => console.log(`::warning::${String(m).slice(0, 800)}`);

const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(new URL(p, ROOT), "utf8")); } catch { return d; } };
const writeJson = async (p, v, pretty) => { await fs.mkdir(new URL(p.replace(/[^/]+$/, ""), ROOT), {recursive: true}); await fs.writeFile(new URL(p, ROOT), (pretty ? JSON.stringify(v, null, 1) : JSON.stringify(v)) + "\n"); };

/* ---------- fetch daily closes (CNBC) ---------- */
const CNBC = {"^NDX": ".NDX"};
const toNum = v => { const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")); return isFinite(n) ? n : null; };
async function bars(sym, from, to){
  const url = `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(CNBC[sym] || sym)}/1D/${from}000000/${to}235959/adjusted/EST5EDT.json`;
  for (let a = 0; a < 3; a++){
    try {
      const r = await fetch(url, {headers: {"User-Agent": UA, Accept: "application/json"}, signal: AbortSignal.timeout(30000)});
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const out = {};
      for (const b of j?.barData?.priceBars || []){
        const t = String(b.tradeTime || ""); const c = toNum(b.close);
        if (t.length >= 8 && c) out[`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`] = c;
      }
      return out;
    } catch (e){ if (a === 2) throw new Error(`${sym} ${from}: ${e.message}`); await sleep(1000 * (a + 1)); }
  }
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
async function history(sym, cached){
  const out = {...(cached || {})};
  const have = Object.keys(out).sort();
  const today = new Date();
  if (have.length > 500){
    // refresh only the last ~20 days
    const from = new Date(have[have.length - 1] + "T00:00:00Z"); from.setUTCDate(from.getUTCDate() - 20);
    Object.assign(out, await bars(sym, ymd(from), ymd(today)));
    return out;
  }
  for (let y = START_YEAR; y <= today.getUTCFullYear(); y++){
    try { Object.assign(out, await bars(sym, `${y}0101`, `${y}1231`)); } catch (e){ log("  " + e.message); }
    await sleep(120);
  }
  return out;
}

/* ---------- math helpers ---------- */
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const variance = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const quantile = (sorted, q) => { if (!sorted.length) return null; const p = (sorted.length - 1) * q, i = Math.floor(p), f = p - i; return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * f; };
const r4 = x => x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4;
const sig = x => 1 / (1 + Math.exp(-x));

function nelderMead(f, x0, iters = 500){
  const n = x0.length; let pts = [x0];
  for (let i = 0; i < n; i++){ const p = x0.slice(); p[i] += 0.6; pts.push(p); }
  let vals = pts.map(f);
  for (let k = 0; k < iters; k++){
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = idx.map(i => pts[i]); vals = idx.map(i => vals[i]);
    const c = Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const w = pts[n], refl = c.map((x, j) => x + (x - w[j])), fr = f(refl);
    if (fr < vals[0]){ const exp = c.map((x, j) => x + 2 * (x - w[j])), fe = f(exp); if (fe < fr){ pts[n] = exp; vals[n] = fe; } else { pts[n] = refl; vals[n] = fr; } }
    else if (fr < vals[n - 1]){ pts[n] = refl; vals[n] = fr; }
    else { const con = c.map((x, j) => x + 0.5 * (w[j] - x)), fc = f(con);
      if (fc < vals[n]){ pts[n] = con; vals[n] = fc; }
      else { for (let i = 1; i <= n; i++){ pts[i] = pts[i].map((x, j) => pts[0][j] + 0.5 * (x - pts[0][j])); vals[i] = f(pts[i]); } } }
    if (Math.abs(vals[n] - vals[0]) < 1e-9) break;
  }
  return pts[0];
}

// GJR-GARCH(1,1), Gaussian quasi-maximum likelihood, variance targeting.
function fitGarch(ret){
  const mu = mean(ret), e = ret.map(x => x - mu), v = variance(ret);
  const unpack = th => { const alpha = 0.25 * sig(th[0]), gamma = 0.35 * sig(th[1]), beta = 0.995 * sig(th[2]); return {alpha, gamma, beta}; };
  const nll = th => {
    const {alpha, gamma, beta} = unpack(th), p = alpha + gamma / 2 + beta;
    if (p >= 0.998) return 1e12;
    const omega = v * (1 - p); let s2 = v, L = 0;
    for (let t = 0; t < e.length; t++){
      L += Math.log(s2) + e[t] * e[t] / s2;
      s2 = omega + (alpha + (e[t] < 0 ? gamma : 0)) * e[t] * e[t] + beta * s2;
      if (!(s2 > 1e-12)) return 1e12;
    }
    return 0.5 * L;
  };
  const th = nelderMead(nll, [-1.5, -1.0, 2.2], 600);
  const {alpha, gamma, beta} = unpack(th), omega = v * (1 - alpha - gamma / 2 - beta);
  return {mu, omega, alpha, gamma, beta, v};
}
function filterGarch(ret, g){
  const s = [], z = []; let s2 = g.v;
  for (let t = 0; t < ret.length; t++){
    s.push(Math.sqrt(s2)); const e = ret[t] - g.mu; z.push(e / Math.sqrt(s2));
    s2 = g.omega + (g.alpha + (e < 0 ? g.gamma : 0)) * e * e + g.beta * s2;
  }
  return {s, z, next: Math.sqrt(s2)};
}
function ewma(ret, lambda = 0.94){
  // remove the sample's average so a short hot streak doesn't become a built-in trend
  let s2 = variance(ret.slice(0, Math.min(ret.length, 60))) || 4e-4; const s = [], z = []; const m = mean(ret);
  for (const r of ret){ s.push(Math.sqrt(s2)); z.push((r - m) / Math.sqrt(s2)); s2 = lambda * s2 + (1 - lambda) * r * r; }
  return {s, z, next: Math.sqrt(s2)};
}

/* ---------- run ---------- */
const players = await readJson("data/players.json", {items: []});
const assetsIn = players.items.filter(p => p.public && p.ticker && !/\.\w+$/.test(p.ticker) && p.value); // US-listed only
const symbols = [...assetsIn.map(p => p.ticker), "^NDX"];
const cache = await readJson("model-src/closes.json", {});
log(`Fetching daily closes for ${symbols.length} series…`);
for (const s of symbols){
  try { cache[s] = await history(s, cache[s]); log(`  ${s}: ${Object.keys(cache[s]).length} days`); }
  catch (e){ warn(`history ${s}: ${e.message}`); }
}
await writeJson("model-src/closes.json", cache);

const ndx = cache["^NDX"] || {};
const dates = Object.keys(ndx).sort().filter(d => d >= `${START_YEAR}-01-01`);
if (dates.length < 1000) { warn(`Only ${dates.length} Nasdaq-100 days; model not built.`); process.exit(0); }
const T = dates.length - 1; // number of return days
// companies whose older price history belongs to a different business
const SINCE = {NBIS: "2024-10-21"};
const retOf = (closes, from) => { const out = new Array(T).fill(null); for (let t = 1; t <= T; t++){ if (from && dates[t - 1] < from) continue; const a = closes?.[dates[t - 1]], b = closes?.[dates[t]]; if (a && b) out[t - 1] = Math.log(b / a); } return out; };

const assets = assetsIn.map(p => ({id: p.id, name: p.name, sym: p.ticker, value: p.value, ret: retOf(cache[p.ticker], SINCE[p.ticker])}))
  .filter(a => a.ret.filter(x => x != null).length >= 40);
const ndxRet = retOf(ndx);

// AI basket: today's market values as fixed weights, renormalized over the companies that traded each day
const basketRet = new Array(T).fill(null);
for (let t = 0; t < T; t++){
  let w = 0, s = 0;
  for (const a of assets){ const r = a.ret[t]; if (r != null){ w += a.value; s += a.value * (Math.exp(r) - 1); } }
  if (w > 0) basketRet[t] = Math.log(1 + s / w);
}

// volatility models
function model(ret){
  const idx = ret.map((r, t) => r == null ? -1 : t).filter(t => t >= 0);
  const r = idx.map(t => ret[t]);
  let fit = null, f;
  if (r.length >= 750){ fit = fitGarch(r); f = filterGarch(r, fit); }
  else f = ewma(r);
  const z = new Array(T).fill(null), s = new Array(T).fill(null);
  idx.forEach((t, k) => { z[t] = f.z[k]; s[t] = f.s[k]; });
  return {fit, z, s, next: f.next, n: r.length};
}
const mB = model(basketRet), mN = model(ndxRet);
const driftDay = Math.log(1 + DRIFT_YEAR) / 252;
for (const a of assets){
  Object.assign(a, model(a.ret));
  // beta / correlation to the basket over the last ~2 years
  const pairs = []; for (let t = Math.max(0, T - 504); t < T; t++) if (a.ret[t] != null && basketRet[t] != null) pairs.push([a.ret[t], basketRet[t]]);
  const mx = mean(pairs.map(p => p[0])), my = mean(pairs.map(p => p[1]));
  let cxy = 0, vx = 0, vy = 0; for (const [x, y] of pairs){ cxy += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
  a.beta = cxy / vy; a.rho = cxy / Math.sqrt(vx * vy);
  a.mu = a.beta * driftDay;
}

/* ---------- yesterday ---------- */
const last = T - 1;
const lastDate = dates[T];
const capNow = assets.reduce((s, a) => s + a.value, 0);
const lastMoveUSD = assets.reduce((s, a) => s + (a.ret[last] != null ? a.value - a.value / Math.exp(a.ret[last]) : 0), 0);
const lastBasketPct = (Math.exp(basketRet[last]) - 1) * 100;
const worseDays = basketRet.filter(r => r != null && r <= basketRet[last]).length;

/* ---------- event study: big down days for the basket ---------- */
const LABELS = {
  "2015-08-24": "China selloff", "2016-06-24": "Brexit vote", "2018-02-05": "Volatility spike",
  "2018-10-24": "Q4 2018 selloff", "2020-03-09": "COVID crash", "2020-03-12": "COVID crash", "2020-03-16": "COVID crash",
  "2020-09-03": "Tech pullback", "2022-09-13": "Hot inflation report", "2024-08-05": "Yen carry-trade unwind",
  "2025-01-27": "DeepSeek shock", "2025-04-03": "Tariff shock", "2025-04-04": "Tariff shock"
};
function eventsOf(series, thresholdPct, zs){
  const cumFwd = (t, h) => { let s = 0; for (let k = 1; k <= h; k++){ const r = series[t + k]; if (r == null) return null; s += r; } return (Math.exp(s) - 1) * 100; };
  // after a drop, did the series get back to where it was the day before?
  const recovered = (t, h) => { let s = 0; for (let k = 1; k <= h; k++){ const r = series[t + k]; if (r == null) return null; s += r; if (s >= -series[t]) return true; } return false; };
  const out = []; let lastEvent = -99;
  for (let t = 0; t < T; t++){
    const r = series[t]; if (r == null) continue;
    const pct = (Math.exp(r) - 1) * 100;
    if (pct > thresholdPct) continue;
    const first = t - lastEvent > 5; // first big drop in a week starts a new episode
    lastEvent = t;
    out.push({date: dates[t + 1], pct: r4(pct), z: r4(zs[t]), first, ndx: ndxRet[t] != null ? r4((Math.exp(ndxRet[t]) - 1) * 100) : null,
      d1: r4(cumFwd(t, 1)), d5: r4(cumFwd(t, 5)), d21: r4(cumFwd(t, 21)), d63: r4(cumFwd(t, 63)),
      rec5: recovered(t, 5), rec21: recovered(t, 21), rec63: recovered(t, 63), label: LABELS[dates[t + 1]] || null});
  }
  return out;
}
const events = eventsOf(basketRet, -3, mB.z);
const ndxEvents = eventsOf(ndxRet, -3, mN.z);
function summarize(list){
  const out = {n: list.length};
  for (const h of ["d1", "d5", "d21", "d63"]){
    const xs = list.map(e => e[h]).filter(x => x != null).sort((a, b) => a - b);
    out[h] = xs.length ? {n: xs.length, up: r4(xs.filter(x => x > 0).length / xs.length), med: r4(quantile(xs, 0.5)), p10: r4(quantile(xs, 0.1)), p90: r4(quantile(xs, 0.9))} : null;
  }
  for (const h of ["rec5", "rec21", "rec63"]){ const xs = list.map(e => e[h]).filter(x => x != null); out[h] = xs.length ? r4(xs.filter(Boolean).length / xs.length) : null; }
  return out;
}
const episodes = events.filter(e => e.first && e.date !== lastDate);
const ndxEpisodes = ndxEvents.filter(e => e.first && e.date !== lastDate);
const study = {
  // the Nasdaq-100 changes members over time, so it isn't only today's winners (less hindsight bias)
  ndx3: summarize(ndxEpisodes),
  // follow-on drops: a 3%+ drop within a week of another one, like Friday after Thursday
  cluster: summarize(events.filter(e => !e.first && e.date !== lastDate)),
  drop3: summarize(episodes),
  drop4: summarize(episodes.filter(e => e.pct <= -4)),
  // closest analogs in size to a ~4% day
  similar: summarize(episodes.filter(e => e.pct <= -3.5 && e.pct >= -5.5))
};

/* ---------- calibration backtest (basket, 1 month) ---------- */
function backtest(starts, H = 21, N = 2000){
  let in90 = 0, in50 = 0, n = 0, above = 0, below = 0;
  const g = mB.fit; if (!g) return null;
  const zs = mB.z;
  for (const t0 of starts){
    if (t0 + H >= T || t0 < 500) continue;
    const pool = []; for (let t = 0; t <= t0; t++) if (zs[t] != null) pool.push(zs[t]);
    let realized = 0, ok = true; for (let k = 1; k <= H; k++){ const r = basketRet[t0 + k]; if (r == null){ ok = false; break; } realized += r; }
    if (!ok || mB.s[t0] == null) continue;
    // variance for the next day after t0
    const e0 = basketRet[t0] - g.mu; let s2start = g.omega + (g.alpha + (e0 < 0 ? g.gamma : 0)) * e0 * e0 + g.beta * mB.s[t0] ** 2;
    const sims = new Float64Array(N);
    for (let p = 0; p < N; p++){
      let s2 = s2start, c = 0;
      for (let k = 0; k < H; k++){ const z = pool[(Math.random() * pool.length) | 0]; const e = Math.sqrt(s2) * z; c += driftDay + e; s2 = g.omega + (g.alpha + (e < 0 ? g.gamma : 0)) * e * e + g.beta * s2; }
      sims[p] = c;
    }
    sims.sort();
    const q = x => sims[Math.min(N - 1, Math.max(0, Math.round(x * (N - 1))))];
    if (realized >= q(0.05) && realized <= q(0.95)) in90++; else if (realized > q(0.95)) above++; else below++;
    if (realized >= q(0.25) && realized <= q(0.75)) in50++;
    n++;
  }
  return n ? {n, in90: r4(in90 / n), in50: r4(in50 / n), above: r4(above / n), below: r4(below / n)} : null;
}
const monthStarts = []; for (let t = 750; t < T - 21; t += 21) monthStarts.push(t);
const shockStarts = events.filter(e => e.first).map(e => dates.indexOf(e.date) - 1).filter(t => t > 750);
const calib = {monthly: backtest(monthStarts), afterDrops: backtest(shockStarts), since: dates[751]};

/* ---------- write ---------- */
const enc = arr => arr.map(z => z == null ? null : Math.round(z * 100));
const out = {
  asOf: new Date().toISOString(), lastDate, start: dates[1], days: T, driftYear: DRIFT_YEAR,
  yesterday: {date: lastDate, basketPct: r4(lastBasketPct), usd: Math.round(lastMoveUSD), rank: worseDays, ndxPct: r4((Math.exp(ndxRet[last]) - 1) * 100), capNow: Math.round(capNow)},
  basket: {fit: mB.fit, sigma: r4(mB.next), z: enc(mB.z)},
  ndx: {fit: mN.fit, sigma: r4(mN.next), z: enc(mN.z)},
  assets: assets.map(a => ({id: a.id, name: a.name, sym: a.sym, value: a.value, n: a.n, beta: r4(a.beta), rho: r4(a.rho), mu: a.mu,
    fit: a.fit ? {omega: a.fit.omega, alpha: r4(a.fit.alpha), gamma: r4(a.fit.gamma), beta: r4(a.fit.beta)} : null,
    sigma: r4(a.next), lastRet: r4(a.ret[last]), z: enc(a.z)})),
  study, events: events.slice().reverse(), calib,
  dates: [dates[1], lastDate]
};
await writeJson("data/model.json", out);
log(`Model built through ${lastDate}: ${assets.length} companies, ${T} days. Yesterday ${lastBasketPct.toFixed(2)}% (${(lastMoveUSD / 1e9).toFixed(0)}B), worse days: ${worseDays}. Events: ${events.length}. Calibration: ${JSON.stringify(calib)}`);
log(`::notice::Model through ${lastDate}: basket ${lastBasketPct.toFixed(2)}% ($${(lastMoveUSD / 1e9).toFixed(0)}B); ${episodes.length} past 3%+ drop episodes; 90% band hit rate ${calib.monthly?.in90}, after drops ${calib.afterDrops?.in90}`);
