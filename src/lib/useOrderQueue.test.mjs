import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const code = ts.transpileModule(readFileSync(new URL("./useOrderQueue.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function setup(status = "pending", kitchenGroup = "2") {
  const states = [];
  const events = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  let effect, subscription, poll, cleanup, resolveQuery;
  const changes = {};
  let calls = 0;
  let result = { data: [{ id: "first" }], error: null };
  let deferred = false;
  let removed = false;
  const channel = {
    on(_type, filter, callback) { changes[filter.table] = callback; return this; },
    subscribe(callback) { subscription = callback; return this; },
  };
  const filters = [];
  const query = {
    select() { return this; },
    eq(...args) { filters.push(args); return this; },
    neq(...args) { filters.push(["neq", ...args]); return this; },
    range(...args) { filters.push(["range", ...args]); return this; },
    order() { return this; },
    abortSignal() {
      calls++;
      return deferred ? new Promise(resolve => { resolveQuery = resolve; }) : Promise.resolve(result);
    },
  };
  const react = {
    useState(initial) {
      const index = states.length;
      states.push(initial);
      return [initial, value => { states[index] = value; }];
    },
    useRef: current => ({ current }),
    useCallback: callback => callback,
    useEffect: callback => { effect = callback; },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: name => name === "react" ? react : { supabase: {
      from: () => query, channel: () => channel, removeChannel: () => { removed = true; },
    } },
    console: { error() {} }, document, window: events, AbortController,
    setTimeout: () => 1, clearTimeout() {},
    setInterval: callback => { poll = callback; return 1; },
    clearInterval: () => { poll = undefined; },
  });
  const hook = exports.useOrderQueue("store", status, kitchenGroup);
  cleanup = effect();
  return {
    states, filters, hook, document,
    get calls() { return calls; },
    get removed() { return removed; },
    get polling() { return !!poll; },
    poll: () => poll(), change: () => changes.order_items(), orderChange: () => changes.orders(),
    subscription: state => subscription(state),
    event: name => events.dispatchEvent(new Event(name)),
    result: value => { result = value; },
    defer: () => { deferred = true; },
    resolve: value => { deferred = false; resolveQuery(value); },
    cleanup,
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("subscription, polling and browser recovery refresh the queue", async () => {
  const app = setup();
  await settle();
  assert.equal(app.calls, 1);
  assert.ok(app.filters.some(([key, value]) => key === "menu.kitchen_group" && value === 2));
  for (const trigger of [() => app.subscription("SUBSCRIBED"), app.change, app.orderChange, app.poll,
    () => app.event("online"), () => app.event("focus"),
    () => app.document.dispatchEvent(new Event("visibilitychange")), app.hook.refresh]) {
    const before = app.calls;
    trigger();
    await settle();
    assert.equal(app.calls, before + 1);
  }
  app.subscription("CHANNEL_ERROR");
  assert.equal(app.states[3], false);
  app.document.visibilityState = "hidden";
  const before = app.calls;
  app.poll();
  assert.equal(app.calls, before);
  app.cleanup();
  assert.equal(app.polling, false);
  assert.equal(app.removed, true);
});

test("serving queue includes every item status of unfinished orders", async () => {
  const app = setup("serving", undefined);
  await settle();
  assert.ok(app.filters.some(([op, key, value]) => op === "neq" && key === "order.status" && value === "completed"));
  assert.ok(!app.filters.some(([key]) => key === "status"));
  assert.ok(app.filters.some(([key, value]) => key === "order.store_id" && value === "store"));
  app.cleanup();
});

test("full pages are followed by another page instead of truncating an order", async () => {
  const app = setup("serving");
  await settle();
  app.defer();
  app.poll();
  app.result({ data: [{ id: "last" }], error: null });
  app.resolve({ data: Array.from({ length: 500 }, (_, id) => ({ id })), error: null });
  await settle();
  assert.equal(app.states[0].length, 501);
  assert.ok(app.filters.some(([op, from, to]) => op === "range" && from === 500 && to === 999));
  app.cleanup();
});

test("failed fetch keeps prior items and displays an error; recovery clears it", async () => {
  const app = setup();
  await settle();
  app.result({ data: null, error: { message: "network failure" } });
  app.poll();
  await settle();
  assert.equal(app.states[0][0].id, "first");
  assert.ok(app.states[2]);
  app.result({ data: [], error: null });
  app.poll();
  await settle();
  assert.equal(app.states[0].length, 0);
  assert.equal(app.states[2], null);
  app.cleanup();
});

test("an event during an in-flight fetch queues another fetch", async () => {
  const app = setup();
  await settle();
  app.defer();
  app.poll();
  app.change();
  app.change();
  assert.equal(app.calls, 2);
  app.result({ data: [{ id: "new" }], error: null });
  app.resolve({ data: [{ id: "old" }], error: null });
  await settle();
  assert.equal(app.calls, 3);
  assert.equal(app.states[0][0].id, "new");
  app.cleanup();
});

test("late fetch and subscription callbacks do not update an unmounted queue", async () => {
  const app = setup();
  await settle();
  app.defer();
  app.poll();
  app.cleanup();
  app.resolve({ data: [{ id: "late" }], error: null });
  app.subscription("SUBSCRIBED");
  await settle();
  assert.equal(app.states[0][0].id, "first");
  assert.equal(app.states[3], false);
});
