import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7, jsx: 4 } }).outputText;
const payment = {}, accounting = {};
vm.runInNewContext(compile("./couponPayment.ts"), { exports: payment });
vm.runInNewContext(compile("./accounting.ts"), { exports: accounting, require: () => payment });

function mount() {
  const slots = [], writes = [], storage = new Map();
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
  })), menus: ["커피"], loading: false, connected: true, error: null, lastUpdated: new Date(), refresh() {} };
  const dependencies = {
    react, "@/lib/accounting": accounting, "@/lib/couponPayment": payment,
    "@/lib/useAccountingOrders": { useAccountingOrders: () => queue },
    "@/components/ui/input": { Input: "input" }, "@/components/ui/label": { Label: "label" },
    "@/components/ui/button": { Button: "button" }, "@/components/QueueConnectionStatus": { QueueConnectionStatus: "Connection" },
  };
  const exports = {};
  vm.runInNewContext(compile("../components/AccountingDashboard.tsx"), {
    exports, require: name => dependencies[name] ?? require(name),
    navigator: { clipboard: { async writeText(text) { if (failure) throw new Error("denied"); writes.push(text); } } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
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
});

test("headers include unpurchased catalog menus even with no orders and their cells copy as zero", async () => {
  const app = mount();
  app.queue.menus = ["커피", "붕어빵 2개", "필라프 + 탄산"];
  const order = app.queue.orders[0];
  app.queue.orders = [];
  app.render().find(n => n.type === "button" && n.props.children === "엑셀 열 제목 복사").props.onClick(); await settle();
  const names = app.writes[0].split("\t").slice(14);
  assert.equal(names.length, 3);
  assert.ok(names.includes("붕어빵 2개")); assert.ok(names.includes("필라프 + 탄산"));
  app.queue.orders = [order]; app.table().props.onCopy(order); await settle();
  const values = app.writes[1].split("\t").slice(14);
  assert.equal(values[names.indexOf("붕어빵 2개")], "0");
  assert.equal(values[names.indexOf("필라프 + 탄산")], "0");
  assert.equal(values[names.indexOf("커피")], "1");
});

test("order and header copy write matching TSV; denied clipboard access never displays false success", async () => {
  const app = mount();
  const table = app.table();
  table.props.onCopy(table.props.orders[0]); await settle();
  assert.equal(app.writes.length, 0);
  assert.ok(app.render().some(n => n.props.role === "alert" && n.props.children.includes("열 제목 복사")));
  app.render().find(n => n.type === "button" && n.props.children === "엑셀 열 제목 복사").props.onClick(); await settle();
  assert.equal(app.writes[0], accounting.accountingClipboardHeaders(accounting.accountingClipboardColumns(app.queue.orders)));
  table.props.onCopy(table.props.orders[0]); await settle();
  assert.equal(app.writes[1].split("\t")[0], "65"); assert.equal(app.table().props.copiedId, "order-65");
  app.fail(); app.table().props.onCopy(table.props.orders[1]); await settle();
  assert.equal(app.writes.length, 2); assert.equal(app.table().props.copiedId, null);
  assert.ok(app.render().some(n => n.props.role === "alert" && n.props.children.includes("복사하지 못했습니다")));
});

test("a new menu is blocked until headers are extended, preserving existing spreadsheet column positions", async () => {
  const app = mount();
  app.render().find(n => n.type === "button" && n.props.children === "엑셀 열 제목 복사").props.onClick(); await settle();
  const oldHeaders = app.writes[0];
  const added = { ...app.queue.orders[0], id: "new", order_number: 66, sales: [{ ...app.queue.orders[0].sales[0], menu_name: "새 메뉴" }] };
  app.queue.orders.push(added);
  app.table().props.onCopy(added); await settle();
  assert.equal(app.writes.length, 1);
  assert.ok(app.render().some(n => n.props.role === "alert" && n.props.children.includes("새 메뉴 열")));
  app.render().find(n => n.type === "button" && n.props.children === "엑셀 열 제목 복사").props.onClick(); await settle();
  assert.equal(app.writes[1], oldHeaders + "\t새 메뉴");
  app.table().props.onCopy(added); await settle();
  assert.equal(app.writes[2].split("\t").slice(14).join(","), "0,1");
});

test("new options on an existing menu copy into the same column without updating the headers", async () => {
  const app = mount();
  app.render().find(n => n.type === "button" && n.props.children === "엑셀 열 제목 복사").props.onClick(); await settle();
  const added = { ...app.queue.orders[0], id: "new-options", order_number: 66, sales: [
    { ...app.queue.orders[0].sales[0], option_summary: "온도: 아이스", quantity: 2 },
    { ...app.queue.orders[0].sales[0], option_summary: "온도: 핫", quantity: 1 },
  ] };
  app.queue.orders.push(added); app.table().props.onCopy(added); await settle();
  assert.equal(app.writes.length, 2);
  assert.equal(app.writes[0].split("\t").at(-1), "커피");
  assert.equal(app.writes[1].split("\t").at(-1), "아이스 : 2, 핫 : 1");
});
