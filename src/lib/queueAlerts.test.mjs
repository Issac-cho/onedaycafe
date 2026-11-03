import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const exports = {};
vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL("./queueAlerts.ts", import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7 } }).outputText, { exports });
const { createQueueAlertTracker } = exports;
const item = (id, cooked = 0, served = 0) => ({ id, cooked_quantity: cooked, served_quantity: served });
test("kitchen starts silently, alerts for new work and does not repeat on refresh or recovery", () => {
  const update = createQueueAlertTracker("chef");
  assert.equal(update([item("old")]), false);
  assert.equal(update([item("old"), item("new")]), true);
  assert.equal(update([item("old"), item("new", 1)]), false);
  assert.equal(update([]), false);
  assert.equal(update([item("old"), item("new", 1)]), false);
});
test("serving alerts on partial cooking increments, not serving clicks or unchanged polls", () => {
  const update = createQueueAlertTracker("server");
  assert.equal(update([item("food")]), false);
  assert.equal(update([item("food", 1)]), true);
  assert.equal(update([item("food", 1)]), false);
  assert.equal(update([item("food", 1, 1)]), false);
  assert.equal(update([item("food", 2, 1)]), true);
  assert.equal(update([item("food", 2, 2)]), false);
});
test("new cooked rows alert, fully served rows and stale counters do not", () => {
  const update = createQueueAlertTracker("server");
  assert.equal(update([]), false);
  assert.equal(update([item("ready", 2)]), true);
  assert.equal(update([item("ready", 1)]), false);
  assert.equal(update([item("ready", 2)]), false);
  assert.equal(update([item("done", 2, 2)]), false);
});
