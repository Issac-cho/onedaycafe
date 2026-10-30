import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const code = ts.transpileModule(readFileSync(new URL("../components/admin/MenuManager.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function setup(confirmed = true, fail = false) {
  const menu = { id: "coffee", name: "커피", price: 3000, category: "음료", kitchen_group: 1 };
  const states = [], filters = [], updates = [], alerts = [];
  let index = 0, effect, updating = false;
  const query = {
    select() { return updating ? Promise.resolve({ data: [{ id: "coffee" }], error: fail ? { message: "offline" } : null }) : this; },
    eq(...args) { filters.push(args); return this; },
    order() { updating = false; return Promise.resolve({ data: [menu], error: null }); },
    update(value) { updating = true; updates.push(value); return this; },
    delete() { assert.fail("menu rows must never be physically deleted"); },
  };
  const exports = {};
  const dependencies = {
    react: {
      useState(initial) {
        const current = index++;
        if (!(current in states)) states[current] = initial;
        return [states[current], value => { states[current] = value; }];
      },
      useEffect: callback => { effect = callback; }, useCallback: callback => callback,
    },
    "@/lib/supabase": { supabase: { from: () => query } },
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/input": { Input: "input" },
    "@/components/ui/label": { Label: "label" },
    "@/components/ui/table": Object.fromEntries(["Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"].map(name => [name, name])),
  };
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name),
    confirm: () => confirmed, alert: message => alerts.push(message), console: { error() {} } });
  function render() { index = 0; return exports.MenuManager({ storeId: "store" }); }
  render();
  effect();
  await new Promise(resolve => setImmediate(resolve));
  function findDelete(node) {
    if (Array.isArray(node)) return node.map(findDelete).find(Boolean);
    if (!node?.props) return;
    if (node.type === "button" && node.props.children === "삭제") return node.props;
    return findDelete(node.props.children);
  }
  return { updates, filters, alerts, remove: () => findDelete(render()).onClick() };
}

test("menu deletion marks the row deleted and hidden, scoped to its store", async () => {
  const app = await setup();
  await app.remove();
  assert.equal(app.updates[0].is_deleted, true);
  assert.equal(app.updates[0].is_hidden, true);
  assert.ok(app.filters.some(([key, value]) => key === "store_id" && value === "store"));
  assert.ok(app.filters.some(([key, value]) => key === "is_deleted" && value === false));
});

test("cancelling deletion does not write, and failures are surfaced", async () => {
  const cancelled = await setup(false);
  await cancelled.remove();
  assert.equal(cancelled.updates.length, 0);
  const failed = await setup(true, true);
  await failed.remove();
  assert.ok(failed.alerts[0].includes("삭제하지 못했습니다"));
});
