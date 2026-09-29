/**
 * Standalone position tracking for exit-bot (peak PnL confirmation,
 * consecutive-tick exit-signal confirmation), persisted to its own file.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so tests can point at a throwaway file instead of the real
// state.json — production behavior (no env var set) is unchanged.
const STATE_FILE = process.env.EXIT_BOT_STATE_FILE || path.join(__dirname, "state.json");
const STATE_BACKUP_FILE = STATE_FILE + ".bak";

function emptyState() {
  return { positions: {}, pendingSwaps: {}, lastUpdated: null };
}

function normalize(state) {
  if (!state.pendingSwaps) state.pendingSwaps = {}; // back-compat with state.json written before this field existed
  return state;
}

// Set (and auto-cleared on read) whenever load() had to fall back to the
// backup because the main state.json failed to parse — index.js's tick
// loop checks this once per tick to alert Telegram, since state.js itself
// has no Telegram dependency (keeps it side-effect-free and test-safe).
let recoveredFromBackupPending = false;
export function consumeRecoveryAlert() {
  if (!recoveredFromBackupPending) return false;
  recoveredFromBackupPending = false;
  return true;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState();
  }
  try {
    return normalize(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message} — attempting recovery from backup`);
    if (fs.existsSync(STATE_BACKUP_FILE)) {
      try {
        const backup = normalize(JSON.parse(fs.readFileSync(STATE_BACKUP_FILE, "utf8")));
        recoveredFromBackupPending = true;
        log("state_error", `Recovered state from ${STATE_BACKUP_FILE} (may be a few seconds behind the corrupted file)`);
        return backup;
      } catch (backupErr) {
        log("state_error", `Backup also unreadable: ${backupErr.message} — starting from empty state`);
      }
    } else {
      log("state_error", "No backup available — starting from empty state");
    }
    return emptyState();
  }
}

function save(state) {
  try {
    // Back up the current on-disk file BEFORE overwriting it, so a write
    // that gets interrupted mid-way (crash, disk full, container killed)
    // can't take out both the live file and its only recovery copy at
    // once. Skipped if the current file is itself unreadable — no point
    // propagating a corrupt file into the backup slot.
    if (fs.existsSync(STATE_FILE)) {
      try {
        JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
      } catch {
        // current file already corrupt — leave whatever backup exists alone
      }
    }
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

/**
 * Auto-track a position discovered on-chain that isn't in state.json yet.
 */
