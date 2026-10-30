// Asks Claude (via the Claude API, with web search) what changed in AI money since the last refresh,
// then merges the answer into data/events.json, data/flows.json, data/players.json and data/market.json.
// Needs the ANTHROPIC_API_KEY repository secret. Optional repository variables:
//   CLAUDE_MODEL     (default claude-sonnet-5-5)
//   WEB_SEARCH_TOOL  (default web_search_20250305)
//   MAX_SEARCHES     (default 15)
import fs from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY){
  console.log("::warning::ANTHROPIC_API_KEY secret is not set, so the Claude refresh was skipped. Prices still update.");
  process.exit(0);
}
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
let TOOL = process.env.WEB_SEARCH_TOOL || "web_search_20250305";
// Show any crash as an annotation on the run summary, not only in the log
const fail = e => { console.log(`::error::Claude refresh failed: ${String(e?.message || e).replace(/[\r\n]+/g, " ").slice(0, 900)}`); process.exit(1); };
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 15);

const DATA = new URL("../data/", import.meta.url);
const readJson = async f => JSON.parse(await fs.readFile(new URL(f, DATA), "utf8"));
const writeJson = async (f, v) => fs.writeFile(new URL(f, DATA), JSON.stringify(v, null, 1) + "\n");

const players = await readJson("players.json");
const flows = await readJson("flows.json");
const events = await readJson("events.json");
const market = await readJson("market.json");

const KINDS = ["earnings", "deal", "debt", "ipo", "market", "news"];
const DIRS = ["up", "down", "neutral"];
const TYPES = ["hardware", "services", "investment", "venture", "debt"];
const STATUSES = ["announced", "active", "done", "scaled back", "in doubt"];
const GROUPS = ["chips", "cloud", "neo", "lab", "startup", "money"];

const fmtB = v => v == null ? "undisclosed" : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${Math.round(v / 1e9)}B`;
const nowET = new Date().toLocaleString("en-US", {timeZone: "America/New_York", weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});

const system = `You maintain the data behind "AI Money Map", a phone app that shows how money moves between AI companies: investments, chip and cloud contracts, and debt. Use web search to find what changed since the last refresh, then reply with ONLY a JSON object (no prose before or after it) describing the changes.

Look for, since the last refresh: earnings; funding rounds and new valuations; chip, cloud and data-center contracts; bond sales, loans and private credit; IPO filings, pricings and first trades; big stock moves (5%+ for a company on the map, or a big Nasdaq day); credit stress; changes to existing deals (expanded, cut, cancelled, closed).

JSON shape:
{
  "headline": "12 plain words or fewer on today's AI-money mood, or null",
  "newEvents": [{"id": "short-kebab-id", "date": "YYYY-MM-DDTHH:MM-04:00 or YYYY-MM-DD", "title": "12 plain words or fewer", "what": "one plain sentence, 25 words or fewer, on what it means for the money flow", "players": ["ids"], "kind": "earnings|deal|debt|ipo|market|news", "dir": "up|down|neutral", "amount": number_or_null, "amountLabel": "short, e.g. '$25B bond' or '-$482B value'", "source": "URL", "sourceName": "outlet"}],
  "newFlows": [{"id": "short-kebab-id", "from": "id", "to": "id", "type": "hardware|services|investment|venture|debt", "amount": number_or_null, "amountLabel": "e.g. 'up to $40B'", "title": "12 words or fewer", "date": "YYYY-MM-DD announced", "status": "announced|active|done|scaled back|in doubt", "update": "one plain sentence on the latest status", "updated": "YYYY-MM-DD", "source": "URL", "sourceName": "outlet"}],
  "flowUpdates": [{"id": "existing deal id", "status": "...", "update": "...", "updated": "YYYY-MM-DD", "amount": number_or_null, "amountLabel": "...", "source": "URL", "sourceName": "outlet"}],
  "playerUpdates": [{"id": "existing id", "value": number, "valueLabel": "$965B", "valueKind": "private valuation|market cap", "valueDate": "YYYY-MM-DD", "prevValue": number, "prevValueDate": "YYYY-MM-DD", "public": true, "ticker": "ANT", "shares": number, "note": "...", "source": "URL", "sourceName": "outlet", "blurb": "one plain line"}],
  "newPlayers": [{"id": "short-id", "name": "...", "ticker": "or null", "public": false, "value": number, "valueLabel": "...", "valueKind": "...", "valueDate": "YYYY-MM-DD", "shares": number_or_null, "group": "chips|cloud|neo|lab|startup|money", "blurb": "one plain line", "note": "...", "source": "URL", "sourceName": "outlet"}]
}
Only include the fields you are changing in flowUpdates and playerUpdates (plus id). Amounts are plain US dollar numbers (25000000000, not "25B").

