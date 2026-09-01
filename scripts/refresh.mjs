import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_LEAGUE_ID = "1389357903374188544";
const API_BASE = "https://api.sleeper.app/v1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = path.join(ROOT, "snapshot.json");
const MAX_WEEK = 18;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

export function hashData(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

async function apiGet(relativePath, attempts = 3) {
  const url = `${API_BASE}${relativePath}`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "sleeper-league-bridge/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const error = new Error(`Sleeper returned ${response.status} for ${url}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || error.retryable === false) {
        break;
      }
      await sleep(1_000 * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function addIds(target, values) {
  for (const value of values ?? []) {
    if (value !== null && value !== undefined && value !== "") {
      target.add(String(value));
    }
  }
}

export function collectPlayerIds({ rosters, matchupsByWeek, transactions, drafts }) {
  const ids = new Set();

  for (const roster of rosters) {
    addIds(ids, roster.players);
    addIds(ids, roster.starters);
    addIds(ids, roster.reserve);
    addIds(ids, roster.taxi);
    addIds(ids, roster.player_map && Object.keys(roster.player_map));
  }

  for (const matchups of Object.values(matchupsByWeek)) {
    for (const matchup of matchups) {
      addIds(ids, matchup.players);
      addIds(ids, matchup.starters);
    }
  }

  for (const transaction of transactions) {
    addIds(ids, transaction.adds && Object.keys(transaction.adds));
    addIds(ids, transaction.drops && Object.keys(transaction.drops));
  }

  for (const draft of drafts) {
    addIds(
      ids,
      draft.picks.map((pick) => pick.player_id),
    );
  }

  return ids;
}

function compactPlayer(playerId, player) {
  if (!player) {
    return { player_id: playerId, full_name: null };
  }

  return {
    player_id: playerId,
    full_name:
      player.full_name ??
      [player.first_name, player.last_name].filter(Boolean).join(" ") ??
      null,
    first_name: player.first_name ?? null,
    last_name: player.last_name ?? null,
    position: player.position ?? null,
    fantasy_positions: player.fantasy_positions ?? [],
    team: player.team ?? null,
    number: player.number ?? null,
    status: player.status ?? null,
    injury_status: player.injury_status ?? null,
    age: player.age ?? null,
    years_exp: player.years_exp ?? null,
  };
}

function sortTransactions(transactions) {
  return [...transactions].sort(
    (a, b) =>
      (b.status_updated ?? b.created ?? 0) -
      (a.status_updated ?? a.created ?? 0),
  );
}

function buildTeams(rosters, users) {
  const usersById = new Map(users.map((user) => [String(user.user_id), user]));

  return rosters
    .map((roster) => {
      const user = usersById.get(String(roster.owner_id));
      return {
        roster_id: roster.roster_id,
        owner_id: roster.owner_id ?? null,
        owner_display_name: user?.display_name ?? null,
        owner_username: user?.username ?? null,
        team_name: user?.metadata?.team_name ?? null,
        player_ids: roster.players ?? [],
        starter_ids: roster.starters ?? [],
        reserve_ids: roster.reserve ?? [],
        taxi_ids: roster.taxi ?? [],
        settings: roster.settings ?? {},
      };
    })
    .sort((a, b) => a.roster_id - b.roster_id);
}

async function readExistingSnapshot() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function buildSnapshot(leagueId) {
  const [league, users, rosters, nflState, draftList, tradedPicks] =
    await Promise.all([
      apiGet(`/league/${leagueId}`),
      apiGet(`/league/${leagueId}/users`),
      apiGet(`/league/${leagueId}/rosters`),
      apiGet("/state/nfl"),
      apiGet(`/league/${leagueId}/drafts`),
      apiGet(`/league/${leagueId}/traded_picks`),
    ]);

  if (!league || String(league.league_id) !== leagueId) {
    throw new Error(`League ${leagueId} was not returned by Sleeper`);
  }

  const lastWeek = Math.max(
    MAX_WEEK,
    Number(nflState.week ?? 0),
    Number(league.settings?.leg ?? 0),
  );
  const matchupWeeks = Array.from({ length: lastWeek }, (_, index) => index + 1);
  const transactionWeeks = Array.from(
    { length: lastWeek + 1 },
    (_, index) => index,
  );

  const [matchupRows, transactionRows, drafts] = await Promise.all([
    mapLimit(matchupWeeks, 6, async (week) => [
      String(week),
      await apiGet(`/league/${leagueId}/matchups/${week}`),
    ]),
    mapLimit(transactionWeeks, 6, async (week) => [
      String(week),
      await apiGet(`/league/${leagueId}/transactions/${week}`),
    ]),
    mapLimit(draftList, 4, async (draft) => ({
      draft: await apiGet(`/draft/${draft.draft_id}`),
      picks: await apiGet(`/draft/${draft.draft_id}/picks`),
      traded_picks: await apiGet(`/draft/${draft.draft_id}/traded_picks`),
    })),
  ]);

  const matchupsByWeek = Object.fromEntries(matchupRows);
  const transactionsByWeek = Object.fromEntries(transactionRows);
  const transactions = sortTransactions(Object.values(transactionsByWeek).flat());
  const playerIds = collectPlayerIds({
    rosters,
    matchupsByWeek,
    transactions,
    drafts,
  });
  const allPlayers = await apiGet("/players/nfl");
  const players = Object.fromEntries(
    [...playerIds]
      .sort()
      .map((playerId) => [playerId, compactPlayer(playerId, allPlayers[playerId])]),
  );

  const data = {
    league_id: leagueId,
    nfl_state: nflState,
    league,
    users,
    rosters,
    teams: buildTeams(rosters, users),
    players,
    matchups_by_week: matchupsByWeek,
    transactions_by_week: transactionsByWeek,
    transactions,
    trades: transactions.filter((transaction) => transaction.type === "trade"),
    traded_picks: tradedPicks,
    drafts,
  };

  return {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    content_hash: hashData(data),
    source: {
      provider: "Sleeper public API",
      base_url: API_BASE,
      authentication: "none",
      documentation: "https://docs.sleeper.com/",
    },
    ...data,
  };
}

async function main() {
  const leagueId = String(process.env.LEAGUE_ID || DEFAULT_LEAGUE_ID);
  if (!/^\d+$/.test(leagueId)) {
    throw new Error("LEAGUE_ID must contain only digits");
  }

  const [existing, snapshot] = await Promise.all([
    readExistingSnapshot(),
    buildSnapshot(leagueId),
  ]);

  if (existing?.content_hash === snapshot.content_hash) {
    console.log(
      `No league data changes since ${existing.generated_at}; snapshot is current.`,
    );
    return;
  }

  const temporaryPath = `${OUTPUT_PATH}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(canonicalize(snapshot), null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, OUTPUT_PATH);
  console.log(`Updated ${OUTPUT_PATH} at ${snapshot.generated_at}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