export function ensurePositionTracked(position_address, positionData) {
  const state = load();
  if (state.positions[position_address] && !state.positions[position_address].closed) return;

  // Range-consumed tracking (see checkRangeConsumedAlerts below): frozen at
  // open, same spirit as is_dual_side_at_open — which edge of the range the
  // active bin started closest to is the "0% consumed" reference point, and
  // that shouldn't drift as price moves around later.
  const lowerBin = positionData.lower_bin ?? null;
  const upperBin = positionData.upper_bin ?? null;
  const activeBin = positionData.active_bin ?? null;
  let rangeEntryEdge = null;
  let rangeTotalBins = null;
  if (lowerBin != null && upperBin != null && activeBin != null && upperBin > lowerBin) {
    rangeTotalBins = upperBin - lowerBin;
    rangeEntryEdge =
      activeBin <= lowerBin
        ? "lower"
        : activeBin >= upperBin
          ? "upper"
          : activeBin - lowerBin <= upperBin - activeBin
            ? "lower"
            : "upper";
  }

  state.positions[position_address] = {
    position: position_address,
    pool: positionData.pool || null,
    pool_name: positionData.pair || (positionData.pool || "?").slice?.(0, 8) || "?",
    base_mint: positionData.base_mint || null,
    // Snapshot of dual-sidedness taken THIS tick only (right around position
    // open, since ensurePositionTracked only runs once per position). Frozen
    // here rather than re-derived live every tick — a position deposited
    // single-sided naturally ends up holding both tokens as price moves
    // through its range and converts bin contents, which made a live
    // recompute misreport plain single-sided SOL positions as "Dual Side".
    // Unknown (null from a failed on-chain read) is treated as
    // not-dual-side, same as detectDualSided()'s documented caller contract.
    is_dual_side_at_open: positionData.is_dual_side === true,
    deployed_at: new Date().toISOString(),
    // Unlike deployed_at (re-armed by detectTopup for the grace window), this
    // never changes after creation — reports use it as the true hold-duration start.
    first_deployed_at: new Date().toISOString(),
    out_of_range_since: positionData.in_range === false ? new Date().toISOString() : null,
    // Duration tracked specifically for "OOR kiri" (price broke below range —
    // bearish for the base/memecoin side), separate from out_of_range_since
    // above (which counts ANY out-of-range direction). Needed so
    // outOfRangeRequireLeft can gate the OOR-wait exit on sustained downside
    // breakout only, without a bullish breakout's elapsed time counting
    // toward it (see updatePnlAndCheckExits).
    oor_left_since: positionData.oor_side === "below" ? new Date().toISOString() : null,
    closed: false,
    closed_at: null,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_exit_action: null,
    pending_exit_count: 0,
    trailing_active: false,
    dual_side_trailing_active: false,
    last_deposit_total: positionData.deposit_total ?? null,
    last_raw_pnl_pct: positionData.pnl_pct ?? null,
    topup_settling: false,
    pre_topup_pnl_pct: null,
    topup_settling_started_at: null,
    topup_settle_confirm_count: 0,
    spike_direction: null,
    last_unclaimed_fees_usd: positionData.unclaimed_fees_usd ?? null,
    range_entry_edge: rangeEntryEdge,
    range_total_bins: rangeTotalBins,
    range_early_warning_sent: false,
    range_critical_warning_sent: false,
  };
  save(state);
  log("state", `Tracked new position ${position_address.slice(0, 8)} in pool ${state.positions[position_address].pool_name}`);
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls
 * where the candidate stays above the current peak.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    save(state);
    log("state", `Position ${position_address.slice(0, 8)} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}%`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. Fires only after
 * `confirmTicks` consecutive polls report the SAME action.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
  }
  save(state);
  if (fire) log("state", `Position ${position_address.slice(0, 8)} exit signal "${signal}" confirmed`);
  return { fire, action: signal, count };
}

/**
 * True while a position is still within its post-open (or post-top-up)
 * settling window — see detectTopup() for why top-ups re-arm this.
 */
export function inGracePeriod(position_address, graceSec = 20) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  const ageSinceTrackedSec = (Date.now() - new Date(pos.deployed_at).getTime()) / 1000;
  return ageSinceTrackedSec < graceSec;
}

/**
 * Re-arm the open-grace window (deployed_at) and the topup-settling guard on
 * `pos`. Shared by detectTopup() (real deposit-jump signal) and
 * detectPnlSpike() (magnitude-based fallback signal) — both react to the
 * same underlying artifact and should suppress checks identically. Caller
 * still owns save()/logging.
 */
function armTopupSettling(pos, direction = "up") {
  pos.deployed_at = new Date().toISOString();
  // The fixed-length grace window above isn't always enough — the indexer's
  // balances/deposits reconciliation lag is variable and can run well past
  // it (observed 2.5min+ after back-to-back top-ups). So on top of the
  // timed grace, hold a baseline (the last confirmed-real peak) and keep
  // suppressing exit/peak checks in isTopupSettling() until the reported
  // PnL actually comes back near that baseline, however long that takes.
  pos.topup_settling = true;
  pos.pre_topup_pnl_pct = pos.peak_pnl_pct ?? 0;
  pos.topup_settling_started_at = new Date().toISOString();
  pos.topup_settle_confirm_count = 0;
  // "up" = phantom PROFIT spike (top-up, or a positive one-tick jump) —
  // settled once PnL decays back down near baseline. "down" = phantom LOSS
  // spike (a data glitch reporting an implausible crash that never
  // happened) — settled once PnL recovers back up near baseline. Same
  // suppression window, opposite recovery direction, so isTopupSettling
  // needs to know which way it's waiting.
  pos.spike_direction = direction;
}