Rules:
- Use only facts and numbers from pages you found with web search in this session. Never fill in numbers from memory. If you aren't sure, leave it out.
- Every new event and deal needs a real source URL from your searches. Prefer company releases, Reuters, Bloomberg, CNBC, WSJ, FT, AP and Yahoo Finance.
- Write titles and "what" lines in your own words: plain English, no jargon, never copied sentences.
- Deal direction: "from" pays, "to" receives (customer to supplier, investor to company, lender to borrower). Bond buyers, banks and private-credit funds all use the single id "lenders".
- Don't repeat stories already in the feed or deals already on the map. To change an existing deal, use flowUpdates with its id.
- Share prices for public companies are updated by another script: don't send price or daily-change updates. Use playerUpdates only for private-company valuations (new funding round, acquisition), an IPO (set public true, ticker and shares outstanding), or fixing a wrong fact.
- Add a company with newPlayers only if it enters a $10B+ deal with a company already on the map.
- Use the US Eastern offset that applies on that date (-04:00 before Nov 1 2026, -05:00 from then until March 2027).
- If nothing meaningful changed, return empty arrays and headline null.`;

const user = `Current time: ${nowET} (US Eastern).
Last refresh: ${events.asOf || "unknown"}.

Companies on the map (id: name, ticker, public or private, value):
${players.items.map(p => `${p.id}: ${p.name}, ${p.ticker || "no ticker"}, ${p.public ? "public" : "private"}, ${fmtB(p.value)}`).join("\n")}

Deals on the map (id: from -> to, type, amount, status):
${flows.items.map(f => `${f.id}: ${f.from} -> ${f.to}, ${f.type}, ${f.amountLabel || fmtB(f.amount)}, ${f.status}`).join("\n")}

Stories already in the feed (date: title):
${events.items.slice(0, 40).map(e => `${e.date}: ${e.title}`).join("\n")}

Search for what's new since the last refresh and reply with the JSON object.`;

async function call(messages, withTools = true){
  const body = {model: MODEL, max_tokens: 16000, system, messages};
  if (withTools) body.tools = [{type: TOOL, name: "web_search", max_uses: MAX_SEARCHES}];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok){
    const msg = JSON.stringify(j.error || j);
    // If this web search tool version isn't accepted, retry with the newest version the API lists
    const offered = [...new Set(msg.match(/web_search_\d{8}/g) || [])].filter(t => t !== TOOL).sort();
    if (withTools && r.status === 400 && offered.length){
      console.log(`Web search tool ${TOOL} rejected; retrying with ${offered[offered.length - 1]}`);
      TOOL = offered[offered.length - 1];
      return call(messages, withTools);
    }
    throw new Error(`Claude API ${r.status}: ${msg.slice(0, 700)}`);
  }
  return j;
}
const textOf = resp => (resp.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
function parseJson(text){
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

let messages = [{role: "user", content: user}];
let resp;
for (let i = 0; i < 6; i++){
  resp = await call(messages);
  if (resp.stop_reason !== "pause_turn") break;
  messages = [...messages, {role: "assistant", content: resp.content}];
}
const searches = resp?.usage?.server_tool_use?.web_search_requests;
let out;
try {
  out = parseJson(textOf(resp));
} catch {
  const fix = await call([...messages, {role: "assistant", content: resp.content}, {role: "user", content: "Reply with only the JSON object, nothing else."}], false);
  out = parseJson(textOf(fix));
}

/* ---------- validate and merge ---------- */
const isUrl = u => typeof u === "string" && /^https?:\/\/\S+$/i.test(u);
const isDay = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isWhen = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z))?$/.test(d);
const str = (v, n = 400) => typeof v === "string" ? v.trim().slice(0, n) : "";
const num = v => typeof v === "number" && isFinite(v) ? v : null;
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const log = [];

// new companies first, so events and deals can reference them
const ids = new Set(players.items.map(p => p.id));
for (const p of Array.isArray(out.newPlayers) ? out.newPlayers : []){
  const id = slug(p.id);
  if (!id || ids.has(id) || !str(p.name) || !GROUPS.includes(p.group) || !num(p.value) || !isUrl(p.source)) continue;
  const ticker = str(p.ticker, 12) || null;
  players.items.push({id, name: str(p.name, 40), ticker, yahoo: ticker, public: !!p.public && !!ticker, value: num(p.value), valueLabel: str(p.valueLabel, 12), valueKind: str(p.valueKind, 30), valueDate: isDay(p.valueDate) ? p.valueDate : "", price: null, chg1d: null, chg1w: null, chgYtd: null, prevValue: null, prevValueDate: null, shares: num(p.shares), group: p.group, blurb: str(p.blurb, 120), note: str(p.note), source: p.source, sourceName: str(p.sourceName, 60)});
  ids.add(id); log.push(`new company ${id}`);
}

