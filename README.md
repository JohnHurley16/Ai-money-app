# AI Money Map

A phone-first live map of how money moves between AI companies: who invests in whom, who buys chips and cloud computing from whom, who is borrowing, and who's up or down today.

It runs entirely on GitHub:

| What | How | When |
| --- | --- | --- |
| Website | GitHub Pages serves `index.html` and the files in `data/` | Always |
| Prices and market values | `scripts/update-prices.mjs` reads Yahoo Finance quotes. No key needed. | Every 15 min, 9 AM to 5:45 PM ET on weekdays |
| News, new deals, valuations | `scripts/ai-refresh.mjs` asks Claude (Claude API + web search) what changed | About 8:40 AM, 12:40, 2:40 and 4:40 PM ET on weekdays |
| Simulation model | `scripts/build-model.mjs` fits volatility models to price history since 2012 | About 5:25 PM ET on weekdays |

The page checks for new data every minute while it's open.

A second page, **What's next** (`sim.html`), runs a Monte Carlo simulation in your browser: 10,000 futures for the public AI companies on the map, built by replaying real trading days since 2012 (filtered historical simulation with a GJR-GARCH volatility model per stock), with buttons to test shocks. `scripts/build-model.mjs` rebuilds its model (`data/model.json`) each weekday after the close, from daily prices cached in `model-src/`. Both jobs live in `.github/workflows/update.yml`, which commits the new data and redeploys the site.

## Setup

1. **Pages:** Settings → Pages → Source: **GitHub Actions**.
2. **Claude API key:** Settings → Secrets and variables → Actions → **New repository secret**. Name it `ANTHROPIC_API_KEY` and paste a key from console.anthropic.com. Without it, prices still update but news and deals don't.
3. **Run it once:** Actions → "Update and deploy" → **Run workflow**.

## Optional settings

Set these under Settings → Secrets and variables → Actions → **Variables**:

- `CLAUDE_MODEL`: defaults to `claude-sonnet-5-5`. Set `claude-opus-5-5` for more careful research at a higher cost.
- `MAX_SEARCHES`: web searches per Claude run, default `15`. Lower it to cut cost.
- `WEB_SEARCH_TOOL`: the web search tool version, default `web_search_20250305`. Change it only if the API reports that version is retired.

To change the schedule, edit the two `cron` lines in the workflow. They are in UTC.

## Editing the data by hand

Everything the page shows is in `data/`:

- `players.json`: the companies. Public companies need `ticker` and `shares` (shares outstanding) so their value can be computed.
- `flows.json`: the deals. `from` is who pays and `to` is who receives. `type` is `hardware`, `services`, `investment`, `venture` or `debt`.
- `events.json`: the news feed, newest first.
- `loops.json`: the guided "loops" stories under the map.
- `market.json`: the headline and index moves.

Commit a change and the site redeploys on its own.

Not investment advice. Deal amounts are announced totals, often spread over years.
