/**
 * client.js requires WALLET_PRIVATE_KEY/RPC_URL (else process.exit(1)), same
 * throwaway-keypair pattern as the other tests — no real network call
 * happens just from importing it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "https://example.invalid";
process.env.RPC_URL_FALLBACK = "https://example-fallback.invalid";

const { fallbackConnection, isRetryableRpcError } = await import("../client.js");

test("fallbackConnection is exported as a raw Connection when RPC_URL_FALLBACK is set", () => {
  assert.ok(fallbackConnection, "fallbackConnection should not be null when RPC_URL_FALLBACK is configured");
  // Must be usable directly by SDK calls (e.g. DLMM.create) that do their
  // own internal RPC plumbing rather than calling methods on our Proxy —
  // so it needs to be the real Connection instance, not wrapped again.
  assert.equal(typeof fallbackConnection.getAccountInfo, "function");
});

test("isRetryableRpcError treats rate limits and network failures as retryable", () => {
  assert.equal(isRetryableRpcError(new Error("429 Too Many Requests: max usage reached")), true);
  assert.equal(isRetryableRpcError(new Error("fetch failed")), true);
  assert.equal(isRetryableRpcError(new Error("ECONNRESET")), true);
  assert.equal(isRetryableRpcError(new Error("500 Internal Server Error")), true);
});

test("isRetryableRpcError treats application-level errors as non-retryable", () => {
  assert.equal(isRetryableRpcError(new Error("insufficient funds for rent")), false);
  assert.equal(isRetryableRpcError(new Error("custom program error: 0x1")), false);
});
