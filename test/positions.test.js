/**
 * positions.js transitively imports client.js -> config.js, which requires
 * WALLET_PRIVATE_KEY/RPC_URL (else process.exit(1)). Same throwaway-keypair
 * pattern as the other tests — no network call happens on import.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "https://example.invalid";

const { isSolQuotePool, resolveUseSol } = await import("../positions.js");

test("isSolQuotePool recognizes SOL by symbol or mint, and reports unknown as null", () => {
  assert.equal(isSolQuotePool({ tokenY: "SOL" }), true);
  assert.equal(isSolQuotePool({ tokenY: "wSOL" }), true);
  assert.equal(isSolQuotePool({ tokenY: "USDC" }), false);
  assert.equal(isSolQuotePool({ tokenYMint: "So11111111111111111111111111111111111111112" }), true);
  assert.equal(isSolQuotePool({ tokenYMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), false);
  assert.equal(isSolQuotePool({}), null);
});

test("resolveUseSol with basisAuto measures each pool in its own quote currency, whatever solMode says", () => {
  assert.equal(resolveUseSol({ tokenY: "SOL" }, { solMode: false, basisAuto: true }), true);
  assert.equal(resolveUseSol({ tokenY: "USDC" }, { solMode: true, basisAuto: true }), false);
});

test("resolveUseSol falls back to the global solMode when basisAuto is off or the quote token is unknown", () => {
  assert.equal(resolveUseSol({ tokenY: "USDC" }, { solMode: true, basisAuto: false }), true);
  assert.equal(resolveUseSol({ tokenY: "SOL" }, { solMode: false, basisAuto: false }), false);
  assert.equal(resolveUseSol({}, { solMode: true, basisAuto: true }), true);
  assert.equal(resolveUseSol({}, { solMode: false, basisAuto: true }), false);
});
