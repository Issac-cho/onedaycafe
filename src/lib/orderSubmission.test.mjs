import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(path, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name), console, ...globals });
  return exports;
}
const helpers = load("./orderSubmission.ts");
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const menu = { id: "menu", name: "커피", price: 3000, category: "음료", kitchen_group: 1, is_sold_out: false };
const success = { data: { id: "order", order_number: 5 }, error: null };

async function mount(saved = storage(), responses = [success]) {
  const hooks = [], effects = [], calls = [], alerts = [];
  const cleanups = [];
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  let menuResult = { data: [menu], error: null };
  let fetches = 0;
  let change, subscription, poll;
  const channel = {
    on(_type, filter, callback) { assert.equal(filter.table, "menus"); assert.equal(filter.filter, "store_id=eq.store"); change = callback; return this; },
    subscribe(callback) { subscription = callback; return this; },
  };
  let cursor = 0;
  const query = {
    select() { return this; }, eq() { return this; },
    order() { return this; }, range() { return this; }, abortSignal() { return this; },
    then(resolve) { fetches++; resolve(menuResult); },
  };
  const react = {
    use: () => ({ store_id: "store" }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(effect) { const index = cursor++; if (!(index in hooks)) { hooks[index] = true; effects.push(effect); } },
  };
  const dependencies = {
    react,
    "@/lib/supabase": { supabase: {
      from(table) { assert.equal(table, "menus", "orders must only be written via the atomic RPC"); return query; },
      rpc(name, args) { assert.equal(name, "submit_order"); calls.push(args); return responses.shift() ?? success; },
      channel: () => channel, removeChannel() {},
    } },
    "@/lib/orderSubmission": helpers,
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/card": Object.fromEntries(["Card", "CardContent", "CardHeader", "CardTitle"].map(name => [name, name])),
    "@/components/ui/input": { Input: "input" },
    "@/components/ui/label": { Label: "label" },
    "@/components/ui/select": Object.fromEntries(["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"].map(name => [name, name])),
    "@/components/PinLock": { PinLock: "main" },
    "@/components/QueueConnectionStatus": { QueueConnectionStatus: "aside" },
  };
  const { default: Page } = load("../app/[store_id]/order/page.tsx", dependencies,
    { sessionStorage: saved, crypto: { randomUUID }, alert: message => alerts.push(message), console: { error() {} },
      window, document, AbortController, setTimeout: () => 1, clearTimeout() {},
      setInterval(callback, delay) { assert.equal(delay, 5000); poll = callback; return 1; }, clearInterval() {} });
  function render() {
    cursor = 0;
    const tree = Page({ params: Promise.resolve({ store_id: "store" }) });
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node?.props) return;
      nodes.push(node);
      visit(node.props.children);
    }
    visit(tree);
    return nodes;
  }
  render();
  effects.forEach(effect => cleanups.push(effect()));
  await settle();
  return {
    render, calls, alerts, saved,
    get fetches() { return fetches; },
    visibility: state => { document.visibilityState = state; },
    async menuChange(menus) { menuResult = { data: menus, error: null }; change(); await settle(); },
    async menuFailure() { menuResult = { data: null, error: { message: "offline" } }; change(); await settle(); },
    async poll(menus) { menuResult = { data: menus, error: null }; poll(); await settle(); },
    async reconnect(menus) { menuResult = { data: menus, error: null }; subscription("SUBSCRIBED"); await settle(); },
    async event(name, menus) { menuResult = { data: menus, error: null }; window.dispatchEvent(new Event(name)); await settle(); },
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()),
    prepare() {
      render().find(node => node.type === "Card" && node.props.onClick).props.onClick();
      render().find(node => node.type === "input" && node.props.id === "table").props.onChange({ target: { value: "3번" } });
    },
    submit: () => render().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }),
    retry: () => render().find(node => node.type === "button" && node.props.children === "접수 확인 / 재시도").props.onClick(),
  };
}

test("successful order uses one RPC and clears the saved pending request", async () => {
  const app = await mount();
  app.prepare();
  await app.submit();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].p_items[0].quantity, 1);
  assert.equal(helpers.readPendingOrder(app.saved, "store"), null);
  assert.ok(app.alerts[0].includes("5번"));
});

test("uncertain response survives reload and retries with identical ID and payload", async () => {
  const saved = storage();
  const app = await mount(saved, [{ data: null, error: { code: "", message: "connection lost" } }]);
  app.prepare();
  await app.submit();
  assert.ok(helpers.readPendingOrder(saved, "store"));
  assert.equal(app.render().find(node => node.type === "fieldset").props.disabled, true);
  const reloaded = await mount(saved);
  await reloaded.retry();
  assert.equal(JSON.stringify(reloaded.calls[0]), JSON.stringify(app.calls[0]));
  assert.equal(helpers.readPendingOrder(saved, "store"), null);
});

