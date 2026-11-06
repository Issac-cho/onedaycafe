import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7, jsx: 4 } }).outputText;
const payment = {}, accounting = {}, csv = {};
vm.runInNewContext(compile("./couponPayment.ts"), { exports: payment });
vm.runInNewContext(compile("./orderCsv.ts"), { exports: csv, require: () => payment });
vm.runInNewContext(compile("./accounting.ts"), { exports: accounting, require: () => csv });

function mount() {
  const slots = [], writes = [];
  let cursor = 0, failure = false;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  };
  const queue = { orders: Array.from({ length: 65 }, (_, i) => ({
    id: `order-${i + 1}`, order_number: i + 1, table_number: "1", created_at: "2026-11-04T01:00:00Z", customer_name: "손님", customer_type: "개척자", member_name: "",
    status: "received", payment_method: "현금", coupon_used: 0, cash_due: 5000, cash_received: 5000, coupon_credited: 0,
    sales: [{ id: `sale-${i}`, menu_name: "커피", menu_price: 5000, quantity: 1, option_summary: "", components: [] }],
  })), loading: false, connected: true, error: null, lastUpdated: new Date(), refresh() {} };
  const dependencies = {
    react, "@/lib/accounting": accounting, "@/lib/orderCsv": csv, "@/lib/couponPayment": payment,
    "@/lib/useAccountingOrders": { useAccountingOrders: () => queue },
    "@/components/ui/input": { Input: "input" }, "@/components/ui/label": { Label: "label" },
    "@/components/ui/button": { Button: "button" }, "@/components/QueueConnectionStatus": { QueueConnectionStatus: "Connection" },
    "@/components/QueueSoundAlert": { QueueSoundAlert: "QueueSoundAlert" },
  };
  const exports = {};
  vm.runInNewContext(compile("../components/AccountingDashboard.tsx"), {
    exports, require: name => dependencies[name] ?? require(name),
    navigator: { clipboard: { async writeText(text) { if (failure) throw new Error("denied"); writes.push(text); } } },
  });
  function flatten(node, list = []) {
    if (Array.isArray(node)) { node.forEach(child => flatten(child, list)); return list; }
    if (!node?.props) return list;
    list.push(node); flatten(node.props.children, list); return list;
  }
  const Ledger = flatten(exports.AccountingDashboard({ storeId: "store" })).find(node => node.type?.name === "AccountingLedger").type;
  slots.length = 0;
  const render = () => { cursor = 0; return flatten(Ledger({ storeId: "store", date: "2026-11-04" })); };
  return { render, writes, queue, table: () => render().find(node => node.type === exports.AccountingTable), fail() { failure = true; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("ledger only passes 30 newest orders to the table, next/latest work and search resets pagination", () => {
  const app = mount();
  assert.equal(app.table().props.orders.length, 30); assert.equal(app.table().props.orders[0].order_number, 65);
  app.render().find(n => n.type === "button" && n.props.children === "다음").props.onClick();
  assert.equal(app.table().props.orders[0].order_number, 35);
  app.render().find(n => n.type === "button" && n.props.children === "최신").props.onClick();
  assert.equal(app.table().props.orders[0].order_number, 65);
  app.render().find(n => n.type === "button" && n.props.children === "다음").props.onClick();
  app.render().find(n => n.props.id === "accounting-search").props.onChange({ target: { value: "65" } });
  assert.equal(app.table().props.orders.length, 1); assert.equal(app.table().props.orders[0].order_number, 65);
  assert.equal(app.render().find(n => n.type === "QueueSoundAlert").props.items, app.queue.orders);
});

test("clipboard headers and multiple sale rows match the closing CSV", async () => {
  const app = mount();
  const order = app.queue.orders.at(-1);
  order.created_at = "2026-11-06T13:27:44Z";
  order.customer_type = "지체 손님";
  order.member_name = "김지체 박지체";
  const first = { ...order.sales[0], created_at: order.created_at, items: [{ status: "served" }] };
  const second = { ...first, id: "zz-second", menu_name: "필라프 세트", menu_price: 15000,
    items: [{ status: "cooked" }, { status: "pending" }],
    components: [{ menu_name: "필라프", quantity: 1 }], option_summary: "종류: 게살" };
  order.sales = [second, first];
  app.render().find(n => n.type === "button" && n.props.children === "엑셀 열 제목 복사").props.onClick();
  await settle();
  app.table().props.onCopy(order);
  await settle();

  const expected = csv.buildOrderCsv([
    { ...first, menu: null, order, status: "served" },
    { ...second, menu: null, order, status: "pending" },
  ]).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  assert.equal(app.writes[0], expected[0].replaceAll(",", "\t"));
  const rows = app.writes[1].split("\r\n").map(row => row.split("\t"));
  assert.deepEqual(rows, expected.slice(1).map(row => row.split(",").map(cell => cell.replace(/^"|"$/g, ""))));
  const headers = app.writes[0].split("\t");
  for (const row of rows) {
    assert.equal(row.length, headers.length);
    assert.deepEqual(row.slice(0, 4), ["2026-11-06 22시 27분 44초", "65", "1", "현금"]);
  }
  assert.equal(headers[headers.indexOf("손님이름") + 1], "소개한분");
  assert.equal(rows[0][headers.indexOf("소개한분")], "김지체 박지체");
  assert.equal(rows[0][headers.indexOf("받은현금(주문첫행)")], "5000");
  assert.equal(rows[1][headers.indexOf("받은현금(주문첫행)")], "");
  assert.equal(app.table().props.copiedId, order.id);

  app.fail();
  app.table().props.onCopy(order);
  await settle();
  assert.equal(app.writes.length, 2);
  assert.ok(app.render().some(n => n.props.role === "alert" && n.props.children.includes("복사하지 못했습니다")));
});
