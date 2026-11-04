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
    "@/lib/couponPayment": { customerTypeLabel: type => ({ "개척자": "DSM 졸업생", "지체 손님": "지인 소개", "외부자": "기타" })[type] ?? type },
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
    tab(label) { render().find(n => n.type === "button" && n.props.children === label).props.onClick(); },
    name(value) { render().find(n => n.type === "input").props.onChange({ target: { value } }); },
    submit: () => render().find(n => n.type === "form").props.onSubmit({ preventDefault() {} }),
  };
}
const guest = { id: "guest", customer_type: "지체 손님", customer_name: "손님", member_name: "홍지체" };
const alumni = { id: "alumni", customer_type: "개척자", customer_name: "손님", member_name: "" };
test("three arrival tabs default to alumni and keep the selected legacy account type", async () => {
  const app = mount({ data: [guest, alumni], error: null });
  assert.ok(app.render().some(n => n.type === "h1" && n.props.children === "어떻게 오셨나요?"));
  assert.equal(app.render().filter(n => n.props["aria-pressed"] !== undefined).length, 3);
  assert.equal(app.render().find(n => n.props.children === "DSM 졸업생").props["aria-pressed"], true);
  app.name("손님"); await app.submit();
  assert.equal(app.customers[0].type, "개척자");
  app.tab("지인 소개"); app.name("손님"); await app.submit();
  assert.equal(app.customers[1].type, "지체 손님");
  assert.equal(app.customers[1].member, "홍지체");
});
test("other allows an omitted name without a friend lookup", async () => {
  const app = mount({ data: [], error: null });
  app.tab("기타"); await app.submit();
  assert.equal(app.calls.length, 0);
  assert.equal(app.customers[0].type, "외부자");
});
test("referrer search selects a guest rather than using the search as the customer name", async () => {
  const app = mount({ data: [guest, { ...guest, id: "guest2", customer_name: "손님2" }, alumni], error: null });
  app.tab("지인 소개"); app.name("홍지체"); await app.submit();
  assert.equal(app.customers.length, 0);
  assert.equal(app.calls[0].p_customer_name, "홍지체");
  await app.render().find(n => n.type === "button" && JSON.stringify(n.props.children).includes("손님2")).props.onClick();
  assert.equal(app.customers[0].name, "손님2");
  assert.equal(app.customers[0].member, "홍지체");
});
test("unregistered alumni continue directly without choosing a type again", async () => {
  const app = mount({ data: [guest], error: null });
  app.name(" 새졸업생 "); await app.submit();
  assert.equal(app.customers[0].type, "개척자");
  assert.equal(app.customers[0].name, "새졸업생");
});
test("unregistered referral can enter an optional referrer and changing tabs clears the draft", async () => {
  const app = mount({ data: [], error: null });
  app.tab("지인 소개"); app.name("새손님"); await app.submit();
  assert.equal(app.customers.length, 0);
  app.render().find(n => n.props.id === "new-guest-member").props.onChange({ target: { value: " 홍지체 " } });
  await app.submit();
  assert.equal(app.customers[0].name, "새손님");
  assert.equal(app.customers[0].member, "홍지체");
  assert.equal(app.customers[0].type, "지체 손님");
  assert.equal(app.calls.length, 1);
  app.tab("DSM 졸업생");
  assert.ok(!app.render().some(n => n.props.id === "new-guest-member"));
});
test("lookup failures do not proceed as unregistered customers", async () => {
  for (const tab of ["DSM 졸업생", "지인 소개"]) {
    const app = mount({ data: null, error: { message: "offline" } });
    app.tab(tab); app.name("손님"); await app.submit();
    assert.equal(app.customers.length, 0);
    assert.ok(app.render().some(n => n.props.role === "alert"));
  }
});
