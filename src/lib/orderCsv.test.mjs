import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("./orderCsv.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports });
const { fetchCsvOrderItems, buildOrderCsv } = exports;
const row = id => ({ id: String(id), quantity: 2, menu_name: `커피 ${id}`, menu_price: 3000, status: "served",
  menu: null, order: { order_number: id + 1, table_number: "3번", payment_method: "현금", created_at: "2026-10-30T01:00:00Z" } });
function client(rows, failedPage = -1) {
  const ranges = [], ordering = [];
  const query = {
    select(columns) { assert.ok(columns.includes("orders!inner")); return this; },
    eq(key, value) { assert.equal(key, "order.store_id"); assert.equal(value, "store"); return this; },
    order(key) { ordering.push(key); return this; },
    range(from, to) {
      ranges.push([from, to]);
      return Promise.resolve(ranges.length === failedPage
        ? { data: null, error: new Error("connection failed") }
        : { data: rows.slice(from, to + 1), error: null });
    },
  };
  return { from(table) { assert.equal(table, "order_items"); return query; }, ranges, ordering };
}

test("CSV loads every row past 1000 with a stable order and bounded pages", async () => {
  const database = client(Array.from({ length: 1205 }, (_, id) => row(id)));
  const items = await fetchCsvOrderItems(database, "store");
  assert.equal(items.length, 1205);
  assert.deepEqual(database.ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.deepEqual(database.ordering, ["created_at", "id", "created_at", "id", "created_at", "id"]);
  assert.equal(new Set(items.map(item => item.id)).size, 1205);
  const csv = buildOrderCsv(items);
  assert.equal(csv.split("\r\n").length - 2, 1205);
  assert.ok(csv.includes('"커피 1204",2,3000,6000,"서빙 완료"'));
  assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test("exact page boundaries, empty stores and later page failures are handled", async () => {
  const exact = client(Array.from({ length: 1000 }, (_, id) => row(id)));
  assert.equal((await fetchCsvOrderItems(exact, "store")).length, 1000);
  assert.equal(exact.ranges.length, 3);
  assert.equal((await fetchCsvOrderItems(client([]), "store")).length, 0);
  await assert.rejects(fetchCsvOrderItems(client(Array.from({ length: 1205 }, (_, id) => row(id)), 2), "store"), /connection failed/);
});

test("CSV preserves snapshots, escapes quotes and multiline text, and handles legacy prices", () => {
  const special = { ...row(0), menu_name: '커피, "라떼"\n따뜻하게', menu_price: 0,
    menu: { name: "변경된 메뉴", price: 9999 }, order: { ...row(0).order, table_number: "=1+1" } };
  const legacy = { ...row(1), menu_name: null, menu_price: null, menu: { name: "기존 메뉴", price: 2500 } };
  const csv = buildOrderCsv([special, legacy]);
  assert.ok(csv.includes('"커피, ""라떼""\n따뜻하게",2,0,0,'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"기존 메뉴",2,2500,5000,'));
});
