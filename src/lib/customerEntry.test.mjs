import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
function mount(result) {
  const hooks = [], calls = [], customers = [];
  let cursor = 0;
  const dependencies = {
    react: { useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = value; }]; } },
    "@/lib/supabase": { supabase: { rpc(name, args) { assert.equal(name, "find_friend_accounts"); calls.push(args); return { abortSignal: async () => result }; } } },
    "@/components/ui/button": { Button: "button" }, "@/components/ui/input": { Input: "input" }, "@/components/ui/label": { Label: "label" },
  };
  const exports = {};
  const code = require("typescript").transpileModule(readFileSync(new URL("../components/CustomerEntry.tsx", import.meta.url), "utf8"), { compilerOptions: { module: 1, target: 7, jsx: 4 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name), AbortSignal });
  function render() {
    cursor = 0; const nodes = [];
    function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (!node?.props) return; nodes.push(node); visit(node.props.children); }
    visit(exports.CustomerEntry({ storeId: "store", initial: null, disabled: false, onContinue: async customer => customers.push(customer) }));
    return nodes;
  }
  return { render, calls, customers,
    friend() { render().find(n => n.type === "button" && n.props.children === "지인").props.onClick(); },
    name(value) { render().find(n => n.type === "input").props.onChange({ target: { value } }); },
    submit: () => render().find(n => n.type === "form").props.onSubmit({ preventDefault() {} }),
  };
}
const guest = { id: "guest", customer_type: "지체 손님", customer_name: "손님", member_name: "홍지체" };
test("entry has two tabs and resolves a friend to the stored type and member", async () => {
  const app = mount({ data: [guest], error: null });
  assert.ok(!app.render().some(n => n.type === "button" && ["개척자", "지체 손님"].includes(n.props.children)));
  app.friend(); app.name("손님"); await app.submit();
  assert.equal(app.calls[0].p_customer_name, "손님");
  assert.equal(app.customers[0].type, "지체 손님");
  assert.equal(app.customers[0].member, "홍지체");
});
test("external customer can omit a name without looking up friends", async () => {
  const app = mount({ data: [], error: null }); await app.submit();
  assert.equal(app.calls.length, 0); assert.equal(app.customers[0].type, "외부자");
});
test("ambiguous friend names require a choice, missing names and lookup errors do not guess a type", async () => {
  const app = mount({ data: [guest, { ...guest, id: "pioneer", customer_type: "개척자", member_name: "" }], error: null });
  app.friend(); app.name("손님"); await app.submit(); assert.equal(app.customers.length, 0);
  await app.render().find(n => n.type === "button" && JSON.stringify(n.props.children).includes("홍지체")).props.onClick();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(app.customers[0].type, "지체 손님");
  for (const response of [{ data: [], error: null }, { data: null, error: { message: "offline" } }]) {
    const missing = mount(response); missing.friend(); missing.name("누구"); await missing.submit();
    assert.equal(missing.customers.length, 0); assert.ok(missing.render().some(n => n.props.role === "alert"));
  }
});
