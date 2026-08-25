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
function isRetryableRpcError(err) {
  const msg = String(err?.message || err || "");
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|timeout|429|failed to fetch|5\d\d/i.test(msg);
}

/**
 * Wrap a Connection so every method call falls back to `fallback` on a
 * network-level failure. Transparent to callers — they keep using
 * `connection.getBalance(...)`, `connection.getAccountInfo(...)`, etc.
 * exactly as before. Methods are invoked with `target` as `this` (via
 * .apply) so the real Connection instance's internal state/private fields
 * stay intact — the proxy never becomes `this` inside Connection's own code.
 */
function withRpcFallback(target, fallback) {
  if (!fallback) return target;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return async function (...args) {
        try {
          return await value.apply(obj, args);
        } catch (err) {
          if (!isRetryableRpcError(err)) throw err;
          log("rpc_warn", `Primary RPC call ${String(prop)}() failed (${err.message}) — retrying via fallback RPC`);
          const fallbackFn = fallback[prop];
          if (typeof fallbackFn !== "function") throw err;
          return await fallbackFn.apply(fallback, args);
        }
      };
    },
  });
}

export const connection = withRpcFallback(primaryConnection, fallbackConnection);
