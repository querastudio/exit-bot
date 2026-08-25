import assert from "node:assert/strict";
import { test } from "node:test";
import { withPriorityFee } from "../close.js";

function fakeTransaction(existingInstructions = []) {
  return { instructions: [...existingInstructions] };
}

test("withPriorityFee prepends a ComputeBudget setComputeUnitPrice instruction when microLamports > 0", () => {
  const tx = fakeTransaction([{ programId: "existing" }]);
  withPriorityFee(tx, 50000);
  assert.equal(tx.instructions.length, 2);
  // ComputeBudgetProgram.programId toString — the priority fee instruction must be first.
  assert.equal(tx.instructions[0].programId.toString(), "ComputeBudget111111111111111111111111111111");
  assert.deepEqual(tx.instructions[1], { programId: "existing" });
});

test("withPriorityFee is a no-op when microLamports is 0 or negative", () => {
  const tx = fakeTransaction([{ programId: "existing" }]);
  withPriorityFee(tx, 0);
  withPriorityFee(tx, -5);
  assert.equal(tx.instructions.length, 1);
});