/**
 * Meteora's DLMM indexer updates a position's live balance before it
 * updates allTimeDeposits when you add liquidity to an existing position,
 * so pnl = (balances - deposit) / deposit briefly reports the added
 * capital itself as profit (e.g. add 0.5 SOL on top of 1 SOL -> reads as
 * +50% PnL). allTimeDeposits only ever increases on a real deposit txn
 * (never on withdrawals or fee accrual), so any upward jump is a reliable
 * "size was just added" signal.
 *
 * When detected, re-arm the same open-grace window used for fresh
 * positions (deployed_at) so instant TP/SL/trailing checks and peak
 * tracking pause until the indexer catches up.
 */
export function detectTopup(position_address, positionData) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentDeposit = positionData.deposit_total;
  if (currentDeposit == null) return false;

  const prevDeposit = pos.last_deposit_total;
  pos.last_deposit_total = currentDeposit;

  if (prevDeposit == null || prevDeposit <= 0) {
    save(state);
    return false;
  }

  const jump = currentDeposit - prevDeposit;
  const isRealTopup = jump > Math.max(prevDeposit * 0.005, 0.0005);

  if (isRealTopup) {
    armTopupSettling(pos);
    save(state);
    const pct = ((jump / prevDeposit) * 100).toFixed(1);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} deposit jumped +${pct}% (size top-up) — re-arming grace period to avoid reading it as PnL`,
    );
    return true;
  }

  save(state);
  return false;
}

/**
 * Claiming fees (whether the bot does it as part of a close, or the user
 * does it manually from the Meteora UI) zeroes out unclaimed fees, and the
 * indexer's balances/PnL reconciliation for that can lag the same way a
 * top-up's does (see detectTopup) — observed causing PnL to briefly read
 * higher than it actually is right after a manual claim, which can get
 * confirmed as a fake trailing-TP peak and trigger a premature close. A
 * near-total drop in unclaimed fees is a reliable "a claim just happened"
 * signal, so treat it the same way as a top-up: re-arm the settling guard.
 */
export function detectFeeClaim(position_address, positionData) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentUnclaimed = positionData.unclaimed_fees_usd;
  if (currentUnclaimed == null) return false;

  const prevUnclaimed = pos.last_unclaimed_fees_usd;
  pos.last_unclaimed_fees_usd = currentUnclaimed;

  if (prevUnclaimed == null || prevUnclaimed <= 0) {
    save(state);
    return false;
  }

  const dropped = prevUnclaimed - currentUnclaimed;
  const isClaim = dropped > 0.0005 && currentUnclaimed <= prevUnclaimed * 0.1;

  if (isClaim) {
    armTopupSettling(pos, "up");
    save(state);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} unclaimed fees dropped from ${prevUnclaimed.toFixed(4)} to ${currentUnclaimed.toFixed(4)} (fee claim detected) — re-arming settling guard to avoid reading it as PnL`,
    );
    return true;
  }

  save(state);
  return false;
}

/**
 * Fallback for detectTopup(): the indexer updates live balance (which
 * pnl_pct is derived from) BEFORE it updates allTimeDeposits, so on a
 * top-up the phantom-profit spike can show up, get confirmed as a peak
 * (confirmPeak needs just confirmTicks * pollIntervalSec — a few seconds),
 * and trigger an instant TAKE_PROFIT/trailing close before allTimeDeposits
 * ever catches up and detectTopup gets a chance to fire (observed: deposit
 * jump can lag 45s-2.5min+ behind the balance jump). detectTopup's signal
 * arrives too late to help in that case.
 *
 * This catches the same artifact by its symptom instead of its cause: an
 * implausibly large single-tick jump in reported PnL, regardless of
 * whether allTimeDeposits has moved yet. A real top-up's balance jump and a
 * genuine price spike both produce large jumps, but gating exits behind the
 * same settling window either way is the safe tradeoff — a real spike just
 * waits out the settling window before firing for real.
 *
 * Checks BOTH directions. The original version only caught large POSITIVE
 * jumps (phantom profit from a top-up) — a large NEGATIVE jump (indexer
 * briefly reporting balances as ~0, or any other data glitch) had no
 * equivalent guard, so a bad single reading of e.g. -100% could sail
 * straight through confirmTicks and fire a real STOP_LOSS on a position
 * that never actually lost anything (confirmed by checking the token's
 * real price chart — no crash happened). Both directions now arm the same
 * settling suppression, just recovering toward baseline from the opposite
 * side (see isTopupSettling).
 */
