import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
function load(path, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(require("typescript").transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7, jsx: 4 } }).outputText,
    { exports, require: name => dependencies[name] ?? require(name) });
  return exports;
}
const helpers = load("./menuOptions.ts");
const soda = { id: "soda", name: "탄산", option_groups: [{ name: "종류", choices: ["콜라", "사이다"], count: 1 }] };
test("set selection repeats text choices according to component count", () => {
  const specs = helpers.optionSpecs({ menu_type: "set", set_components: [{ menu_id: "soda", quantity: 2 }] }, new Map([[soda.id, soda]]));
  assert.equal(specs[0].multiplier, 2);
  assert.equal(specs[0].groups[0].count, 1);
});
test("option dialog requires every pick, permits duplicates, and normalizes equivalent combinations", () => {
  function pick(values) {
    const states = [], added = [];
    let cursor = 0;
    const { MenuOptionsDialog } = load("../components/MenuOptionsDialog.tsx", {
      react: { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; } },
      "@/lib/menuOptions": helpers, "@/components/ui/button": { Button: "button" },
      "@/components/ui/dialog": Object.fromEntries(["Dialog", "DialogContent", "DialogHeader", "DialogTitle", "DialogDescription"].map(name => [name, name])),
    });
    function render() {
      cursor = 0; const nodes = [];
      function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n?.props) return; nodes.push(n); visit(n.props.children); }
      visit(MenuOptionsDialog({ menu: { id: "set", name: "탄산 2잔" }, specs: [{ menu_id: "soda", name: "탄산", groups: soda.option_groups, multiplier: 2 }], onAdd: menu => added.push(menu), onClose() {} }));
      return nodes;
    }
    const submit = () => render().find(n => n.type === "form").props.onSubmit({ preventDefault() {} });
    submit(); assert.equal(added.length, 0);
    values.forEach(value => render().find(n => n.props["aria-label"] === `${value} 추가`).props.onClick());
    render().find(n => n.props["aria-label"] === "콜라 추가").props.onClick();
    assert.ok(render().some(n => n.props.role === "alert"));
    const chosen = values[0];
    render().find(n => n.props["aria-label"] === `${chosen} 하나 빼기`).props.onClick();
    assert.equal(render().find(n => n.props.type === "submit").props.disabled, true);
    assert.ok(!render().some(n => n.props.role === "alert"));
    render().find(n => n.props["aria-label"] === `${chosen} 추가`).props.onClick();
    assert.equal(render().find(n => n.props.type === "submit").props.disabled, false);
    submit(); return added[0];
  }
  const twice = pick(["콜라", "콜라"]); assert.equal(twice.selections[0].groups[0].length, 2);
  assert.equal(pick(["콜라", "사이다"]).cart_key, pick(["사이다", "콜라"]).cart_key);
});
