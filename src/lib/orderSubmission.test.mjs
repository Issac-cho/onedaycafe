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
  let cursor = 0;
  const query = {
    select() { return this; }, eq() { return this; },
    order() { return this; }, then(resolve) { resolve({ data: [menu] }); },
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
    } },
    "@/lib/orderSubmission": helpers,
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/card": Object.fromEntries(["Card", "CardContent", "CardHeader", "CardTitle"].map(name => [name, name])),
    "@/components/ui/input": { Input: "input" },
    "@/components/ui/label": { Label: "label" },
    "@/components/ui/select": Object.fromEntries(["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"].map(name => [name, name])),
    "@/components/PinLock": { PinLock: "main" },
  };
  const { default: Page } = load("../app/[store_id]/order/page.tsx", dependencies,
    { sessionStorage: saved, crypto: { randomUUID }, alert: message => alerts.push(message), console: { error() {} } });
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
  effects.forEach(effect => effect());
  await settle();
  return {
    render, calls, alerts, saved,
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
