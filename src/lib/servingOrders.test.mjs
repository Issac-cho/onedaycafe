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
const item = (id, orderId, status) => ({ id, status, quantity: 2, served_quantity: status === "served" ? 2 : 0,
  cooked_quantity: status === "pending" ? 0 : 2, created_at: "2026-10-30",
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

function page(items, remaining = 0, conflict = false, role = "server") {
  const updates = [];
  const alerts = [];
  const filters = [];
  let refreshes = 0;
  const query = {
    update(value) { updates.push(value); return this; },
    eq(...args) { filters.push(args); return this; },
    neq(...args) { filters.push(args); return this; },
    select(_columns, options) {
      return options?.head ? this : Promise.resolve({ data: conflict ? [] : [{ id: "ok", ...updates.at(-1) }], error: null });
    },
    then(resolve) { resolve({ count: remaining, error: null }); },
  };
  const { default: Page } = load(`../app/[store_id]/${role}/page.tsx`, {
    react: { use: () => ({ store_id: "store" }), useState: value => [value, () => {}] },
    "@/lib/supabase": { supabase: { from: () => query } },
    "@/lib/useOrderQueue": { useOrderQueue: () => ({ items, loading: false, error: null, refresh: () => refreshes++ }) },
    "@/lib/servingOrders": { groupServingOrders },
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/input": { Input: "input" },
    "@/components/ui/label": { Label: "label" },
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
  assert.match(app.buttons[0]["aria-label"], /조리 중/);
  assert.equal(app.buttons[0].disabled, true);
  assert.match(app.buttons[1]["aria-label"], /서빙 완료 0\/2/);
  assert.equal(app.buttons[1].disabled, false);
  assert.match(app.buttons[2]["aria-label"], /서빙 완료됨/);
  assert.equal(app.buttons[2].disabled, true);
  assert.equal(app.buttons[3].disabled, true);
});

test("serving updates just the selected cooked item; completing updates the parent order", async () => {
  const app = page([item("A", "one", "cooked")]);
  await app.buttons[0].onClick();
  assert.equal(app.updates[0].status, "cooked");
  assert.equal(app.updates[0].served_quantity, 1);
  assert.ok(app.filters.some(([key, value]) => key === "id" && value === "A"));
  assert.ok(app.filters.some(([key, value]) => key === "cooked_quantity" && value === 2));
  assert.ok(app.filters.some(([key, value]) => key === "served_quantity" && value === 0));
  assert.equal(app.refreshes, 1);
  const completed = page([item("B", "two", "served")]);
  assert.equal(completed.buttons[1].disabled, false);
  await completed.buttons[1].onClick();
  assert.equal(completed.updates[0].status, "completed");
  assert.equal(completed.refreshes, 1);
});

test("N items require N successful clicks and the blue fill advances by 1/N", async () => {
  for (let count = 0; count < 3; count++) {
    const current = { ...item("A", "one", "cooked"), quantity: 3, cooked_quantity: 3, served_quantity: count };
    const app = page([current]);
    const button = app.buttons[0];
    assert.equal(button.children[0].props.style.width, `${count / 3 * 100}%`);
    assert.match(button.className, /border-blue-600/);
    await button.onClick();
    assert.equal(app.updates[0].served_quantity, count + 1);
    assert.equal(app.updates[0].status, count === 2 ? "served" : "cooked");
    assert.ok(app.filters.some(([key, value]) => key === "served_quantity" && value === count));
  }
  const done = page([{ ...item("A", "one", "served"), quantity: 3, served_quantity: 3 }]);
  assert.equal(done.buttons[0].disabled, true);
  assert.equal(done.buttons[0].children[0].props.style.width, "100%");
  assert.equal(done.buttons[1].disabled, false);
});

test("one-item menus are fully served with a single click", async () => {
  const app = page([{ ...item("A", "one", "cooked"), quantity: 1, cooked_quantity: 1 }]);
  await app.buttons[0].onClick();
  assert.equal(app.updates[0].status, "served");
  assert.equal(app.updates[0].served_quantity, 1);
});

test("a concurrent update is reported instead of silently claiming the click succeeded", async () => {
  const app = page([item("A", "one", "cooked")], 0, true);
  await app.buttons[0].onClick();
  assert.ok(app.alerts[0].includes("다른 직원"));
  assert.equal(app.refreshes, 1);
  assert.ok(app.filters.some(([key, value]) => key === "served_quantity" && value === 0));
});

test("completion rechecks the database and refuses when another item is not served", async () => {
  const app = page([item("A", "one", "served")], 1);
  await app.buttons[1].onClick();
  assert.equal(app.updates.length, 0);
  assert.equal(app.alerts.length, 1);
  assert.equal(app.refreshes, 1);
});

test("kitchen requires N clicks, fills by 1/N, and changes status only after the final unit", async () => {
  for (let count = 0; count < 3; count++) {
    const current = { ...item("A", "one", "pending"), quantity: 3, cooked_quantity: count };
    const app = page([current], 0, false, "chef");
    assert.equal(app.buttons[0].children[0].props.style.width, `${count / 3 * 100}%`);
    assert.equal(app.buttons[0].disabled, false);
    await app.buttons[0].onClick();
    assert.equal(app.updates[0].cooked_quantity, count + 1);
    assert.equal(app.updates[0].status, count === 2 ? "cooked" : "pending");
    assert.ok(app.filters.some(([key, value]) => key === "cooked_quantity" && value === count));
    assert.equal(app.refreshes, 1);
  }
});

test("kitchen handles single portions and concurrent updates", async () => {
  const single = page([{ ...item("A", "one", "pending"), quantity: 1 }], 0, false, "chef");
  await single.buttons[0].onClick();
  assert.equal(single.updates[0].status, "cooked");
  assert.equal(single.updates[0].cooked_quantity, 1);
  const conflict = page([item("B", "one", "pending")], 0, true, "chef");
  await conflict.buttons[0].onClick();
  assert.ok(conflict.alerts[0].includes("다른 직원"));
});

test("partly cooked menus can be served without removing the remaining kitchen work", async () => {
  const current = { ...item("A", "one", "pending"), quantity: 3, cooked_quantity: 1 };
  const app = page([current]);
  assert.equal(app.buttons[0].disabled, false);
  await app.buttons[0].onClick();
  assert.equal(app.updates[0].served_quantity, 1);
  assert.equal(app.updates[0].status, "pending");
  assert.ok(app.filters.some(([key, value]) => key === "cooked_quantity" && value === 1));
  const waiting = page([{ ...current, served_quantity: 1 }]);
  assert.equal(waiting.buttons[0].disabled, true);
  assert.match(waiting.buttons[0]["aria-label"], /조리 중/);
  assert.equal(waiting.buttons[1].disabled, true);
});
