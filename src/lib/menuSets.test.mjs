import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const exports = {};
vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL("./menuSets.ts", import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7 } }).outputText, { exports });
const { menuSaleIssue, setDescription, setChanged } = exports;
const component = { id: "cola", name: "콜라", menu_type: "component", is_sold_out: false };
const set = { id: "set", name: "콜라 2개", menu_type: "set", set_components: [{ menu_id: "cola", quantity: 2 }] };
test("component-only menus are not sold directly but can fulfill an available set", () => {
  const menus = new Map([[component.id, component], [set.id, set]]);
  assert.equal(menuSaleIssue(component, menus), "판매 중단");
  assert.equal(menuSaleIssue(set, menus), null);
  assert.equal(setDescription(set, menus), "콜라 × 2");
});
test("sold-out, hidden, deleted or missing components block the set", () => {
  for (const change of [{ is_sold_out: true }, { is_hidden: true }, { is_deleted: true }, { menu_type: "set" }]) {
    assert.ok(menuSaleIssue(set, new Map([[component.id, { ...component, ...change }]])));
  }
  assert.ok(menuSaleIssue(set, new Map()));
  assert.ok(menuSaleIssue({ ...set, set_components: [] }, new Map()));
});
test("changing a fixed composition requires reviewing the cart again", () => {
  assert.equal(setChanged(set, { ...set }), false);
  assert.equal(setChanged(set, { ...set, set_components: [{ menu_id: "cola", quantity: 3 }] }), true);
  assert.equal(setChanged({ id: "old" }, { id: "old", menu_type: "single", set_components: [] }), false);
});
