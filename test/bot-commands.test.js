/**
 * bot-commands.js transitively imports client.js -> config.js, which
 * requires WALLET_PRIVATE_KEY/RPC_URL to be set (else process.exit(1)) and
 * a valid user-config.json (the real one committed to this repo already
 * satisfies the required-threshold check). We supply a throwaway generated
 * keypair and a fake RPC URL — no network call happens just from importing
 * these modules or calling buildPnlStatsText, which only touches state.js.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_STATE_FILE = path.join(__dirname, ".test-state-botcommands.json");
process.env.EXIT_BOT_STATE_FILE = TEST_STATE_FILE;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "https://example.invalid";

function resetStateFile() {
  if (fs.existsSync(TEST_STATE_FILE)) fs.unlinkSync(TEST_STATE_FILE);
  const bak = TEST_STATE_FILE + ".bak";
  if (fs.existsSync(bak)) fs.unlinkSync(bak);
}
resetStateFile();

const { ensurePositionTracked, recordClose } = await import("../state.js");
const { buildPnlStatsText } = await import("../bot-commands.js");

test("buildPnlStatsText reports no data when nothing closed yet", () => {
  const text = buildPnlStatsText();
  assert.match(text, /Belum ada posisi yang closed/);
});

test("buildPnlStatsText computes win rate, averages, and action breakdown correctly", () => {
  ensurePositionTracked("posWin1", {});
  recordClose("posWin1", "TRAILING_TP", "test", 5);
  ensurePositionTracked("posWin2", {});
  recordClose("posWin2", "TAKE_PROFIT", "test", 3);
  ensurePositionTracked("posLoss1", {});
  recordClose("posLoss1", "STOP_LOSS", "test", -6);

  const text = buildPnlStatsText();
  assert.match(text, /Total posisi closed: 3/);
  assert.match(text, /2W \/ 1L/);
  assert.match(text, /66\.7%/); // win rate: 2/3
  assert.match(text, /\+4\.00%/); // avg win: (5+3)/2
  assert.match(text, /-6\.00%/); // avg loss
  assert.match(text, /TRAILING_TP: 1x/);
  assert.match(text, /STOP_LOSS: 1x/);
});

after(resetStateFile);
