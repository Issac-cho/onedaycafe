import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(path, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name), Set, Map, ...globals });
  return exports;
}
const { groupServingOrders } = load("./servingOrders.ts");
const item = (id, orderId, status) => ({ id, status, quantity: 2, created_at: "2026-10-30",
  menu: { name: id, kitchen_group: 2 }, order: { id: orderId, order_number: 1, table_number: "3" } });

test("groups by order ID, retains pending and served rows, and only enables completion after all served", () => {
  const groups = groupServingOrders([item("A", "one", "pending"), item("B", "one", "cooked"),
    item("C", "two", "served"), item("D", "one", "served")]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.length, 3);
  assert.equal(groups[0].allServed, false);
  assert.equal(groups[1].allServed, true);
  assert.equal(groupServingOrders([]).length, 0);
});

function page(items, remaining = 0) {
  const updates = [];
  const alerts = [];
  const filters = [];
  let refreshes = 0;
  const query = {
    update(value) { updates.push(value); return this; },
    eq(...args) { filters.push(args); return this; },
    neq(...args) { filters.push(args); return this; },
    select(_columns, options) {
      return options?.head ? this : Promise.resolve({ data: [{ id: "ok" }], error: null });
    },
    then(resolve) { resolve({ count: remaining, error: null }); },
  };
  const { default: Page } = load("../app/[store_id]/server/page.tsx", {
    react: { use: () => ({ store_id: "store" }), useState: value => [value, () => {}] },
    "@/lib/supabase": { supabase: { from: () => query } },
    "@/lib/useOrderQueue": { useOrderQueue: () => ({ items, loading: false, error: null, refresh: () => refreshes++ }) },
    "@/lib/servingOrders": { groupServingOrders },
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/card": { Card: "section", CardContent: "article" },
    "@/components/QueueConnectionStatus": { QueueConnectionStatus: "aside" },
    "@/components/PinLock": { PinLock: "main" },
  }, { alert: message => alerts.push(message), console });
  const tree = Page({ params: Promise.resolve({ store_id: "store" }) });
  function buttons(node) {
    if (Array.isArray(node)) return node.flatMap(buttons);
    if (!node?.props) return [];
    return [...(node.type === "button" ? [node.props] : []), ...buttons(node.props.children)];
  }
  return { buttons: buttons(tree), updates, filters, alerts, get refreshes() { return refreshes; } };
}

test("pending rows are dimmed with disabled cooking buttons; served rows remain visible", () => {
  const app = page([item("A", "one", "pending"), item("B", "one", "cooked"), item("C", "one", "served")]);
  assert.equal(app.buttons[0].children, "조리 중");
  assert.equal(app.buttons[0].disabled, true);
  assert.equal(app.buttons[1].children, "서빙 완료");
  assert.equal(app.buttons[1].disabled, false);
  assert.equal(app.buttons[2].children, "서빙 완료됨");
  assert.equal(app.buttons[2].disabled, true);
  assert.equal(app.buttons[3].disabled, true);
});

test("serving updates just the selected cooked item; completing updates the parent order", async () => {
  const app = page([item("A", "one", "cooked")]);
  await app.buttons[0].onClick();
  assert.equal(app.updates[0].status, "served");
  assert.ok(app.filters.some(([key, value]) => key === "id" && value === "A"));
  assert.ok(app.filters.some(([key, value]) => key === "status" && value === "cooked"));
  assert.equal(app.refreshes, 1);
  const completed = page([item("B", "two", "served")]);
  assert.equal(completed.buttons[1].disabled, false);
  await completed.buttons[1].onClick();
  assert.equal(completed.updates[0].status, "completed");
  assert.equal(completed.refreshes, 1);
});

test("completion rechecks the database and refuses when another item is not served", async () => {
  const app = page([item("A", "one", "served")], 1);
  await app.buttons[1].onClick();
  assert.equal(app.updates.length, 0);
  assert.equal(app.alerts.length, 1);
  assert.equal(app.refreshes, 1);
});
