/**
 * Singleton wallet + RPC connection, shared by the autonomous tick loop
 * and the Telegram command handlers so there's only ever one of each.
 *
 * Supports an optional fallback RPC (RPC_URL_FALLBACK): if a call on the
 * primary connection fails with a network/server-level error (timeout,
 * connection reset, 5xx/429, etc.), it's retried once against the fallback
 * connection. Application-level errors (bad transaction, insufficient
 * funds, program errors, etc.) are NOT retried — those aren't RPC problems,
 * retrying them against a different node wouldn't help and could mask the
 * real issue.
 */
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import "./config.js"; // ensures .env is loaded (and threshold validation runs) before we touch process.env
import { log } from "./logger.js";

export const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));

const primaryConnection = new Connection(process.env.RPC_URL, "confirmed");
const fallbackUrl = process.env.RPC_URL_FALLBACK || null;
const fallbackConnection = fallbackUrl ? new Connection(fallbackUrl, "confirmed") : null;

if (fallbackConnection) {
  log("exit-bot", "Fallback RPC configured — will retry network-level RPC failures against it");
}

/** Network/server-level failure — worth retrying against a different RPC. */
export function isRetryableRpcError(err) {
  const msg = String(err?.message || err || "");
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|timeout|429|failed to fetch|5\d\d/i.test(msg);
}

// Circuit breaker: once the primary RPC fails CIRCUIT_BREAKER_THRESHOLD times
// in a row (e.g. its usage quota is exhausted, not just a transient blip),
// skip trying it entirely for CIRCUIT_BREAKER_COOLDOWN_MS and route straight
// to the fallback. Each call against a dead primary still burns ~7.5s in
// @solana/web3.js's own internal 429 retry-with-backoff (500/1000/2000/4000ms)
// before our catch block even runs, so once we know it's down there's no
// point paying that tax on every single call until it's had time to recover.
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
let consecutivePrimaryFailures = 0;
let primaryDownUntil = 0;

/**
 * Wrap a Connection so every method call falls back to `fallback` on a
 * network-level failure. Transparent to callers — they keep using
 * `connection.getBalance(...)`, `connection.getAccountInfo(...)`, etc.
 * exactly as before. Methods are invoked with `target` as `this` (via
 * .apply) so the real Connection instance's internal state/private fields
 * stay intact — the proxy never becomes `this` inside Connection's own code.
 */
export function withRpcFallback(target, fallback) {
  if (!fallback) return target;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return async function (...args) {
        const fallbackFn = fallback[prop];
        if (Date.now() < primaryDownUntil && typeof fallbackFn === "function") {
          return await fallbackFn.apply(fallback, args);
        }
        try {
          const result = await value.apply(obj, args);
          consecutivePrimaryFailures = 0;
          return result;
        } catch (err) {
          if (!isRetryableRpcError(err)) throw err;
          consecutivePrimaryFailures++;
          if (consecutivePrimaryFailures >= CIRCUIT_BREAKER_THRESHOLD && Date.now() >= primaryDownUntil) {
            primaryDownUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
            log(
              "rpc_warn",
              `Primary RPC failed ${consecutivePrimaryFailures}x in a row (${err.message}) — routing straight to fallback RPC for the next ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`,
            );
          } else {
            log("rpc_warn", `Primary RPC call ${String(prop)}() failed (${err.message}) — retrying via fallback RPC`);
          }
          if (typeof fallbackFn !== "function") throw err;
          return await fallbackFn.apply(fallback, args);
        }
      };
    },
  });
}

export const connection = withRpcFallback(primaryConnection, fallbackConnection);

// Raw (non-proxied) fallback connection, exported for call sites that need
// to retry a whole SDK call (e.g. DLMM.create) against the fallback RPC
// directly — the @meteora-ag/dlmm/@coral-xyz/anchor SDK does its own
// internal RPC plumbing from the connection it's given, so wrapping the
// connection object in a per-method Proxy doesn't catch failures that
// happen inside SDK-internal calls the Proxy never sees invoked on `connection`.
export { fallbackConnection };
