import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const exports = {};
vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL("./couponPayment.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: 1, target: 7 },
}).outputText, { exports });
const { couponPayment, parseWon } = exports;
test("cash blank means exact payment, overpayment becomes credit, explicit zero is not blank", () => {
  assert.equal(couponPayment(8000, 0, "현금", "", "").received, 8000);
  const cash = couponPayment(8000, 0, "현금", "", "10000");
  assert.equal(cash.credited, 2000);
  assert.equal(cash.remaining, 2000);
  assert.throws(() => couponPayment(8000, 0, "현금", "", "0"));
});
test("mixed defaults to maximum available and supports a custom amount and credit", () => {
  const mixed = couponPayment(18000, 10000, "쿠폰+현금", "", "10000");
  assert.equal(mixed.used, 10000); assert.equal(mixed.due, 8000); assert.equal(mixed.remaining, 2000);
  const custom = couponPayment(18000, 10000, "쿠폰+현금", "5000", "15000");
  assert.equal(custom.credited, 2000); assert.equal(custom.remaining, 7000);
  assert.throws(() => couponPayment(18000, 10000, "쿠폰+현금", "11000", ""));
  assert.throws(() => couponPayment(8000, 10000, "쿠폰+현금", "", ""));
});
test("coupon full payment and integer validation", () => {
  assert.equal(couponPayment(18000, 20000, "쿠폰", "", "").remaining, 2000);
  for (const value of ["-1", "1.5", "1e3", " ", "1000000001"]) assert.equal(parseWon(value), null);
  assert.equal(parseWon("0"), 0);
});
