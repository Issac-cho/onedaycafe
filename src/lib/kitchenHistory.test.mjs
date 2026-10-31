import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
function load(path, dependencies = {}, globals = {}) {
  const exports = {};
  const code = require("typescript").transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7, jsx: 4 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name), console, ...globals });
  return exports;
}
const { fetchKitchenHistory } = load("./kitchenHistory.ts");
const row = i => ({ id: String(i), menu_name: "당시 메뉴", quantity: 2, served_quantity: i % 2 ? 2 : 1,
  cooked_at: i % 2 ? "2026-10-31T01:00:00Z" : null, created_at: "2026-10-31T00:00:00Z",
  menu: { name: "현재 메뉴" }, order: { order_number: i, table_number: "3" } });
test("history fetch includes cooked and served rows, scopes store/group and loads beyond 1000", async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => row(i));
  const filters = [], ranges = [], ordering = [];
  let page;
  const query = { select() { return this; }, eq(...args) { filters.push(args); return this; },
    in(key, values) { assert.equal(key, "status"); assert.equal(JSON.stringify(values), '["cooked","served"]'); return this; },
    order(...args) { ordering.push(args); return this; }, range(from, to) { ranges.push([from, to]); page = rows.slice(from, to + 1); return this; },
    abortSignal: async () => ({ data: page, error: null }) };
  const fetched = await fetchKitchenHistory({ from: () => query }, "store", "7", new AbortController().signal);
  assert.equal(fetched.length, 1205);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.ok(filters.some(([key, value]) => key === "order.store_id" && value === "store"));
  assert.ok(filters.some(([key, value]) => key === "menu.store_id" && value === "store"));
  assert.ok(filters.some(([key, value]) => key === "menu.kitchen_group" && value === 7));
  assert.equal(ordering[0][0], "cooked_at"); assert.equal(ordering[0][1].nullsFirst, false);
  await assert.rejects(fetchKitchenHistory({}, "store", "", new AbortController().signal), /담당 구역/);
});
test("later page failures reject instead of presenting an incomplete history", async () => {
  let page = 0;
  const query = { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, range() { page++; return this; },
    abortSignal: async () => page === 1 ? { data: Array.from({ length: 500 }, (_, i) => row(i)), error: null } : { error: new Error("offline") } };
  await assert.rejects(fetchKitchenHistory({ from: () => query }, "store", "1", new AbortController().signal), /offline/);
});

function mount(fetch) {
  const hooks = [], effects = [], cleanups = [];
  let cursor = 0, calls = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === "function" ? value(hooks[i]) : value; }]; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || deps.some((v, j) => v !== hooks[i][j])) { hooks[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect(); }); } },
  };
  const { KitchenHistory } = load("../components/KitchenHistory.tsx", {
    react, "@/lib/supabase": { supabase: {} },
    "@/lib/kitchenHistory": { fetchKitchenHistory: (...args) => { calls++; return fetch(...args); } },
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/dialog": Object.fromEntries(["Dialog", "DialogTrigger", "DialogContent", "DialogHeader", "DialogTitle", "DialogDescription"].map(name => [name, name])),
    "lucide-react": { History: "icon", RefreshCw: "icon" },
  }, { AbortController, setTimeout: () => 1, clearTimeout() {} });
  function render() {
    cursor = 0; const nodes = [];
    function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n?.props) return; nodes.push(n); visit(n.props.children); }
    visit(KitchenHistory({ storeId: "store", kitchenGroup: "7" }));
    effects.splice(0).forEach(effect => effect());
    return nodes;
  }
  render();
  return { render, get calls() { return calls; },
    async open(value = true) { render().find(n => n.type === "Dialog").props.onOpenChange(value); render(); await new Promise(resolve => setImmediate(resolve)); },
    cleanup() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}
test("history loads only when opened, shows snapshots and older records, and reveals 50 at a time", async () => {
  const app = mount(async () => Array.from({ length: 55 }, (_, i) => row(i)));
  assert.equal(app.calls, 0); await app.open(); assert.equal(app.calls, 1);
  assert.equal(app.render().filter(n => n.type === "li").length, 50);
  assert.ok(app.render().some(n => n.type === "p" && JSON.stringify(n.props.children).includes("완료 시각 미기록")));
  assert.ok(app.render().some(n => n.type === "p" && JSON.stringify(n.props.children).includes("당시 메뉴")));
  app.render().find(n => n.type === "button" && JSON.stringify(n.props.children).includes("이전 내역 더 보기")).props.onClick();
  assert.equal(app.render().filter(n => n.type === "li").length, 55);
  await app.open(false); assert.equal(app.calls, 1); app.cleanup();
});
test("history errors are distinct from empty records and closing aborts the request", async () => {
  const failed = mount(async () => { throw new Error("offline"); }); await failed.open();
  assert.ok(failed.render().some(n => n.props.role === "alert")); failed.cleanup();
  let signal, resolve;
  const app = mount((_client, _store, _group, s) => { signal = s; return new Promise(done => { resolve = done; }); });
  await app.open(); await app.open(false); assert.equal(signal.aborted, true);
  resolve([row(1)]); await new Promise(done => setImmediate(done));
  assert.equal(app.render().filter(n => n.type === "li").length, 0); app.cleanup();
});
