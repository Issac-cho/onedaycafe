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
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("./accounting.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: 1, target: 7 },
}).outputText, { exports, require: name => { assert.equal(name, "./couponPayment"); return payment; } });
const { fetchAccountingOrders, accountingDateRange, accountingTotals, accountingOrderAmount } = exports;

test("all registered sale menus are paginated regardless of sold-out/hidden state, excluding deleted and component-only entries", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ name: `메뉴${i}` }));
  const filters = [], ranges = [];
  const query = {
    select(value) { assert.equal(value, "name"); return this; },
    eq(...args) { filters.push(args); return this; }, neq(...args) { filters.push(["neq", ...args]); return this; },
    order(value) { assert.equal(value, "id"); return this; },
    range(start, end) { ranges.push([start, end]); this.start = start; this.end = end; return this; },
    abortSignal() { return Promise.resolve({ data: rows.slice(this.start, this.end + 1), error: null }); },
  };
  const names = await exports.fetchAccountingMenus({ from(table) { assert.equal(table, "menus"); return query; } }, "store", new AbortController().signal);
  assert.equal(names.length, 501); assert.deepEqual(ranges, [[0, 499], [500, 999]]);
  assert.ok(filters.some(([key, value]) => key === "store_id" && value === "store"));
  assert.ok(filters.some(([key, value]) => key === "is_deleted" && value === false));
  assert.ok(filters.some(([op, key, value]) => op === "neq" && key === "menu_type" && value === "component"));
  assert.ok(!filters.some(args => args.includes("is_hidden") || args.includes("is_sold_out")));
  assert.equal(exports.accountingClipboardColumns([], [], names).length, 501);
});

