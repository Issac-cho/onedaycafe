import assert from "node:assert/strict";
import { test } from "node:test";
import { availableMenus, makePlan, verifyPlan } from "./rehearsal-plan.mjs";
import { runRehearsal, validateTarget } from "./rehearsal.mjs";

const menus = Array.from({ length: 7 }, (_, index) => ({ id: `menu${index}`, name: `메뉴${index}`, kitchen_group: index + 1, price: 3000 + index * 100 }));
function fakeClient(failUpdates = false, catalog = menus, faults = {}) {
  const orders = [], items = [], sales = [], balances = new Map(), requests = new Map();
  const client = {
    async rpc(name, args) {
      if (name === "get_dashboard_totals") return { data: {
        totalOrders: orders.length, totalRevenue: sales.reduce((sum, item) => sum + item.quantity * item.menu_price, 0),
        couponUsed: orders.reduce((sum, order) => sum + order.coupon_used, 0),
        cashDue: orders.reduce((sum, order) => sum + order.cash_due, 0),
        cashReceived: orders.reduce((sum, order) => sum + order.cash_received, 0),
        couponCredited: orders.reduce((sum, order) => sum + order.coupon_credited, 0),
        pendingItems: items.reduce((sum, item) => sum + item.quantity - item.cooked_quantity, 0),
        cookedItems: items.reduce((sum, item) => sum + item.cooked_quantity - item.served_quantity, 0),
      } };
      if (name === "lookup_coupon_account") return { data: { id: args.p_customer_name, balance: balances.get(args.p_customer_name) ?? 0 } };
      assert.equal(name, "submit_customer_order");
      if (requests.has(args.p_request_id)) return { data: requests.get(args.p_request_id) };
      const order = { id: `order${orders.length}`, order_number: orders.length + 1, store_id: args.p_store_id, status: "received" };
      orders.push(order);
      requests.set(args.p_request_id, { id: order.id, order_number: order.order_number });
      const total = args.p_items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
      const used = args.p_coupon_used;
      const due = total - used, received = args.p_cash_received ?? due;
      Object.assign(order, { cash_due: due, cash_received: received, coupon_used: used, coupon_credited: received - due });
      if (args.p_customer_name) balances.set(args.p_customer_name, (balances.get(args.p_customer_name) ?? 0) - used + received - due);
      for (const input of args.p_items) {
        const menu = catalog.find(menu => menu.id === input.menu_id);
        const sale = { id: `sale${sales.length}`, order_id: order.id, menu_id: menu.id, menu_name: menu.name, menu_price: input.unit_price,
          quantity: input.quantity, components: [], option_summary: "" };
        sales.push(sale);
        const parts = menu.menu_type === "set" ? input.components : [{ menu_id: menu.id, quantity: 1 }];
        for (const part of parts) {
          const component = catalog.find(menu => menu.id === part.menu_id);
          const groups = input.selections?.find(selection => selection.menu_id === component.id)?.groups ?? [];
          const summary = groups.map((values, gi) => `${component.option_groups[gi].name}: ${values.join(" / ")}`).join(", ");
          const name = component.name + (summary ? ` · ${summary}` : "");
          if (summary) sale.option_summary += (sale.option_summary ? " · " : "") + summary;
          if (menu.menu_type === "set") sale.components.push({ menu_id: component.id, menu_name: name, quantity: part.quantity, kitchen_group: component.kitchen_group });
          items.push({ id: `item${items.length}`, order_id: order.id, menu_id: component.id, menu_name: name, sale_line_id: sale.id,
            quantity: input.quantity * part.quantity, menu_price: menu.menu_type === "set" ? 0 : input.unit_price,
            cooked_quantity: 0, served_quantity: 0, status: "pending", set_name: menu.menu_type === "set" ? menu.name : null,
            sale_quantity: menu.menu_type === "set" ? input.quantity : null });
        }
        if (faults.badPrice) sale.menu_price++;
      }
      if (faults.lostSubmit) { faults.lostSubmit = false; return { error: { status: 502, message: "502 response lost after commit" } }; }
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
            const rows = (table === "orders" ? orders : table === "order_sales" ? sales : items).filter(row => predicates.every(predicate => predicate(row)));
            if (update && failUpdates) return resolve({ error: new Error("simulated network failure") });
            if (update) {
              rows.forEach(row => { Object.assign(row, update); if (table === "order_items" && row.cooked_quantity === row.quantity && !row.cooked_at) row.cooked_at = new Date().toISOString(); });
              const flag = update.cooked_quantity !== undefined ? "lostCook" : update.served_quantity !== undefined ? "lostServe" : "lostComplete";
              if (faults[flag]) { faults[flag] = false; return resolve({ error: { status: 502, message: "502 response lost after commit" } }); }
            }
            resolve({ data: single ? { ...rows[0] } : rows.map(row => ({ ...row })), count: counted ? rows.length : null });
          } catch (error) { reject(error); }
        },
      };
      return query;
    },
  };
  return { client, orders, items, sales, requests };
}

