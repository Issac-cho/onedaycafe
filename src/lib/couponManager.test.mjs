import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
const require = createRequire(import.meta.url);
function load(path, dependencies = {}, globals = {}) {
  const exports = {};
  const code = require("typescript").transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: 1, target: 7, jsx: 4 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name] ?? require(name), ...globals });
  return exports;
}
async function mount(responses = [], saved = new Map()) {
  const hooks = [], effects = [], calls = [], alerts = [];
  let cursor = 0;
  const account = { id: "account", customer_type: "개척자", customer_name: "홍길동", member_name: "", balance: 20000 };
  const query = { select() { return this; }, eq() { return this; }, order() { return this; }, range() { return this; },
    abortSignal: async () => ({ data: [account], error: null }) };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === "function" ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(effect) { const i = cursor++; if (!(i in hooks)) { hooks[i] = true; effects.push(effect); } },
  };
  const dependencies = { react, "@/lib/couponPayment": load("./couponPayment.ts"), "@/lib/orderSubmission": load("./orderSubmission.ts"),
    "@/lib/supabase": { supabase: { from: () => query, rpc(name, args) {
      if (name === "get_coupon_admin_totals") return { abortSignal: async () => ({ data: { registered: 20000, charged: 0 }, error: null }) };
      assert.equal(name, "manage_coupon_account"); calls.push(args);
      return { abortSignal: async () => responses.shift() ?? { data: { id: "account", balance: 30000 }, error: null } };
    } } },
    "@/components/ui/button": { Button: "button" }, "@/components/ui/input": { Input: "input" }, "@/components/ui/label": { Label: "label" },
    "@/components/useConfirmation": { useConfirmation: () => ({ confirm: async () => true, confirmationDialog: null }) },
  };
  const { CouponManager } = load("../components/admin/CouponManager.tsx", dependencies, {
    sessionStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) },
    crypto: { randomUUID }, AbortSignal, alert: value => alerts.push(value),
  });
  function render() {
    cursor = 0; const nodes = [];
    function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (!node?.props) return; nodes.push(node); visit(node.props.children); }
    visit(CouponManager({ storeId: "store" })); return nodes;
  }
  render(); effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve));
  return { calls, alerts, saved, render,
    input(id, value) { render().find(n => n.props.id === id).props.onChange({ target: { value } }); },
    select() { render().find(n => n.type === "button" && n.props.children === "추가 충전").props.onClick(); },
    submit: () => render().find(n => n.type === "form").props.onSubmit({ preventDefault() {} }),
    async retry() { render().find(n => n.type === "button" && n.props.children === "충전 결과 확인 / 재시도").props.onClick(); await new Promise(resolve => setImmediate(resolve)); },
  };
}
test("admin registration and additional charge send distinct operations", async () => {
  const registration = await mount();
  registration.input("admin-customer", "홍길동2"); registration.input("admin-amount", "10000");
  await registration.submit();
  assert.equal(registration.calls[0].p_create, true);
  assert.equal(registration.calls[0].p_customer_name, "홍길동2");
  const charge = await mount(); charge.select(); charge.input("admin-amount", "10000"); await charge.submit();
  assert.equal(charge.calls[0].p_create, false);
  assert.equal(charge.calls[0].p_amount, 10000, "send addition, not the resulting 30000 balance");
});
test("uncertain admin charge survives reload and retries identical request", async () => {
  const app = await mount([{ data: null, error: { message: "response lost" } }]);
  app.select(); app.input("admin-amount", "10000"); await app.submit();
  assert.equal(app.render().find(n => n.type === "fieldset").props.disabled, true);
  const restored = await mount([], app.saved); await restored.retry();
  assert.equal(JSON.stringify(restored.calls[0]), JSON.stringify(app.calls[0]));
  assert.equal(app.saved.size, 0);
});
test("invalid charge and corrupt pending storage cannot submit", async () => {
  const app = await mount(); app.select(); app.input("admin-amount", "0"); await app.submit();
  assert.equal(app.calls.length, 0);
  const corrupt = await mount([], new Map([["coupon_admin_pending_store", "broken"]]));
  assert.equal(corrupt.render().find(n => n.type === "fieldset").props.disabled, true);
  await corrupt.submit(); assert.equal(corrupt.calls.length, 0);
});

test("guest account registration has only a guest name field", async () => {
  const app = await mount();
  app.render().find(n => n.type === "button" && n.props.children === "지체 손님").props.onClick();
  assert.ok(!app.render().some(n => n.props.id === "admin-member"));
  app.input("admin-customer", "손님이름"); app.input("admin-amount", "10000");
  await app.submit();
  assert.equal(app.calls[0].p_customer_type, "지체 손님");
  assert.equal(app.calls[0].p_customer_name, "손님이름");
  assert.equal(app.calls[0].p_member_name, "");
});
