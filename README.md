# Slush Poker Market ♠️♥️♣️♦️

A just-for-fun prediction market for the **OpenOcean × Insight Partners Legendary Slush Poker Tournament** ([Luma](https://luma.com/b8jgl5yz), Valkoinen Sali, Helsinki, 17 Nov 2026). It's styled after the Luma event page.

Guests pick a name, get 1,000 play chips and trade on:

- **Who wins the tournament?** One outcome per player.
- **Who goes deepest from Table X?** One market per table.
- **Props** (in `data/markets.json`): founder vs investor winner, first-timer wins, which table busts first, host firm at the final table, finish before 23:00.

Prices come from an LMSR market maker, so anyone can trade at any time. A winning share pays out 1 chip. When an organiser marks a player as busted, that player drops out of every market and the others reprice. Table markets, *which table busts first*, *winner role* and *first-timer* all resolve automatically. No real money is involved.

## Run it

```bash
ADMIN_TOKEN=pick-a-secret node server.js   # http://localhost:3000
```

It needs Node 18 or later and has zero dependencies. State is saved to `state/db.json`, or wherever `DB_PATH` points. You can deploy it to any host that runs Node with a persistent disk (Render, Railway, Fly.io, a VM) and point `DB_PATH` at the mounted volume.

Organisers go to **`/#/admin`**, enter the `ADMIN_TOKEN`, and from there can:
- **Bust** players as they leave. Markets update and auto-resolve.
- **Pause, reopen or resolve** any market by hand.
- **Reload data files** after importing players. No restart needed.

## Deploy on Vercel

1. Import the repo in Vercel (Add New → Project). No build settings are needed; `vercel.json` handles them.
2. In the project, open **Storage → Create → Upstash for Redis** and connect it. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which hold the shared market state.
3. Add an env var `ADMIN_TOKEN` (your organiser password), then redeploy.

Without Redis env vars the API falls back to a local JSON file, which does not persist on Vercel.

## Importing the real tables and players

The repo ships with 40 obviously fictional placeholder players across 5 tables. To replace them, fill in a CSV like `data/players.example.csv`:

| column | notes |
|---|---|
| `name` | required |
| `table` | required, e.g. `A` or `Table 3` |
| `seat` | optional number |
| `title`, `company` | shown on cards and profiles |
| `role` | `founder` / `investor` / `operator` (drives the *winner role* market) |
| `photo` | image URL (falls back to initials) |
| `linkedin`, `bio` | profile page |
| `first_timer`, `host` | `yes` / `no` |

```bash
node scripts/import-csv.js players.csv   # writes data/players.json + data/tables.json
```

Then click **Reload data files** in the admin page. You can also edit `data/players.json` and `data/tables.json` directly.

> Import before trading starts. Adding or removing players after trades have happened shifts prices. Positions in removed players stay worthless.

## Tweaking

- `data/event.json`: event copy, cover image, starting chips, and `liquidity`. Liquidity is the LMSR `b` value: higher means prices move less per chip. Raise it if the crowd is large.
- `data/markets.json`: add or remove prop markets. Kinds are `binary` (Yes/No), `choice` (custom `outcomes`) and `tables` (one outcome per table).
- `scripts/make-sample-data.js` regenerates the placeholder line-up.

## Layout

```
server.js            HTTP server, JSON API, persistence, auto-resolution
api/index.js         Vercel function entry (wraps server.js)
public/lmsr.js       market maker math (shared by server and browser)
public/              single-page frontend (vanilla JS, no build step)
data/                event, tables, players, prop markets
scripts/             CSV import + sample data generator
```
