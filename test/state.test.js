/**
 * Unit tests for state.js — the exit-confirmation logic that decides when a
 * position actually closes. Uses a throwaway state file (EXIT_BOT_STATE_FILE)
 * so tests never touch a real deployment's state.json.
 *
 * Run: node --test test/
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_STATE_FILE = path.join(__dirname, ".test-state.json");
process.env.EXIT_BOT_STATE_FILE = TEST_STATE_FILE;

const {
  ensurePositionTracked,
  confirmPeak,
  registerExitSignal,
  detectTopup,
  isTopupSettling,
  updatePnlAndCheckExits,
  getTrackedPosition,
  recordFailedSwap,
  clearFailedSwap,
  getPendingSwapMints,
  consumeRecoveryAlert,
} = await import("../state.js");

const TEST_STATE_BACKUP_FILE = TEST_STATE_FILE + ".bak";

function resetStateFile() {
  if (fs.existsSync(TEST_STATE_FILE)) fs.unlinkSync(TEST_STATE_FILE);
  if (fs.existsSync(TEST_STATE_BACKUP_FILE)) fs.unlinkSync(TEST_STATE_BACKUP_FILE);
  consumeRecoveryAlert(); // drain any pending flag from a previous test
}

beforeEach(resetStateFile);
after(resetStateFile);

const baseTick = {
  pnl_pct_suspicious: false,
  in_range: true,
  oor_side: null,
  fee_per_tvl_24h: null,
  age_minutes: null,
};

// ── ensurePositionTracked ──

test("ensurePositionTracked creates a fresh entry with sane defaults", () => {
  ensurePositionTracked("posA", { pool: "poolA", pair: "FOO/SOL", in_range: true });
  const pos = getTrackedPosition("posA");
  assert.ok(pos);
  assert.equal(pos.closed, false);
  assert.equal(pos.peak_pnl_pct, 0);
  assert.equal(pos.trailing_active, false);
  assert.equal(pos.pool_name, "FOO/SOL");
});

test("ensurePositionTracked does not overwrite an already-tracked open position", () => {
  ensurePositionTracked("posA", { pool: "poolA", pair: "FOO/SOL" });
  ensurePositionTracked("posA", { pool: "poolA", pair: "SHOULD_NOT_APPLY/SOL" });
  assert.equal(getTrackedPosition("posA").pool_name, "FOO/SOL");
});

// ── confirmPeak ──

test("confirmPeak only raises the confirmed peak after confirmTicks consecutive reads", () => {
  ensurePositionTracked("posB", {});
  assert.equal(confirmPeak("posB", 5, 2), false);
  assert.equal(getTrackedPosition("posB").peak_pnl_pct, 0);
  assert.equal(confirmPeak("posB", 5, 2), true);
  assert.equal(getTrackedPosition("posB").peak_pnl_pct, 5);
});

test("confirmPeak never lowers an already-confirmed peak", () => {
  ensurePositionTracked("posC", {});
  confirmPeak("posC", 5, 1); // confirmTicks=1 -> confirmed immediately
  assert.equal(getTrackedPosition("posC").peak_pnl_pct, 5);
  confirmPeak("posC", 2, 1); // lower candidate
  assert.equal(getTrackedPosition("posC").peak_pnl_pct, 5);
});

// ── registerExitSignal ──

test("registerExitSignal fires only after confirmTicks consecutive identical signals", () => {
  ensurePositionTracked("posD", {});
  let r = registerExitSignal("posD", "STOP_LOSS", 2);
  assert.equal(r.fire, false);
  assert.equal(r.count, 1);
  r = registerExitSignal("posD", "STOP_LOSS", 2);
  assert.equal(r.fire, true);
  assert.equal(r.action, "STOP_LOSS");
});

test("registerExitSignal restarts the streak when the signal clears or changes", () => {
  ensurePositionTracked("posE", {});
  registerExitSignal("posE", "STOP_LOSS", 3);
  let r = registerExitSignal("posE", null, 3);
  assert.equal(r.fire, false);
  assert.equal(r.count, 0);
  r = registerExitSignal("posE", "STOP_LOSS", 3);
  assert.equal(r.count, 1);
});

// ── detectTopup ──

test("detectTopup flags a deposit jump above the threshold as a top-up", () => {
  ensurePositionTracked("posF", { deposit_total: 1 });
  assert.equal(detectTopup("posF", { deposit_total: 1 }), false);
  assert.equal(detectTopup("posF", { deposit_total: 1.5 }), true); // +50%
});

test("detectTopup ignores fluctuations under the threshold", () => {
  ensurePositionTracked("posG", { deposit_total: 1 });
  detectTopup("posG", { deposit_total: 1 });
  assert.equal(detectTopup("posG", { deposit_total: 1.001 }), false);
});

// ── isTopupSettling ──

test("isTopupSettling gives up after topupMaxSettleSec and resumes normal tracking", () => {
  ensurePositionTracked("posH", { deposit_total: 1 });
  detectTopup("posH", { deposit_total: 1 });
  detectTopup("posH", { deposit_total: 2 }); // arms settling
  const mgmt = { topupMaxSettleSec: 0, topupSettleMinSec: 999, topupSettleTolerancePct: 3, topupSettleConfirmTicks: 3 };
  assert.equal(isTopupSettling("posH", 50, mgmt), false);
});

test("isTopupSettling keeps suppressing while still within the settle window", () => {
  ensurePositionTracked("posI", { deposit_total: 1 });
  detectTopup("posI", { deposit_total: 1 });
  detectTopup("posI", { deposit_total: 2 }); // arms settling
  const mgmt = { topupMaxSettleSec: 300, topupSettleMinSec: 999999, topupSettleTolerancePct: 3, topupSettleConfirmTicks: 3 };
  assert.equal(isTopupSettling("posI", 999, mgmt), true);
});

// ── updatePnlAndCheckExits ──

test("updatePnlAndCheckExits fires TAKE_PROFIT once PnL crosses takeProfitPct", () => {
  ensurePositionTracked("posJ", { in_range: true });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: 10, stopLossPct: -50,
    trailingTakeProfit: false, dualSideEnabled: false, outOfRangeExitEnabled: false,
  };
  const result = updatePnlAndCheckExits("posJ", { ...baseTick, pnl_pct: 12 }, mgmt);
  assert.equal(result.action, "TAKE_PROFIT");
});

test("updatePnlAndCheckExits fires STOP_LOSS once PnL drops to stopLossPct", () => {
  ensurePositionTracked("posK", { in_range: true });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -15, stopLossRequireOorLeft: false,
    trailingTakeProfit: false, dualSideEnabled: false, outOfRangeExitEnabled: false,
  };
  const result = updatePnlAndCheckExits("posK", { ...baseTick, pnl_pct: -20 }, mgmt);
  assert.equal(result.action, "STOP_LOSS");
});

test("updatePnlAndCheckExits withholds STOP_LOSS when stopLossRequireOorLeft is set and price is still in range", () => {
  ensurePositionTracked("posL", { in_range: true });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -15, stopLossRequireOorLeft: true,
    trailingTakeProfit: false, dualSideEnabled: false, outOfRangeExitEnabled: false,
  };
  const result = updatePnlAndCheckExits("posL", { ...baseTick, pnl_pct: -20, oor_side: null }, mgmt);
  assert.equal(result, null);
});

test("updatePnlAndCheckExits fires TRAILING_TP after peak is confirmed and price drops from it", () => {
  ensurePositionTracked("posM", { in_range: true });
  confirmPeak("posM", 20, 1); // confirmTicks=1 -> confirmed immediately, peak=20
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50,
    trailingTakeProfit: true, trailingTriggerPct: 8, trailingDropPct: 3,
    dualSideEnabled: false, outOfRangeExitEnabled: false,
  };
  let result = updatePnlAndCheckExits("posM", { ...baseTick, pnl_pct: 19 }, mgmt);
  assert.equal(result, null); // trailing just activated, only 1pp off peak — not enough to fire
  result = updatePnlAndCheckExits("posM", { ...baseTick, pnl_pct: 16 }, mgmt);
  assert.equal(result.action, "TRAILING_TP"); // 4pp off peak >= 3pp drop
});

test("updatePnlAndCheckExits fires OUT_OF_RANGE after the configured wait once out of range", () => {
  ensurePositionTracked("posN", { in_range: false });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50, trailingTakeProfit: false,
    dualSideEnabled: false, outOfRangeExitEnabled: true, outOfRangeWaitMinutes: 0,
  };
  const result = updatePnlAndCheckExits("posN", { ...baseTick, pnl_pct: 0, in_range: false }, mgmt);
  assert.equal(result.action, "OUT_OF_RANGE");
});

test("updatePnlAndCheckExits withholds OUT_OF_RANGE on a bullish (kanan) breakout when outOfRangeRequireLeft is set", () => {
  ensurePositionTracked("posO", { in_range: false, oor_side: "above" });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50, trailingTakeProfit: false,
    dualSideEnabled: false, outOfRangeExitEnabled: true, outOfRangeWaitMinutes: 0, outOfRangeRequireLeft: true,
  };
  const result = updatePnlAndCheckExits("posO", { ...baseTick, pnl_pct: 30, in_range: false, oor_side: "above" }, mgmt);
  assert.equal(result, null);
});

test("updatePnlAndCheckExits still fires OUT_OF_RANGE on a bearish (kiri) breakout when outOfRangeRequireLeft is set", () => {
  ensurePositionTracked("posP", { in_range: false, oor_side: "below" });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50, trailingTakeProfit: false,
    dualSideEnabled: false, outOfRangeExitEnabled: true, outOfRangeWaitMinutes: 0, outOfRangeRequireLeft: true,
  };
  const result = updatePnlAndCheckExits("posP", { ...baseTick, pnl_pct: -10, in_range: false, oor_side: "below" }, mgmt);
  assert.equal(result.action, "OUT_OF_RANGE");
});

test("outOfRangeRequireLeft: switching from kanan to kiri starts the wait timer fresh, not carrying over kanan's elapsed time", () => {
  ensurePositionTracked("posQ", { in_range: false, oor_side: "above" });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50, trailingTakeProfit: false,
    dualSideEnabled: false, outOfRangeExitEnabled: true, outOfRangeWaitMinutes: 10, outOfRangeRequireLeft: true,
  };
  // Been broken out kanan (bullish) for a while — must not count toward the kiri timer.
  let result = updatePnlAndCheckExits("posQ", { ...baseTick, pnl_pct: 30, in_range: false, oor_side: "above" }, mgmt);
  assert.equal(result, null);
  // Flips to kiri just now — oor_left_since is fresh, so 10min wait hasn't elapsed yet.
  result = updatePnlAndCheckExits("posQ", { ...baseTick, pnl_pct: -5, in_range: false, oor_side: "below" }, mgmt);
  assert.equal(result, null);
});

test("updatePnlAndCheckExits fires LOW_YIELD when enabled and fee/TVL is below threshold past min age", () => {
  ensurePositionTracked("posR", { in_range: true });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50, trailingTakeProfit: false,
    dualSideEnabled: false, outOfRangeExitEnabled: false,
    lowYieldExitEnabled: true, minFeePerTvl24h: 0.5, minAgeBeforeYieldCheck: 60,
  };
  const result = updatePnlAndCheckExits("posR", { ...baseTick, pnl_pct: 0, fee_per_tvl_24h: 0.1, age_minutes: 90 }, mgmt);
  assert.equal(result.action, "LOW_YIELD");
});

test("updatePnlAndCheckExits withholds LOW_YIELD when lowYieldExitEnabled is false", () => {
  ensurePositionTracked("posS", { in_range: true });
  const mgmt = {
    exitGracePeriodSec: -1, takeProfitPct: null, stopLossPct: -50, trailingTakeProfit: false,
    dualSideEnabled: false, outOfRangeExitEnabled: false,
    lowYieldExitEnabled: false, minFeePerTvl24h: 0.5, minAgeBeforeYieldCheck: 60,
  };
  const result = updatePnlAndCheckExits("posS", { ...baseTick, pnl_pct: 0, fee_per_tvl_24h: 0.1, age_minutes: 90 }, mgmt);
  assert.equal(result, null);
});

// ── pending swap tracking ──

test("recordFailedSwap tracks a mint and clearFailedSwap removes it", () => {
  assert.deepEqual(getPendingSwapMints(), []);
  recordFailedSwap("MintABC");
  assert.deepEqual(getPendingSwapMints(), ["MintABC"]);
  recordFailedSwap("MintABC"); // repeat failure updates the same entry, doesn't duplicate
  assert.deepEqual(getPendingSwapMints(), ["MintABC"]);
  clearFailedSwap("MintABC");
  assert.deepEqual(getPendingSwapMints(), []);
});

// ── backup / corruption recovery ──

test("a successful save backs up the previous valid state before overwriting", () => {
  ensurePositionTracked("posT", {});
  assert.ok(!fs.existsSync(TEST_STATE_BACKUP_FILE), "no backup expected before the second save");

  ensurePositionTracked("posU", {}); // second save() call — should back up the state from after posT was written
  assert.ok(fs.existsSync(TEST_STATE_BACKUP_FILE));
  const backup = JSON.parse(fs.readFileSync(TEST_STATE_BACKUP_FILE, "utf8"));
  assert.ok(backup.positions.posT, "backup should reflect state as of just before this save");
  assert.ok(!backup.positions.posU, "backup should NOT yet include the write that triggered it");
});

test("load() recovers from the backup and flags it when state.json is corrupted", () => {
  ensurePositionTracked("posV", {});
  ensurePositionTracked("posW", {}); // creates a backup containing posV
  fs.writeFileSync(TEST_STATE_FILE, "{ not valid json ][");

  assert.equal(consumeRecoveryAlert(), false); // nothing consumed yet
  const pos = getTrackedPosition("posV");
  assert.ok(pos, "should recover posV from the backup after the main file was corrupted");
  assert.equal(consumeRecoveryAlert(), true, "recovery should be flagged exactly once");
  assert.equal(consumeRecoveryAlert(), false, "flag auto-clears after being consumed");
});

test("load() starts fresh (no throw) when both state.json and its backup are corrupted", () => {
  fs.writeFileSync(TEST_STATE_FILE, "{ broken");
  fs.writeFileSync(TEST_STATE_BACKUP_FILE, "{ also broken");
  const pos = getTrackedPosition("anything");
  assert.equal(pos, null);
});
