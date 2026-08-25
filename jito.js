/**
 * Optional Jito bundle submission for close-position transactions.
 *
 * Landing a transaction via a Jito bundle (with a small tip) generally
 * gets it included faster and more reliably during congestion than a
 * plain RPC broadcast, which shrinks the window between an exit signal
 * firing and the close actually confirming on-chain — the same window
 * that lets realized PnL slip past the configured SL during a fast move.
 *
 * Strictly additive and fail-safe: when disabled (jitoTipLamports <= 0,
 * the default), this is a pass-through to the exact same
 * sendAndConfirmTransaction call used before this module existed. When
 * enabled, ANY failure in the Jito path (tip account fetch, bundle
 * submission, etc.) falls back to that same plain send — a Jito outage
 * or bug here can never block a close.
 */
import { PublicKey, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger.js";

const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf/api/v1";
const TIP_ACCOUNT_CACHE_MS = 5 * 60 * 1000;

let cachedTipAccount = null;
let cachedTipAccountAt = 0;

/** Fetch a current Jito tip payment account (fetched live, not hardcoded — these addresses are Jito-managed and can change). */
async function getTipAccount() {
  const now = Date.now();
  if (cachedTipAccount && now - cachedTipAccountAt < TIP_ACCOUNT_CACHE_MS) return cachedTipAccount;

  const res = await fetch(`${JITO_BLOCK_ENGINE_URL}/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
  });
  if (!res.ok) throw new Error(`getTipAccounts HTTP ${res.status}`);
  const data = await res.json();
  const accounts = data.result;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("Jito returned no tip accounts");

  cachedTipAccount = accounts[Math.floor(Math.random() * accounts.length)];
  cachedTipAccountAt = now;
  return cachedTipAccount;
}

async function submitBundle(signedTxBase64) {
  const res = await fetch(`${JITO_BLOCK_ENGINE_URL}/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[signedTxBase64], { encoding: "base64" }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendBundle HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`sendBundle error: ${JSON.stringify(data.error)}`);
  return data.result; // bundle id
}

/**
 * Send `transaction` (a legacy web3.js Transaction, unsigned) via a
 * single-transaction Jito bundle with a tip attached, confirming on-chain
 * the normal way afterward. Falls back to a plain sendAndConfirmTransaction
 * if jitoTipLamports <= 0 (feature disabled) or if anything in the Jito
 * path throws.
 */
export async function sendTransactionWithOptionalJito(connection, wallet, transaction, { jitoTipLamports = 0 } = {}) {
  if (!jitoTipLamports || jitoTipLamports <= 0) {
    return sendAndConfirmTransaction(connection, transaction, [wallet]);
  }

  try {
    const tipAccount = await getTipAccount();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: jitoTipLamports,
      }),
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    const serialized = transaction.serialize();
    await submitBundle(serialized.toString("base64"));

    const signature = bs58.encode(transaction.signature);
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    log("jito", `Sent via Jito bundle (tip ${jitoTipLamports} lamports), tx: ${signature}`);
    return signature;
  } catch (err) {
    log("jito_warn", `Jito bundle path failed (${err.message}) — falling back to normal RPC send`);
    return sendAndConfirmTransaction(connection, transaction, [wallet]);
  }
}
