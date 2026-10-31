import assert from "node:assert/strict";
import { test } from "node:test";
import { runRehearsal, validateTarget } from "./rehearsal.mjs";

const menus = Array.from({ length: 7 }, (_, index) => ({ id: `menu${index}`, kitchen_group: index + 1, price: 3000 + index * 100 }));
function fakeClient(failUpdates = false) {
  const orders = [], items = [], requests = new Map();
  const client = {
    async rpc(name, args) {
      if (name === "get_dashboard_totals") return { data: {
        totalOrders: orders.length, totalRevenue: items.reduce((sum, item) => sum + item.quantity * item.menu_price, 0),
        pendingItems: items.reduce((sum, item) => sum + item.quantity - item.cooked_quantity, 0),
        cookedItems: items.reduce((sum, item) => sum + item.cooked_quantity - item.served_quantity, 0),
      } };
      assert.equal(name, "submit_order");
      if (requests.has(args.p_request_id)) return { data: requests.get(args.p_request_id) };
      const order = { id: `order${orders.length}`, order_number: orders.length + 1, store_id: args.p_store_id, status: "received" };
      orders.push(order);
      requests.set(args.p_request_id, { id: order.id, order_number: order.order_number });
      for (const item of args.p_items) items.push({ id: `item${items.length}`, order_id: order.id, menu_id: item.menu_id,
        quantity: item.quantity, menu_price: item.unit_price, cooked_quantity: 0, served_quantity: 0, status: "pending" });
      return { data: requests.get(args.p_request_id) };
    },
    from(table) {
      const predicates = [];
      let update, single = false, counted = false;
      const query = {
        select(_columns, options) { counted = !!options?.count; return this; },
        eq(key, value) { predicates.push(row => row[key] === value); return this; },
        neq(key, value) { predicates.push(row => row[key] !== value); return this; },
        update(values) { update = values; return this; },
        single() { single = true; return this; },
        then(resolve, reject) {
          try {
            const rows = (table === "orders" ? orders : items).filter(row => predicates.every(predicate => predicate(row)));
            if (update && failUpdates) return resolve({ error: new Error("simulated network failure") });
            if (update) rows.forEach(row => Object.assign(row, update));
            resolve({ data: single ? { ...rows[0] } : rows.map(row => ({ ...row })), count: counted ? rows.length : null });
          } catch (error) { reject(error); }
        },
      };
      return query;
    },
  };
  return { client, orders, items, requests };
}

test("refuses production names, wrong names and missing kitchen groups", () => {
  assert.throws(() => validateTarget({ name: "실제 매장" }, "실제 매장", menus));
  assert.throws(() => validateTarget({ name: "리허설" }, "다른 리허설", menus));
  assert.throws(() => validateTarget({ name: "리허설" }, "리허설", menus.slice(1)));
  validateTarget({ name: "리허설" }, "리허설", menus);
});

test("six producers, seven kitchens and one server finish all units and validate totals", async () => {
  const database = fakeClient();
  const report = await runRehearsal(database.client, "store", menus, { orders: 6, rpm: 600000, cookMs: 0, serveMs: 0 });
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(report.completed, 6);
  assert.equal(database.orders.length, 6);
  assert.equal(database.items.length, 18);
  assert.equal(report.duplicateChecks, 1);
  assert.equal(database.requests.size, 6);
  assert.equal(report.expectedRevenue, report.actualRevenueIncrease);
  assert.ok(database.items.every(item => item.status === "served" && item.served_quantity === item.quantity));
  assert.equal(new Set(database.items.map(item => item.menu_id)).size, 7);
  assert.ok(report.timings.submit.p95Ms >= 0);
});

test("mutation failure stops workers and produces a failed report instead of hanging", async () => {
  const database = fakeClient(true);
  const report = await runRehearsal(database.client, "store", menus, { orders: 6, rpm: 600000, cookMs: 0, serveMs: 0 });
  assert.equal(report.passed, false);
  assert.ok(report.errors.some(error => error.message.includes("simulated network failure")));
});
