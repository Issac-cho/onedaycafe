import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const payment = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("./couponPayment.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: 1, target: 7 },
}).outputText, { exports: payment });
const csv = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("./orderCsv.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: 1, target: 7 },
}).outputText, { exports: csv, require: () => payment });
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("./accounting.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: 1, target: 7 },
}).outputText, { exports, require: name => { assert.equal(name, "./orderCsv"); return csv; } });
const { fetchAccountingOrders, accountingDateRange, accountingTotals, accountingOrderAmount } = exports;

test("orders are paginated past 1000 in receipt order and scoped to the store and Korean business day", async () => {
  const rows = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const filters = [], ranges = [];
  const query = {
    select(columns) { assert.ok(columns.includes("sales:order_sales")); assert.ok(columns.includes("items:order_items(status)")); return this; },
    eq(...args) { filters.push(args); return this; },
    gte(...args) { filters.push(["gte", ...args]); return this; },
    lt(...args) { filters.push(["lt", ...args]); return this; },
    order(key, options) { assert.equal(key, "order_number"); assert.equal(options.ascending, true); return this; },
    range(start, end) { ranges.push([start, end]); this.start = start; this.end = end; return this; },
    abortSignal(signal) { assert.ok(signal instanceof AbortSignal); return Promise.resolve({ data: rows.slice(this.start, this.end + 1), error: null }); },
  };
  const orders = await fetchAccountingOrders({ from(table) { assert.equal(table, "orders"); return query; } }, "store", "2026-11-04", new AbortController().signal);
  assert.equal(orders.length, 1201);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.ok(filters.every(([key, value]) => key !== "store_id" || value === "store"));
  assert.ok(filters.some(([op, key, value]) => op === "gte" && key === "created_at" && value === "2026-11-03T15:00:00.000Z"));
  assert.ok(filters.some(([op, key, value]) => op === "lt" && key === "created_at" && value === "2026-11-04T15:00:00.000Z"));
  assert.equal(accountingDateRange("2026-12-31").end, "2026-12-31T15:00:00.000Z");
});

test("all-time lookup skips the date filter and query failures propagate rather than returning an empty ledger", async () => {
  const query = {
    select() { return this; }, eq() { return this; }, order() { return this; }, range() { return this; },
    abortSignal() { return Promise.resolve({ data: null, error: new Error("offline") }); },
  };
  await assert.rejects(fetchAccountingOrders({ from: () => query }, "store", "", new AbortController().signal), /offline/);
});

test("set revenue and order-level payments are counted once, overpayments remain coupon credits", () => {
  const order = { sales: [{ menu_price: 15000, quantity: 2 }, { menu_price: 5000, quantity: 1 }],
    coupon_used: 5000, cash_due: 30000, cash_received: 35000, coupon_credited: 5000 };
  assert.equal(accountingOrderAmount(order), 35000);
  const total = accountingTotals([order, { ...order, sales: [{ menu_price: 5000, quantity: 1 }], coupon_used: 0, cash_due: 5000, cash_received: 5000, coupon_credited: 0 }]);
  assert.equal(total.amount, 40000); assert.equal(total.coupon, 5000);
  assert.equal(total.cashDue, 35000); assert.equal(total.cashReceived, 40000); assert.equal(total.credited, 5000);
  assert.equal(accountingTotals([{ ...order, cash_received: null }]).cashReceived, null);
  assert.equal(accountingTotals([{ ...order, sales: [] }]).amount, null);
});

test("the accounting table renders one order row with separate sale and payment amounts", () => {
  const component = {};
  const dependencies = {
    "@/lib/accounting": exports,
    "@/lib/orderCsv": csv,
    "@/lib/couponPayment": { customerTypeLabel: type => type === "지체 손님" ? "지인 소개" : type },
    "@/lib/useAccountingOrders": {}, "@/components/ui/input": {}, "@/components/ui/label": {},
    "@/components/ui/button": { Button: "button" }, "@/components/QueueConnectionStatus": {},
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../components/AccountingDashboard.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: 1, target: 7, jsx: 4 },
  }).outputText, { exports: component, require: name => dependencies[name] ?? require(name) });
  const html = require("react-dom/server").renderToStaticMarkup(component.AccountingTable({ orders: [{
    id: "order", order_number: 123, table_number: "야외-1", created_at: "2026-11-03T15:10:00Z", status: "completed", payment_method: "쿠폰+현금",
    customer_type: "지체 손님", customer_name: "손님", member_name: "소개자", coupon_used: 5000, cash_due: 30000, cash_received: 35000, coupon_credited: 5000,
    sales: [{ id: "sale1", menu_name: "필라프 세트", menu_price: 15000, quantity: 2, option_summary: "음료: 콜라", components: [{ menu_name: "필라프", quantity: 1 }, { menu_name: "탄산", quantity: 1 }] },
      { id: "sale2", menu_name: "크로플", menu_price: 5000, quantity: 1, option_summary: "", components: [] }],
  }], onCopy() {}, copiedId: null, copying: false }));
  assert.equal((html.match(/<tr[ >]/g) ?? []).length, 2);
  for (const text of ["123번", "야외-1", "지인 소개", "음료: 콜라", "세트 1개 구성", "35,000원", "30,000원", "주문 완료"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes('aria-label="123번 주문 복사"'));
});

test("accounting pages show the largest numbers first and render at most 30 orders", () => {
  const orders = Array.from({ length: 65 }, (_, i) => ({ order_number: i + 1, table_number: "1", customer_name: i < 40 ? "손님" : "다른손님", member_name: "" }));
  const first = exports.accountingPage(orders, "", 1);
  assert.equal(first.orders.length, 30); assert.equal(first.orders[0].order_number, 65); assert.equal(first.orders[29].order_number, 36);
  const second = exports.accountingPage(orders, "", 2);
  assert.equal(second.orders[0].order_number, 35); assert.equal(second.orders[29].order_number, 6);
  const last = exports.accountingPage(orders, "", 3);
  assert.equal(last.orders.length, 5); assert.equal(last.orders[4].order_number, 1);
  assert.equal(exports.accountingPage(orders, "다른손님", 3).current, 1);
  assert.equal(exports.accountingPage(orders, "없음", 1).orders.length, 0);
  assert.equal(orders[0].order_number, 1, "sorting must not mutate the live ledger");
  const updated = exports.accountingPage([...orders, { ...orders[0], order_number: 66 }], "", 1);
  assert.equal(updated.orders[0].order_number, 66); assert.equal(updated.orders.length, 30);
});
