/**
 * actions.js transitively imports client.js -> config.js, which requires
 * WALLET_PRIVATE_KEY/RPC_URL (else process.exit(1)). Same throwaway-keypair
 * pattern as test/bot-commands.test.js — no network call happens just from
 * importing or calling formatSolLamports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "https://example.invalid";

const { formatSolLamports } = await import("../actions.js");

test("formatSolLamports converts lamports to a SOL display string", () => {
  assert.equal(formatSolLamports(123400000), "◎0.1234");
  assert.equal(formatSolLamports("500000000"), "◎0.5000");
});

test("formatSolLamports returns null for missing or non-numeric input", () => {
  assert.equal(formatSolLamports(null), null);
  assert.equal(formatSolLamports(undefined), null);
  assert.equal(formatSolLamports("not-a-number"), null);
});
