import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalize,
  collectPlayerIds,
  hashData,
} from "../scripts/refresh.mjs";

test("canonicalize and hashData ignore object key order", () => {
  const first = { b: 2, a: { d: 4, c: 3 } };
  const second = { a: { c: 3, d: 4 }, b: 2 };

  assert.deepEqual(canonicalize(first), canonicalize(second));
  assert.equal(hashData(first), hashData(second));
});

test("collectPlayerIds finds roster, matchup, transaction, and draft players", () => {
  const ids = collectPlayerIds({
    rosters: [
      {
        players: ["1"],
        starters: ["2"],
        reserve: ["3"],
        taxi: ["4"],
      },
    ],
    matchupsByWeek: { 1: [{ players: ["5"], starters: ["6"] }] },
    transactions: [{ adds: { 7: 1 }, drops: { 8: 2 } }],
    drafts: [{ picks: [{ player_id: "9" }] }],
  });

  assert.deepEqual([...ids].sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});