test("refuses production names, wrong names and empty catalogs but accepts unused kitchen groups", () => {
  assert.throws(() => validateTarget({ name: "실제 매장" }, "실제 매장", menus));
  assert.throws(() => validateTarget({ name: "리허설" }, "다른 리허설", menus));
  assert.throws(() => validateTarget({ name: "리허설" }, "리허설", []));
  validateTarget({ name: "리허설" }, "리허설", menus.slice(1));
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


const currentMenus = [
  { id: "pilaf", name: "필라프", menu_type: "component", price: 0, kitchen_group: 1 },
  { id: "soda", name: "탄산", menu_type: "component", price: 0, kitchen_group: 7, option_groups: [{ name: "종류", count: 1, choices: ["콜라", "사이다"] }] },
  { id: "set", name: "필라프 세트", menu_type: "set", price: 15000, set_components: [{ menu_id: "pilaf", quantity: 1 }, { menu_id: "soda", quantity: 1 }] },
  { id: "pair", name: "탄산 2잔", menu_type: "set", price: 5000, set_components: [{ menu_id: "soda", quantity: 2 }] },
  { id: "coffee", name: "커피", menu_type: "single", price: 5000, kitchen_group: 6, option_groups: [{ name: "온도", count: 1, choices: ["아이스", "핫"] }] },
];
test("sets, text options, snapshots and physical quantities complete using actual kitchen groups", async () => {
  validateTarget({ name: "리허설" }, "리허설", currentMenus);
  const database = fakeClient(false, currentMenus);
  const report = await runRehearsal(database.client, "store", currentMenus, { orders: 6, rpm: 600000, cookMs: 0, serveMs: 0 });
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.ok(report.setLines > 0); assert.ok(report.optionLines > 0);
  assert.ok(report.kitchenUnits[1] > 0); assert.ok(report.kitchenUnits[7] > 0);
  assert.equal(database.sales.length, 18); assert.equal(database.items.length, 24);
  assert.equal(report.expectedRevenue, report.actualRevenueIncrease);
  assert.ok(database.items.every(item => item.cooked_at && item.served_quantity === item.quantity));
});
test("sold-out components disable their sets and snapshot corruption fails verification", async () => {
  assert.equal(availableMenus(currentMenus.map(menu => menu.id === "soda" ? { ...menu, is_sold_out: true } : menu)).length, 1);
  const database = fakeClient(false, currentMenus, { badPrice: true });
  const report = await runRehearsal(database.client, "store", currentMenus, { orders: 1, rpm: 600000, cookMs: 0, serveMs: 0 });
  assert.equal(report.passed, false);
  assert.ok(report.errors.some(error => error.message.includes("스냅샷")));
  const plan = makePlan(currentMenus, 0);
  assert.throws(() => verifyPlan(plan, [], []), /개수/);
});
test("ambiguous submission and quantity updates retry without duplicate orders or increments", async () => {
  const database = fakeClient(false, currentMenus, { lostSubmit: true, lostCook: true, lostServe: true, lostComplete: true });
  const report = await runRehearsal(database.client, "store", currentMenus, { orders: 1, rpm: 600000, cookMs: 0, serveMs: 0 });
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(report.transientRetries, 4);
  assert.equal(database.orders.length, 1);
  assert.ok(database.items.every(item => item.cooked_quantity === item.quantity && item.served_quantity === item.quantity));
});


test("mixed payment mode funds only isolated test accounts and validates coupon spending and credits", async () => {
  const database = fakeClient(false, currentMenus);
  const report = await runRehearsal(database.client, "store", currentMenus, { orders: 18, rpm: 600000, cookMs: 0, serveMs: 0, payments: "mixed" });
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.ok(report.paymentCounts["현금"] > 0); assert.ok(report.paymentCounts["쿠폰"] > 0); assert.ok(report.paymentCounts["쿠폰+현금"] > 0);
  assert.ok(report.testCouponAccounts.every(account => account.name.startsWith("TEST-")));
  assert.ok(database.orders.some(order => order.coupon_credited > 0));
});
