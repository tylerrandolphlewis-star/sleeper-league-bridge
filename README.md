# Sleeper League Bridge

This repository publishes a single, auto-refreshed JSON snapshot for Sleeper
league `1389357903374188544` (Dem Boyz 2023).

## Snapshot URL

Use this stable public URL in ChatGPT or any other JSON client:

<https://raw.githubusercontent.com/tylerrandolphlewis-star/sleeper-league-bridge/main/snapshot.json>

The snapshot includes:

- league settings and scoring configuration
- users and rosters
- a joined `teams` list with manager and roster details
- a compact player-name index for every referenced player ID
- matchups for weeks 1–18
- transactions for weeks 0–18
- a dedicated, newest-first `trades` list
- league traded picks
- every league draft, including draft details, picks, and traded picks
- the current NFL state reported by Sleeper

## Refresh schedule

The `Refresh Sleeper snapshot` GitHub Actions workflow checks Sleeper at 3, 18,
33, and 48 minutes past every hour. It commits `snapshot.json` only when the
underlying league data changes. The workflow can also be run manually from the
Actions tab.

No Sleeper password, cookie, API token, or other credential is used. Sleeper's
official API is public and read-only.

## ChatGPT prompt

In a future conversation, provide the snapshot URL and ask ChatGPT to open it.
For example:

> Read my live Sleeper league snapshot at
> https://raw.githubusercontent.com/tylerrandolphlewis-star/sleeper-league-bridge/main/snapshot.json
> and analyze the latest trade.

## Local use

Node.js 20 or newer is required.

```bash
npm test
npm run refresh
```

Set `LEAGUE_ID` to reuse the bridge for another public Sleeper league.

Data comes from the [official Sleeper public API](https://docs.sleeper.com/).