export function detectPnlSpike(position_address, currentPnlPct, mgmtConfig) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const prevPnlPct = pos.last_raw_pnl_pct;
  pos.last_raw_pnl_pct = currentPnlPct;

  if (currentPnlPct == null || prevPnlPct == null) {
    save(state);
    return false;
  }

  const jump = currentPnlPct - prevPnlPct;
  const threshold = mgmtConfig.pnlSpikeGuardPct ?? 15;

  if (!pos.topup_settling && Math.abs(jump) >= threshold) {
    const direction = jump > 0 ? "up" : "down";
    armTopupSettling(pos, direction);
    save(state);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} PnL jumped ${jump > 0 ? "+" : ""}${jump.toFixed(2)}pp in one tick ` +
      `(${prevPnlPct.toFixed(2)}% -> ${currentPnlPct.toFixed(2)}%) — treating as phantom ${direction === "up" ? "top-up" : "crash"} spike, re-arming settling guard`,
    );
    return true;
  }

  save(state);
  return false;
}

/**
 * True while a position is still "settling" after a size top-up: the
 * reported PnL hasn't yet come back down near the pre-top-up baseline, so
 * it's still likely showing the newly-added capital as phantom profit
 * rather than real gains. Unlike inGracePeriod(), this isn't a fixed
 * timer — the indexer's balances/deposits reconciliation lag after a
 * top-up varies and can outlast a short fixed window (see detectTopup()).
 * A maxSettleSec safety valve prevents this from stalling forever on a
 * position that's genuinely mooning right after a top-up.
 *
 * Resolving "settled" requires BOTH a minimum elapsed time (minSettleSec)
 * AND several consecutive within-tolerance readings (settleConfirmTicks).
 * Without these, a single early poll — taken before the indexer has even
 * started reconciling — can read coincidentally close to baseline (e.g.
 * a freshly-opened position with baseline 0% often still reads ~0% for a
 * moment right at top-up) and clear settling instantly, before the actual
 * phantom-profit artifact shows up (observed 1-2min later in practice).
 * That left the position fully unprotected right up until the spike hit,
 * causing false TAKE_PROFIT closes on pure size top-ups.
 */
export function isTopupSettling(position_address, currentPnlPct, mgmtConfig) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || !pos.topup_settling) return false;

  const maxSettleSec = mgmtConfig.topupMaxSettleSec ?? 300;
  const minSettleSec = mgmtConfig.topupSettleMinSec ?? 45;
  const settleConfirmTicks = Math.max(1, mgmtConfig.topupSettleConfirmTicks ?? 3);
  const elapsedSec = (Date.now() - new Date(pos.topup_settling_started_at).getTime()) / 1000;
  if (elapsedSec >= maxSettleSec) {
    pos.topup_settling = false;
    pos.topup_settle_confirm_count = 0;
    save(state);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} topup settling window timed out after ${Math.floor(elapsedSec)}s — resuming normal PnL tracking (current reading accepted as real)`,
    );
    return false;
  }

  if (currentPnlPct == null) return true;

  const baseline = pos.pre_topup_pnl_pct ?? 0;
  const tolerancePct = mgmtConfig.topupSettleTolerancePct ?? 3;
  // "up" spikes settle by decaying back DOWN toward baseline; "down" spikes
  // (phantom crash reading) settle by recovering back UP toward baseline —
  // see armTopupSettling/detectPnlSpike.
  const withinTolerance =
    pos.spike_direction === "down" ? currentPnlPct - baseline >= -tolerancePct : currentPnlPct - baseline <= tolerancePct;

  if (withinTolerance && elapsedSec >= minSettleSec) {
    pos.topup_settle_confirm_count = (pos.topup_settle_confirm_count ?? 0) + 1;
    if (pos.topup_settle_confirm_count >= settleConfirmTicks) {
      pos.topup_settling = false;
      pos.topup_settle_confirm_count = 0;
      save(state);
      log(
        "state",
        `Position ${position_address.slice(0, 8)} PnL settled to ${currentPnlPct.toFixed(2)}% (baseline ${baseline.toFixed(2)}%) — resuming normal PnL tracking`,
      );
      return false;
    }
    save(state);
    return true;
  }

  if (pos.topup_settle_confirm_count) {
    pos.topup_settle_confirm_count = 0;
    save(state);
  }

  return true;
}

