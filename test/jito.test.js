import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";

// Point at an unreachable local port so the Jito HTTP calls fail fast and
// deterministically (connection refused), without depending on real network
// access from the test environment.
process.env.JITO_BLOCK_ENGINE_URL = "http://127.0.0.1:1/unreachable";

const { sendTransactionWithOptionalJito } = await import("../jito.js");

test("sendTransactionWithOptionalJito strips the tip instruction before falling back on Jito failure", async () => {
  const wallet = Keypair.generate();
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 }));
  const originalInstructionCount = tx.instructions.length;

  // Fake connection: enough for getLatestBlockhash to succeed so the code
  // reaches the tip-adding step, but everything else (Jito HTTP calls,
  // sendAndConfirmTransaction's fallback) is expected to fail — that's the
  // scenario under test.
  const fakeConnection = {
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111111111111", lastValidBlockHeight: 1 }),
  };

  await assert.rejects(() =>
    sendTransactionWithOptionalJito(fakeConnection, wallet, tx, { jitoEnabled: true, jitoTipLamports: 1000 }),
  );

  // The tip transfer must not survive into the fallback attempt — paying a
  // Jito tip for a transaction that never went through Jito is pure waste.
  assert.equal(tx.instructions.length, originalInstructionCount);
});

test("sendTransactionWithOptionalJito is a pure pass-through when jitoEnabled is false", async () => {
  const wallet = Keypair.generate();
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 }));
  const originalInstructionCount = tx.instructions.length;

  const fakeConnection = {}; // sendAndConfirmTransaction will fail on this — fine, we only check no mutation happened first
  await assert.rejects(() => sendTransactionWithOptionalJito(fakeConnection, wallet, tx, { jitoEnabled: false, jitoTipLamports: 5000 }));

  // Disabled means no dontfront account, no tip — completely untouched.
  assert.equal(tx.instructions.length, originalInstructionCount);
});