test("a definitive database rejection unlocks editing without discarding the cart", async () => {
  const app = await mount(storage(), [{ data: null, error: { code: "22023", message: "품절" } }]);
  app.prepare();
  await app.submit();
  assert.equal(helpers.readPendingOrder(app.saved, "store"), null);
  assert.equal(app.render().find(node => node.type === "fieldset").props.disabled, false);
  await app.submit();
  assert.equal(app.calls.length, 2);
  assert.notEqual(app.calls[0].p_request_id, app.calls[1].p_request_id);
});

test("rapid double submit sends one request while the first is in flight", async () => {
  let resolve;
  const app = await mount(storage(), [new Promise(done => { resolve = done; })]);
  app.prepare();
  const first = app.submit();
  await app.submit();
  assert.equal(app.calls.length, 1);
  resolve(success);
  await first;
});

test("corrupted saved requests block new submissions instead of silently losing their identity", async () => {
  const saved = storage();
  saved.setItem("pending_order_store", "broken-json");
  const app = await mount(saved);
  assert.equal(app.render().find(node => node.type === "fieldset").props.disabled, true);
  assert.equal(app.calls.length, 0);
});

test("sold-out changes block checkout without removing the cart; restoring stock enables it again", async () => {
  const app = await mount();
  app.prepare();
  await app.menuChange([{ ...menu, is_sold_out: true }]);
  assert.equal(app.render().find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.ok(app.render().some(node => node.props.role === "alert" && JSON.stringify(node.props.children).includes("품절")));
  await app.submit();
  assert.equal(app.calls.length, 0);
  await app.menuChange([menu]);
  await app.submit();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].p_items[0].quantity, 1);
  app.cleanup();
});

test("hidden and deleted menus disappear from the catalog but remain removable in the cart", async () => {
  for (const flag of ["is_hidden", "is_deleted"]) {
    const app = await mount();
    app.prepare();
    await app.menuChange([{ ...menu, [flag]: true }]);
    assert.ok(!app.render().some(node => node.type === "Card" && node.props.onClick));
    await app.submit();
    assert.equal(app.calls.length, 0);
    app.render().find(node => node.type === "button" && node.props.children === "메뉴 빼기").props.onClick();
    assert.ok(app.render().some(node => node.props.children === "장바구니가 비어있습니다."));
    app.cleanup();
  }
});

test("price changes require explicit confirmation before sending the updated amount", async () => {
  const app = await mount();
  app.prepare();
  await app.menuChange([{ ...menu, price: 3500 }]);
  await app.submit();
  assert.equal(app.calls.length, 0);
  app.render().find(node => node.type === "button" && node.props.children === "변경 가격 적용").props.onClick();
  await app.submit();
  assert.equal(app.calls[0].p_items[0].unit_price, 3500);
  app.cleanup();
});

test("failed refresh blocks new orders and recovery restores checkout", async () => {
  const app = await mount();
  app.prepare();
  await app.menuFailure();
  await app.submit();
  assert.equal(app.calls.length, 0);
  await app.reconnect([menu]);
  await app.submit();
  assert.equal(app.calls.length, 1);
  app.cleanup();
});

test("menu refresh failures and later stock changes do not prevent confirming a previously sent request", async () => {
  const app = await mount(storage(), [{ data: null, error: { code: "", message: "connection lost" } }, success]);
  app.prepare();
  await app.submit();
  await app.menuChange([{ ...menu, is_sold_out: true }]);
  await app.menuFailure();
  await app.retry();
  assert.equal(JSON.stringify(app.calls[0]), JSON.stringify(app.calls[1]));
  assert.equal(helpers.readPendingOrder(app.saved, "store"), null);
  app.cleanup();
});

test("subscription recovery, browser events and visible polling refresh menus and clean up on unmount", async () => {
  const app = await mount();
  for (const refresh of [() => app.reconnect([menu]), () => app.poll([menu]),
    () => app.event("focus", [menu]), () => app.event("online", [menu])]) {
    const before = app.fetches;
    await refresh();
    assert.equal(app.fetches, before + 1);
  }
  app.visibility("hidden");
  const before = app.fetches;
  await app.poll([menu]);
  assert.equal(app.fetches, before);
  app.cleanup();
  await app.menuChange([menu]);
  assert.equal(app.fetches, before);
});
