import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const code = require("typescript").transpileModule(readFileSync(new URL("./useAccountingOrders.ts", import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7 } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const states = [], events = new EventTarget(), document = new EventTarget(), filters = [];
  document.visibilityState = "visible";
  let effect, subscription, poll, resolveQuery, calls = 0, defer = false, fail = false, removed = false;
  const changes = {};
  let result = [{ id: "old" }];
  const channel = {
    on(_type, filter, callback) { filters.push(filter); changes[filter.table] = callback; return this; },
    subscribe(callback) { subscription = callback; return this; },
  };
  const react = {
    useState(initial) { const i = states.length; states.push(initial); return [initial, value => { states[i] = value; }]; },
    useRef: current => ({ current }), useCallback: callback => callback, useEffect: callback => { effect = callback; },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: name => name === "react" ? react : name === "./supabase" ? { supabase: { channel: () => channel, removeChannel() { removed = true; } } } : {
      fetchAccountingOrders: async (_client, storeId, date, signal) => {
        assert.equal(storeId, "store"); assert.equal(date, "2026-11-04"); assert.ok(signal instanceof AbortSignal);
        calls++;
        if (defer) return new Promise(resolve => { resolveQuery = resolve; });
        if (fail) throw new Error("offline");
        return result;
      },
    },
    document, window: events, AbortController,
    setTimeout: () => 1, clearTimeout() {}, setInterval(callback, ms) { assert.equal(ms, 5000); poll = callback; return 1; }, clearInterval() { poll = undefined; },
  });
  const hook = exports.useAccountingOrders("store", "2026-11-04");
  const cleanup = effect();
  return { states, filters, document, hook, cleanup,
    get calls() { return calls; }, get removed() { return removed; }, get polling() { return !!poll; },
    change: () => changes.orders(), poll: () => poll(), subscription: value => subscription(value),
    event: name => events.dispatchEvent(new Event(name)),
    fail: value => { fail = value; }, result: value => { result = value; },
    defer() { defer = true; }, resolve(value) { defer = false; resolveQuery(value); },
  };
}

test("committed order notifications, reconnects, polling and focus recover the accounting ledger", async () => {
  const app = setup(); await settle();
  assert.equal(app.calls, 1);
  assert.equal(app.filters[0].table, "orders"); assert.equal(app.filters[0].filter, "store_id=eq.store");
  for (const trigger of [app.change, app.poll, () => app.subscription("SUBSCRIBED"), () => app.event("online"), () => app.event("focus"), app.hook.refresh]) {
    const before = app.calls; trigger(); await settle(); assert.equal(app.calls, before + 1);
  }
  app.subscription("CHANNEL_ERROR"); assert.equal(app.states[3], false);
  app.subscription("SUBSCRIBED"); await settle(); app.event("offline"); assert.equal(app.states[3], false);
  app.document.visibilityState = "hidden"; const before = app.calls; app.poll(); assert.equal(app.calls, before);
  app.cleanup(); assert.equal(app.polling, false); assert.equal(app.removed, true);
});

test("a failed refresh retains previous orders and timestamp until a successful recovery", async () => {
  const app = setup(); await settle();
  const updated = app.states[4];
  app.fail(true); app.poll(); await settle();
  assert.equal(app.states[0][0].id, "old"); assert.ok(app.states[2]); assert.equal(app.states[4], updated);
  app.fail(false); app.result([{ id: "new" }]); app.poll(); await settle();
  assert.equal(app.states[0][0].id, "new"); assert.equal(app.states[2], null);
  app.cleanup();
});

test("notifications during a query cause one follow-up fetch and late responses cannot replace another page", async () => {
  const app = setup(); await settle();
  app.defer(); app.poll(); app.change(); app.change(); assert.equal(app.calls, 2);
  app.result([{ id: "new" }]); app.resolve([{ id: "stale" }]); await settle();
  assert.equal(app.calls, 3); assert.equal(app.states[0][0].id, "new");
  app.defer(); app.poll(); app.cleanup(); app.resolve([{ id: "late" }]); app.subscription("SUBSCRIBED"); await settle();
  assert.equal(app.states[0][0].id, "new");
});