const PLAYER_KEYS = ["value", "valueLabel", "valueKind", "valueDate", "prevValue", "prevValueDate", "public", "ticker", "shares", "note", "source", "sourceName", "blurb"];
for (const u of Array.isArray(out.playerUpdates) ? out.playerUpdates : []){
  const p = players.items.find(x => x.id === u.id); if (!p) continue;
  for (const k of PLAYER_KEYS){
    if (!(k in u)) continue;
    const v = u[k];
    if (["value", "prevValue", "shares"].includes(k)){ if (num(v)) p[k] = v; }
    else if (["valueDate", "prevValueDate"].includes(k)){ if (isDay(v)) p[k] = v; }
    else if (k === "source"){ if (isUrl(v)) p[k] = v; }
    else if (k === "public"){ if (v === true && (u.ticker || p.ticker)) p.public = true; }
    else if (k === "ticker"){ if (str(v, 12)){ p.ticker = str(v, 12); p.yahoo = p.ticker; } }
    else p[k] = str(v);
  }
  log.push(`updated company ${p.id}`);
}

const flowIds = new Set(flows.items.map(f => f.id));
for (const f of Array.isArray(out.newFlows) ? out.newFlows : []){
  const id = slug(f.id);
  if (!id || flowIds.has(id) || !ids.has(f.from) || !ids.has(f.to) || f.from === f.to || !TYPES.includes(f.type) || !str(f.title) || !isUrl(f.source)) continue;
  flows.items.push({id, from: f.from, to: f.to, type: f.type, amount: num(f.amount), amountLabel: str(f.amountLabel, 60) || "undisclosed", title: str(f.title, 120), date: isDay(f.date) ? f.date : new Date().toISOString().slice(0, 10), status: STATUSES.includes(f.status) ? f.status : "announced", update: str(f.update), updated: isDay(f.updated) ? f.updated : "", source: f.source, sourceName: str(f.sourceName, 60)});
  flowIds.add(id); log.push(`new deal ${id}`);
}
for (const u of Array.isArray(out.flowUpdates) ? out.flowUpdates : []){
  const f = flows.items.find(x => x.id === u.id); if (!f) continue;
  if (STATUSES.includes(u.status)) f.status = u.status;
  if (str(u.update)) f.update = str(u.update);
  if (isDay(u.updated)) f.updated = u.updated;
  if ("amount" in u && (num(u.amount) || u.amount === null)) f.amount = u.amount;
  if (str(u.amountLabel)) f.amountLabel = str(u.amountLabel, 60);
  if (isUrl(u.source)){ f.source = u.source; f.sourceName = str(u.sourceName, 60) || f.sourceName; }
  log.push(`updated deal ${f.id}`);
}

const eventIds = new Set(events.items.map(e => e.id));
const titles = new Set(events.items.map(e => norm(e.title)));
let added = 0;
for (const e of Array.isArray(out.newEvents) ? out.newEvents : []){
  let id = slug(e.id);
  if (!id || !str(e.title) || !isWhen(e.date) || !isUrl(e.source) || titles.has(norm(e.title))) continue;
  while (eventIds.has(id)) id += "-2";
  events.items.push({id, date: e.date, title: str(e.title, 120), what: str(e.what, 240), players: (Array.isArray(e.players) ? e.players : []).filter(x => ids.has(x)), kind: KINDS.includes(e.kind) ? e.kind : "news", dir: DIRS.includes(e.dir) ? e.dir : "neutral", amount: num(e.amount), amountLabel: str(e.amountLabel, 60), source: e.source, sourceName: str(e.sourceName, 60)});
  eventIds.add(id); titles.add(norm(e.title)); added++;
}
const key = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T12:00:00-04:00" : d;
events.items.sort((a, b) => new Date(key(b.date)) - new Date(key(a.date)));
events.items = events.items.slice(0, 40);

if (str(out.headline)) market.headline = str(out.headline, 120);

const now = new Date().toISOString();
events.asOf = now;
if (log.some(l => l.includes("deal"))) flows.asOf = now;
if (log.some(l => l.includes("company"))) players.asOf = now;
await writeJson("events.json", events);
await writeJson("flows.json", flows);
await writeJson("players.json", players);
await writeJson("market.json", market);
console.log(`Claude refresh (${MODEL}, ${searches ?? "?"} searches): ${added} new stories; ${log.join(", ") || "no deal or company changes"}.`);