/**
 * % of the way the active bin has traveled from the position's entry edge
 * (the edge nearest the active bin when the position was first opened —
 * see ensurePositionTracked) toward the opposite edge. For a single-sided
 * deposit this tracks how much of it has effectively been converted into
 * the other token as price moves through the range. Clamped to [0, 100] —
 * a position that's fully out the far side reads as 100%, not >100%.
 */
function computeRangeConsumedPct(entryEdge, lowerBin, upperBin, activeBin, totalBins) {
  if (!totalBins || totalBins <= 0) return null;
  const raw = entryEdge === "lower" ? ((activeBin - lowerBin) / totalBins) * 100 : ((upperBin - activeBin) / totalBins) * 100;
  return Math.max(0, Math.min(100, Math.round(raw * 100) / 100));
}

/**
 * Read-only lookup of the same %-consumed figure checkRangeConsumedAlerts()
 * uses, for display purposes (e.g. /positions) — doesn't touch the
 * alert-sent flags or write to disk. Returns null if the position wasn't
 * tracked with bin data at open (see ensurePositionTracked), or if any of
 * the current bin fields are missing.
 */
export function getRangeConsumedPct(position_address, positionData) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.range_entry_edge == null || !pos.range_total_bins) return null;

  const { lower_bin: lowerBin, upper_bin: upperBin, active_bin: activeBin } = positionData;
  if (lowerBin == null || upperBin == null || activeBin == null) return null;

  return computeRangeConsumedPct(pos.range_entry_edge, lowerBin, upperBin, activeBin, pos.range_total_bins);
}

/**
 * Informational (non-exit) alerts for how far price has moved through a
 * position's range — an early heads-up that a single-sided deposit is
 * being converted into the other token, well before it's fully out of
 * range. Fires at most once per threshold crossing: each alert level has
 * its own "already sent" flag that only re-arms once the reading drops
 * back a few points below its threshold (RANGE_ALERT_HYSTERESIS_PCT),
 * so a value oscillating right at the line doesn't spam repeat alerts.
 * Returns { level: "EARLY" | "CRITICAL", consumedPct } when an alert
 * should be sent this tick, or null.
 */
const RANGE_ALERT_HYSTERESIS_PCT = 5;