test("orders are paginated past 1000 in receipt order and scoped to the store and Korean business day", async () => {
  const rows = Array.from({ length: 1201 }, (_, id) => ({ id }));
  const filters = [], ranges = [];
  const query = {
    select(columns) { assert.ok(columns.includes("sales:order_sales")); assert.ok(!columns.includes("order_items")); return this; },
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

test("clipboard data has one order per row, numeric payments and columns matching the copyable headers", () => {
  const order = { order_number: 123, created_at: "2026-11-03T15:10:00Z", table_number: "=1+1", status: "completed", payment_method: "쿠폰+현금",
    customer_type: "지체 손님", customer_name: "손님\t이름\n둘째줄", member_name: "@소개자", coupon_used: 5000, cash_due: 30000, cash_received: 35000, coupon_credited: 5000,
    sales: [{ menu_name: "필라프 세트", menu_price: 15000, quantity: 2, option_summary: "음료: 콜라\n사이다", components: [{ menu_name: "필라프", quantity: 1 }] },
      { menu_name: "크로플", menu_price: 5000, quantity: 1, option_summary: "", components: [] }],
  };
  const columns = exports.accountingClipboardColumns([order]);
  const text = exports.accountingOrderTsv(order, columns), cells = text.split("\t");
  assert.equal(cells.length, exports.accountingClipboardHeaders(columns).split("\t").length);
  assert.equal(cells.length, 16); assert.ok(!/[\r\n]/.test(text));
  assert.equal(cells[0], "123"); assert.ok(cells[1].startsWith("2026-11-04 00:10:00"));
  assert.equal(cells[2], "'=1+1"); assert.equal(cells[3], "지인 소개"); assert.equal(cells[4], "손님 이름 둘째줄"); assert.equal(cells[5], "'@소개자");
  assert.ok(cells[6].includes("필라프 세트 × 2")); assert.ok(cells[6].includes("크로플 × 1")); assert.ok(cells[6].includes("음료: 콜라 사이다"));
  assert.deepEqual(cells.slice(8, 13), ["35000", "5000", "30000", "35000", "5000"]);
  assert.equal(cells[13], "주문 완료");
  assert.ok(!cells[6].includes("단가")); assert.ok(!cells[6].includes("금액")); assert.ok(!cells[6].includes("세트 1개 구성"));
  assert.equal(exports.accountingOrderTsv({ ...order, cash_received: null }, columns).split("\t")[11], "미기록");
});

test("each menu has one column with option counts inside its cell and sets stay whole", () => {
  const makeSale = (name, options, quantity) => ({ menu_name: name, option_summary: options, quantity, menu_price: 5000, components: [] });
  const order = { order_number: 1, created_at: "2026-11-04T01:00:00Z", sales: [
    makeSale("아메리카노", "온도: 아이스", 2), makeSale("아메리카노", "온도: 핫", 1), makeSale("아메리카노", "온도: 아이스", 3),
    { ...makeSale("필라프 세트", "탄산: 종류: 콜라", 2), components: [{ menu_name: "필라프", quantity: 1 }, { menu_name: "콜라", quantity: 1 }] },
  ] };
  const columns = exports.accountingClipboardColumns([order]);
  assert.equal(columns.length, 2);
  assert.ok(!columns.some(c => c.menu === "필라프" || c.menu === "콜라"));
  const quantities = exports.accountingOrderTsv(order, columns).split("\t").slice(14);
  assert.equal(quantities[columns.findIndex(c => c.menu === "아메리카노")], "아이스 : 5, 핫 : 1");
  assert.equal(quantities[columns.findIndex(c => c.menu === "필라프 세트")], "탄산: 콜라 : 2");
  assert.equal(exports.accountingClipboardHeaders(columns).split("\t").slice(14).join(","), "아메리카노,필라프 세트");
  const newer = { ...order, order_number: 2, sales: [makeSale("가장 나중에 추가된 메뉴", "", 1)] };
  const expanded = exports.accountingClipboardColumns([newer, order], columns);
  assert.equal(JSON.stringify(expanded.slice(0, 2)), JSON.stringify(columns));
  assert.equal(expanded[2].menu, "가장 나중에 추가된 메뉴");
  assert.equal(exports.accountingOrderTsv(order, expanded).split("\t").at(-1), "0");
  assert.throws(() => exports.accountingOrderTsv(newer, columns), /메뉴 열이 누락/);
  assert.equal(JSON.stringify(exports.parseAccountingClipboardColumns(JSON.stringify(expanded))), JSON.stringify(expanded));
  assert.throws(() => exports.parseAccountingClipboardColumns('[{"menu":1}]'), /잘못된/);
});

test("clipboard option labels omit group names while keeping set component names and combination counts", () => {
  const set = { menu_name: "필라프 + 탄산", menu_price: 15000, quantity: 1, components: [{ menu_name: "필라프", quantity: 1 }, { menu_name: "탄산음료 1개", quantity: 1 }] };
  const order = { order_number: 1, created_at: "2026-11-04T01:00:00Z", sales: [
    { ...set, option_summary: "필라프: 종류: 게살 · 탄산음료 1개: 종류: 사이다" },
    { ...set, option_summary: "필라프: 종류: 게살 · 탄산음료 1개: 종류: 콜라", quantity: 2 },
    { menu_name: "라떼", menu_price: 5000, quantity: 1, option_summary: "온도: 아이스, 시럽: 바닐라", components: [] },
  ] };
  const columns = exports.accountingClipboardColumns([order]);
  const cells = exports.accountingOrderTsv(order, columns).split("\t");
  const setCell = cells[14 + columns.findIndex(c => c.menu === set.menu_name)];
  assert.ok(setCell.includes("필라프: 게살, 탄산음료 1개: 사이다 : 1"));
  assert.ok(setCell.includes("필라프: 게살, 탄산음료 1개: 콜라 : 2"));
  assert.equal(cells[14 + columns.findIndex(c => c.menu === "라떼")], "아이스, 바닐라 : 1");
  for (const index of [6, 14, 15]) {
    assert.ok(!cells[index].includes("종류:")); assert.ok(!cells[index].includes("온도:")); assert.ok(!cells[index].includes("시럽:"));
  }
});

test("two-choice fish bread combinations are counted as bundles within a single menu cell", () => {
  const order = { order_number: 1, created_at: "2026-11-04T01:00:00Z", sales: [
    { menu_name: "붕어빵 2개", menu_price: 5000, quantity: 1, option_summary: "맛: 팥 / 팥", components: [] },
    { menu_name: "붕어빵 2개", menu_price: 5000, quantity: 2, option_summary: "맛: 팥 / 슈크림", components: [] },
    { menu_name: "크로플", menu_price: 5000, quantity: 3, option_summary: "", components: [] },
  ] };
  const columns = exports.accountingClipboardColumns([order]);
  const cells = exports.accountingOrderTsv(order, columns).split("\t").slice(14);
  const fish = cells[columns.findIndex(c => c.menu === "붕어빵 2개")];
  assert.ok(fish.includes("팥/팥 : 1")); assert.ok(fish.includes("팥/슈크림 : 2"));
  assert.equal(cells[columns.findIndex(c => c.menu === "크로플")], "3");
  assert.equal(exports.accountingOrderAmount(order), 30000);
  const updated = { ...order, sales: [...order.sales, { ...order.sales[0], option_summary: "맛: 피자 / 피자" }] };
  assert.equal(exports.accountingClipboardColumns([updated], columns).length, columns.length);
});
