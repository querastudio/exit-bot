/**
 * exit-bot — standalone Meteora DLMM exit manager.
 *
 * Fully standalone: own wallet, own RPC, own Telegram bot, own state file.
 * Only job: watch open positions for this wallet and close them on
 * take-profit / stop loss / trailing TP / out-of-range / low yield — plus
 * a Telegram menu (/positions) for manual control.
 *
 * No screening, no deploy, no LLM.
 *
 * Run:
 *   node index.js
 *   pm2 start index.js --name exit-bot
 */
import { wallet } from "./client.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { fetchOpenPositions } from "./positions.js";
import {
  ensurePositionTracked,
  confirmPeak,
  registerExitSignal,
  updatePnlAndCheckExits,
  detectTopup,
  detectPnlSpike,
  inGracePeriod,
  isTopupSettling,
  consumeRecoveryAlert,
} from "./state.js";
import { telegramEnabled, sendTelegram } from "./telegram.js";
import { performClose, sweepPendingSwaps } from "./actions.js";
import { startTelegramBot } from "./bot-commands.js";
import { markTick } from "./status.js";

const POLL_MS = config.poll.intervalSec * 1000;

log("exit-bot", `Wallet: ${wallet.publicKey.toString()}`);
log("exit-bot", `Telegram notifications: ${telegramEnabled() ? "enabled" : "DISABLED (missing token/chat id)"}`);
log("exit-bot", `Polling every ${POLL_MS}ms, confirmTicks=${config.management.confirmTicks}`);

let ticking = false;
let heartbeatSkip = 0;
let sweepSkip = 0;
const SWEEP_EVERY_N_TICKS = 20; // ~1min at the default 3s poll interval

// ── Meteora API health tracking ──
// fetchOpenPositions is the bot's only window into position state (it reads
// off Meteora's indexer API, not on-chain directly — see positions.js). If
// that API is down or unreachable, the bot silently can't see anything to
// protect, but would otherwise just log a warning per tick and look
// "running" from the outside. Alert once after enough consecutive failures
// to rule out a single blip, and once more when it recovers.
const API_FAILURE_ALERT_THRESHOLD = 20; // ~1min at the default 3s poll interval
let consecutiveFetchFailures = 0;
let apiDownAlerted = false;

async function tick() {
  if (ticking) return; // guard against overlap while a slow close is in-flight
  ticking = true;
  markTick();

  let positions;
  try {
    positions = await fetchOpenPositions(wallet.publicKey.toString(), {
      solMode: config.management.solMode,
      checkDualSided: config.management.dualSideEnabled,
    });
    consecutiveFetchFailures = 0;
    if (apiDownAlerted) {
      apiDownAlerted = false;
      await sendTelegram("✅ Koneksi ke Meteora API pulih — bot kembali memantau posisi normal.").catch(() => {});
    }
  } catch (err) {
    consecutiveFetchFailures++;
    log("exit-bot_error", `Failed to fetch positions (${consecutiveFetchFailures}x in a row): ${err.message}`);
    if (consecutiveFetchFailures === API_FAILURE_ALERT_THRESHOLD) {
      apiDownAlerted = true;
      await sendTelegram(
        `⚠️ Gagal ambil data posisi dari Meteora API ${consecutiveFetchFailures}x berturut-turut ` +
        `(~${Math.round((consecutiveFetchFailures * POLL_MS) / 1000)}s). Bot mungkin TIDAK bisa mendeteksi ` +
        `kondisi exit sampai ini pulih — cek posisi secara manual kalau perlu.`,
      ).catch(() => {});
    }
    ticking = false;
    return;
  }

  try {
    if (positions.length === 0) {
      if (++heartbeatSkip >= 30) {
        heartbeatSkip = 0;
        log("exit-bot", "No open positions");
      }
      return;
    }
    heartbeatSkip = 0;

    for (const p of positions) {
      ensurePositionTracked(p.position, p);
      detectTopup(p.position, p);
      detectPnlSpike(p.position, p.pnl_pct, config.management);

      const settling = isTopupSettling(p.position, p.pnl_pct, config.management);
      if (!inGracePeriod(p.position, config.management.exitGracePeriodSec) && !settling) {
        confirmPeak(p.position, p.pnl_pct, config.management.confirmTicks);
      }

      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      const { fire, action } = registerExitSignal(p.position, exit?.action ?? null, config.management.confirmTicks);

      if (fire) {
        if (config.management.paused) {
          log("exit-bot", `Exit signal ${action} for ${p.pair} suppressed — bot paused`);
        } else {
          await performClose(p, action, exit.reason, { source: "auto" });
        }
        break; // one action per tick
      }
    }
  } catch (err) {
    log("exit-bot_error", `Tick failed: ${err.stack || err.message}`);
  } finally {
    ticking = false;
  }

  if (consumeRecoveryAlert()) {
    await sendTelegram(
      "⚠️ <b>state.json korup terdeteksi</b> — bot otomatis pulih dari backup (state.json.bak). " +
      "Sebagian tracking (peak/trailing) mungkin mundur beberapa detik ke versi backup terakhir, tapi bot tetap jalan normal.",
    ).catch(() => {});
  }

  if (++sweepSkip >= SWEEP_EVERY_N_TICKS) {
    sweepSkip = 0;
    sweepPendingSwaps().catch((err) => log("exit-bot_error", `Pending swap sweep failed: ${err.message}`));
  }
}

log("exit-bot", "exit-bot running...");
tick();
setInterval(tick, POLL_MS);
startTelegramBot();

process.on("SIGINT", () => {
  log("exit-bot", "Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("exit-bot", "Shutting down...");
  process.exit(0);
});