export function checkRangeConsumedAlerts(position_address, positionData, mgmtConfig) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.range_entry_edge == null || !pos.range_total_bins) return null;

  const { lower_bin: lowerBin, upper_bin: upperBin, active_bin: activeBin } = positionData;
  if (lowerBin == null || upperBin == null || activeBin == null) return null;

  const consumedPct = computeRangeConsumedPct(pos.range_entry_edge, lowerBin, upperBin, activeBin, pos.range_total_bins);
  if (consumedPct == null) return null;

  const earlyPct = mgmtConfig.rangeEarlyWarningPct ?? 20;
  const criticalPct = mgmtConfig.rangeCriticalWarningPct ?? 50;
  let changed = false;
  let fired = null;

  if (mgmtConfig.rangeCriticalWarningEnabled !== false && consumedPct >= criticalPct) {
    if (!pos.range_critical_warning_sent) {
      pos.range_critical_warning_sent = true;
      changed = true;
      fired = "CRITICAL";
    }
  } else if (pos.range_critical_warning_sent && consumedPct < criticalPct - RANGE_ALERT_HYSTERESIS_PCT) {
    pos.range_critical_warning_sent = false;
    changed = true;
  }

  // Skip early warning on a tick that already fired critical — no point
  // sending both for the same crossing.
  if (!fired && mgmtConfig.rangeEarlyWarningEnabled !== false && consumedPct >= earlyPct) {
    if (!pos.range_early_warning_sent) {
      pos.range_early_warning_sent = true;
      changed = true;
      fired = "EARLY";
    }
  } else if (pos.range_early_warning_sent && consumedPct < earlyPct - RANGE_ALERT_HYSTERESIS_PCT) {
    pos.range_early_warning_sent = false;
    changed = true;
  }

  if (changed) save(state);
  return fired ? { level: fired, consumedPct } : null;
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates out_of_range_since / trailing_active as a side effect.
 * Returns { action, reason } or null.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, oor_side, fee_per_tvl_24h, age_minutes } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;
  // Frozen at position-open (see ensurePositionTracked) — NOT positionData's
  // live is_dual_side, which drifts as price moves through the range and
  // converts a single-sided deposit's bins into a mix of both tokens.
  const isDualSideAtOpen = pos.is_dual_side_at_open === true;

  let changed = false;

  // Dual-side positions get their own trailing (dualSideTrailing* below)
  // when dual side is enabled — skip arming the regular trailing so it
  // can't race the dual-side one and fire TRAILING_TP instead of
  // DUAL_SIDE_TRAILING_TP.
  if (
    mgmtConfig.trailingTakeProfit &&
    !pos.trailing_active &&
    !(mgmtConfig.dualSideEnabled && isDualSideAtOpen) &&
    (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct
  ) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address.slice(0, 8)} trailing TP activated (peak: ${pos.peak_pnl_pct}%)`);
  }

  if (
    mgmtConfig.dualSideEnabled &&
    mgmtConfig.dualSideTrailingEnabled &&
    isDualSideAtOpen &&
    !pos.dual_side_trailing_active &&
    mgmtConfig.dualSideTrailingTriggerPct != null &&
    (pos.peak_pnl_pct ?? 0) >= mgmtConfig.dualSideTrailingTriggerPct
  ) {
    pos.dual_side_trailing_active = true;
    changed = true;
    log("state", `Position ${position_address.slice(0, 8)} dual side trailing TP activated (peak: ${pos.peak_pnl_pct}%)`);
  }

  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
  }

  // Same idea, but scoped to "OOR kiri" only — resets the moment the break
  // stops being to the downside (price comes back in range, or the break
  // flips to the upside), so a bullish breakout's elapsed time never counts
  // toward a subsequent downside break's wait timer.
  if (oor_side === "below" && !pos.oor_left_since) {
    pos.oor_left_since = new Date().toISOString();
    changed = true;
  } else if (oor_side !== "below" && pos.oor_left_since) {
    pos.oor_left_since = null;
    changed = true;
  }

  if (changed) save(state);

  // ── Grace period after deploy ──
  // Meteora's DLMM indexer records the deposit before it reflects real
  // balances, so a freshly-opened position can briefly report ~-100% PnL
  // (balances=0 vs a real deposit) even though nothing was actually lost.
  // Suppress instant-close checks until the indexer has had time to catch up.
  if (inGracePeriod(position_address, mgmtConfig.exitGracePeriodSec ?? 20)) {
    return null;
  }

  // ── Settling after a size top-up ──
  // Time-based grace above may have already elapsed, but the top-up's
  // phantom-PnL artifact can outlast it — see isTopupSettling().
  if (isTopupSettling(position_address, currentPnlPct, mgmtConfig)) {
    return null;
  }

  // ── Strategi Dual Side (dual-sided positions only) ──
  // Independent TP/SL for positions deposited with liquidity on both tokens
  // X and Y at open. SL mode controls how PnL and "OOR kiri" combine — see config.js.
  if (mgmtConfig.dualSideEnabled && isDualSideAtOpen) {
    if (
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      mgmtConfig.dualSideTakeProfitPct != null &&
      currentPnlPct >= mgmtConfig.dualSideTakeProfitPct
    ) {
      return {
        action: "DUAL_SIDE_TP",
        reason: `Dual side TP: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.dualSideTakeProfitPct}%`,
      };
    }

    if (
      mgmtConfig.dualSideTrailingEnabled &&
      pos.dual_side_trailing_active &&
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      mgmtConfig.dualSideTrailingDropPct != null
    ) {
      const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
      if (dropFromPeak >= mgmtConfig.dualSideTrailingDropPct) {
        return {
          action: "DUAL_SIDE_TRAILING_TP",
          reason:
            `Dual side trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}%` +
            ` (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.dualSideTrailingDropPct}%)`,
        };
      }
    }

    const slMode = mgmtConfig.dualSideStopLossMode ?? "pnl_and_oor";
    const pnlHit =
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      mgmtConfig.dualSideStopLossPct != null &&
      currentPnlPct <= mgmtConfig.dualSideStopLossPct;
    const oorHit = oor_side === "below";
    const slFire = slMode === "oor_only" ? oorHit : slMode === "pnl_only" ? pnlHit : pnlHit && oorHit;

    if (slFire) {
      const modeLabel = slMode === "oor_only" ? "OOR kiri only" : slMode === "pnl_only" ? "PnL only" : "PnL + OOR kiri";
      return {
        action: "DUAL_SIDE_SL",
        reason:
          `Dual side SL (mode: ${modeLabel}): PnL ${currentPnlPct != null ? currentPnlPct.toFixed(2) + "%" : "?"}` +
          `, OOR kiri: ${oorHit ? "yes" : "no"}`,
      };
    }
  }

  // ── Take profit (instant close, unconditional) ──
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.takeProfitPct != null && currentPnlPct >= mgmtConfig.takeProfitPct) {
    return {
      action: "TAKE_PROFIT",
      reason: `Take profit: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.takeProfitPct}%`,
    };
  }

  // ── Stop loss (instant close) ──
  // Optionally gated on the position having broken out of range to the
  // downside ("OOR kiri" — active bin fell below lower_bin), so a PnL dip
  // that's still inside range doesn't get stopped out.
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    const oorLeftOk = !mgmtConfig.stopLossRequireOorLeft || oor_side === "below";
    if (oorLeftOk) {
      return {
        action: "STOP_LOSS",
        reason:
          `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%` +
          (mgmtConfig.stopLossRequireOorLeft ? " (OOR kiri confirmed)" : ""),
      };
    }
  }

  // ── Trailing TP ──
  // Same dual-side exclusion as the activation check above.
  if (
    !pnl_pct_suspicious &&
    pos.trailing_active &&
    !(mgmtConfig.dualSideEnabled && isDualSideAtOpen) &&
    currentPnlPct != null
  ) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
      };
    }
  }

  // ── Out of range too long ──
  // outOfRangeRequireLeft: when true, only a sustained "OOR kiri" (price
  // broke below range — bearish for the base/memecoin side) counts toward
  // the wait timer. A bullish breakout to the upside (OOR kanan) is left
  // alone here — that's often a good outcome, not a reason to force-close.
  if (mgmtConfig.outOfRangeExitEnabled) {
    const since = mgmtConfig.outOfRangeRequireLeft ? pos.oor_left_since : pos.out_of_range_since;
    if (since) {
      const minutesOOR = Math.floor((Date.now() - new Date(since).getTime()) / 60000);
      if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
        return {
          action: "OUT_OF_RANGE",
          reason:
            `Out of range${mgmtConfig.outOfRangeRequireLeft ? " (kiri)" : ""} for ${minutesOOR}m` +
            ` (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
        };
      }
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ──
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    mgmtConfig.lowYieldExitEnabled !== false &&
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

