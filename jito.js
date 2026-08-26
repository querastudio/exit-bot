/**
 * MEV protection for close-position transactions using Jito's DontFront
 * feature, per Solana's official guide
 * (solana.com/docs/defi/mev-protection):
 *
 *  - Append a read-only, non-signer account starting with "jitodontfront"
 *    to any instruction. The Jito block engine then guarantees no other
 *    transaction can be placed ahead of this one in any bundle — the
 *    mechanism a sandwich attack (front-run + back-run) depends on. The
 *    account is never read/written on-chain.
 *  - Submit via sendTransaction (not sendBundle) — a single protected
 *    transaction, not a multi-tx bundle with ordering/signer rules to get
 *    right.
 *  - Base64 encoding only — base58 is deprecated in Jito's API.
 *  - Optionally still attach a tip (as a second instruction in the SAME
 *    transaction, no bundle needed) for faster landing during congestion —
 *    per the guide's Best Practices, dontfront and tips are complementary,
 *    not the same thing.
 *
 * Fail-safe by design: disabled (jitoEnabled=false, the default) is a
 * pass-through to the exact same sendAndConfirmTransaction call used
 * before this module existed. When enabled, ANY failure in the Jito path
 * falls back to that same plain send — a Jito outage or bug here can
 * never block a close.
 */
import { PublicKey, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger.js";

const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf/api/v1";
const TIP_ACCOUNT_CACHE_MS = 5 * 60 * 1000;
// Bounds on how long the Jito path is allowed to add on top of a normal
// close before giving up and falling back to a plain send — see the
// bounded-latency incident from the earlier sendBundle attempt.
const JITO_FETCH_TIMEOUT_MS = 5000;
const JITO_CONFIRM_TIMEOUT_MS = 15000;

// Any valid pubkey prefixed "jitodontfront" works — this exact address is
// the example given in Solana's official guide. It's never read or
// written on-chain; only its prefix is inspected by the block engine.
const DONT_FRONT_ACCOUNT = new PublicKey("jitodontfront111111111111111111111111111111");

let cachedTipAccount = null;
let cachedTipAccountAt = 0;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

/** Append the dontfront marker account (read-only, non-signer) to the transaction's first instruction. */
export function withDontFront(transaction) {
  if (transaction.instructions.length > 0) {
    transaction.instructions[0].keys.push({ pubkey: DONT_FRONT_ACCOUNT, isSigner: false, isWritable: false });
  }
  return transaction;
}

/** Fetch a current Jito tip payment account (fetched live, not hardcoded — these addresses are Jito-managed and can change). */
async function getTipAccount() {
  const now = Date.now();
  if (cachedTipAccount && now - cachedTipAccountAt < TIP_ACCOUNT_CACHE_MS) return cachedTipAccount;

  const res = await fetchWithTimeout(
    `${JITO_BLOCK_ENGINE_URL}/bundles`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
    },
    JITO_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`getTipAccounts HTTP ${res.status}`);
  const data = await res.json();
  const accounts = data.result;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("Jito returned no tip accounts");

  cachedTipAccount = accounts[Math.floor(Math.random() * accounts.length)];
  cachedTipAccountAt = now;
  return cachedTipAccount;
}

async function submitTransaction(signedTxBase64) {
  const res = await fetchWithTimeout(
    `${JITO_BLOCK_ENGINE_URL}/transactions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signedTxBase64, { encoding: "base64" }] }),
    },
    JITO_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendTransaction HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`sendTransaction error: ${JSON.stringify(data.error)}`);
  return data.result; // tx signature, base58
}

/**
 * Send `transaction` (a legacy web3.js Transaction, unsigned) protected by
 * Jito's DontFront feature via sendTransaction, optionally with a tip for
 * faster landing, confirming on-chain the normal way afterward. Falls back
 * to a plain sendAndConfirmTransaction if jitoEnabled is false (default)
 * or if anything in the Jito path throws.
 */
export async function sendTransactionWithOptionalJito(connection, wallet, transaction, { jitoEnabled = false, jitoTipLamports = 0 } = {}) {
  if (!jitoEnabled) {
    return sendAndConfirmTransaction(connection, transaction, [wallet]);
  }

  let tipInstructionAdded = false;
  try {
    withDontFront(transaction);

    if (jitoTipLamports > 0) {
      const tipAccount = await getTipAccount();
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(tipAccount),
          lamports: jitoTipLamports,
        }),
      );
      tipInstructionAdded = true;
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    const serialized = transaction.serialize();
    await submitTransaction(serialized.toString("base64"));

    const signature = bs58.encode(transaction.signature);
    const confirmation = await withTimeout(
      connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed"),
      JITO_CONFIRM_TIMEOUT_MS,
      `Jito transaction didn't confirm within ${JITO_CONFIRM_TIMEOUT_MS}ms`,
    );
    if (confirmation.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    log("jito", `Sent via Jito DontFront${jitoTipLamports > 0 ? ` (tip ${jitoTipLamports} lamports)` : ""}, tx: ${signature}`);
    return signature;
  } catch (err) {
    // The tip transfer only makes sense if Jito actually used it — strip it
    // back out before falling back, so a Jito failure never costs a real
    // tip payment for nothing. It's always the last instruction added
    // (nothing is appended after it above), so popping it is exact.
    if (tipInstructionAdded) {
      transaction.instructions.pop();
    }
    log("jito_warn", `Jito path failed (${err.message}) — falling back to normal RPC send`);
    return sendAndConfirmTransaction(connection, transaction, [wallet]);
  }
}