export function recordClose(position_address, action, reason, pnlPct = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.close_action = action || null;
  pos.close_reason = reason || null;
  pos.close_pnl_pct = pnlPct;
  save(state);
  log("state", `Position ${position_address.slice(0, 8)} marked closed: ${reason}`);
}

/**
 * Track a token mint whose post-close auto-swap-to-SOL failed after all
 * retries, so a periodic sweep (see actions.js's sweepPendingSwaps) can
 * keep trying later instead of leaving it stuck in the wallet forever.
 */
export function recordFailedSwap(mint) {
  if (!mint) return;
  const state = load();
  const existing = state.pendingSwaps[mint];
  state.pendingSwaps[mint] = {
    mint,
    first_failed_at: existing?.first_failed_at || new Date().toISOString(),
    last_attempt_at: new Date().toISOString(),
    attempts: (existing?.attempts ?? 0) + 1,
  };
  save(state);
}

/** Clear a mint from the pending-swap list once it swaps successfully. */
export function clearFailedSwap(mint) {
  if (!mint) return;
  const state = load();
  if (state.pendingSwaps[mint]) {
    delete state.pendingSwaps[mint];
    save(state);
  }
}

/** All mints currently waiting on a retry swap. */
export function getPendingSwapMints() {
  const state = load();
  return Object.keys(state.pendingSwaps);
}

