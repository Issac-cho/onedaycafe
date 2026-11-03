import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { availableMenus, makePlan, verifyPlan } from "./rehearsal-plan.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateTarget(store, expectedName, menus) {
  if (!store || store.name !== expectedName || !/리허설|테스트|부하|test/i.test(store.name)) {
    throw new Error("매장 이름이 일치하고 이름에 리허설·테스트·부하·test 중 하나가 있어야 합니다.");
  }
  if (!availableMenus(menus).length) throw new Error("판매 가능한 일반 메뉴 또는 세트 메뉴가 필요합니다.");
  // 실제 구성품 구역을 검증한다. 사용하지 않는 구역에 가짜 단품을 만들 필요는 없다.
  for (let index = 0; index < availableMenus(menus).length; index++) makePlan(menus, index);
}

export async function runRehearsal(client, storeId, menus, options) {
  const { orders, rpm, cookMs, serveMs, signal, payments = "cash" } = options;
  const runId = randomUUID();
  const report = { runId, startedAt: new Date().toISOString(), plannedOrders: orders,
    submitted: 0, completed: 0, duplicateChecks: 0, conflicts: 0, transientRetries: 0, setLines: 0, optionLines: 0, kitchenUnits: {}, menuCoverage: {}, paymentCounts: {}, retryLog: [], errors: [], timings: {}, requests: [] };
  let stopped = false, producersDone = false, nextOrder = 0;
  const kitchens = Array.from({ length: 7 }, () => []);
  const accepted = [];
  const accounts = new Map();
  const started = Date.now();
  const shouldStop = () => stopped || signal?.aborted;
  const wait = async ms => {
    const end = Date.now() + ms;
    while (!shouldStop() && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
  };
  const call = async (label, factory) => {
    const before = performance.now();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const { data, error, count } = await factory();
          if (error) throw error;
          return { data, count };
        } catch (error) {
          const message = error.message ?? String(error);
          const transient = [408, 429, 502, 503, 504].includes(error.status)
            || /502|503|504|fetch failed|network request failed|timed? ?out|abort/i.test(message);
          if (!transient || attempt >= 3 || shouldStop()) throw error;
          report.transientRetries++;
          report.retryLog.push({ label, attempt: attempt + 1, time: new Date().toISOString(), message: message.slice(0, 200) });
          await wait(500 * 2 ** attempt);
          if (shouldStop()) throw error;
        }
      }
    } finally {
      (report.timings[label] ??= []).push(performance.now() - before);
    }
  };
  const guarded = async (role, action) => {
    try { await action(); }
    catch (error) {
      report.errors.push({ role, time: new Date().toISOString(), status: error.status, code: error.code, message: (error.message ?? String(error)).slice(0, 1000) });
      stopped = true;
    }
  };
  const produce = async actor => {
    let balance = 0;
    const customerName = `TEST-${runId}-${actor + 1}`;
    while (!shouldStop()) {
      const index = nextOrder++;
      if (index >= orders) return;
      // 6명이 동시에 접수하는 묶음을 만들고 전체 평균 주문 속도를 맞춘다.
      await wait(Math.max(0, started + Math.floor(index / 6) * 6 * 60000 / rpm - Date.now()));
      if (shouldStop()) return;
      const plan = makePlan(menus, index);
      const used = payments === "mixed" ? Math.min(balance, plan.revenue) : 0;
      const due = plan.revenue - used;
      const credited = payments === "mixed" && balance === 0 ? Math.max(plan.revenue, 1) : 0;
      const method = used === plan.revenue && used > 0 ? "쿠폰" : used > 0 ? "쿠폰+현금" : "현금";
      const expectedPayment = { used, due, received: due + credited, credited };
      const args = { p_request_id: randomUUID(), p_store_id: storeId,
        p_table_number: `TEST-${runId.slice(0, 8)}-${index + 1}`, p_payment_method: method,
        p_customer_type: "외부자", p_customer_name: payments === "mixed" ? customerName : "", p_member_name: "", p_coupon_used: used, p_cash_received: credited > 0 ? due + credited : null,
        p_items: plan.items };
      const request = { requestId: args.p_request_id, table: args.p_table_number, items: plan.items, paymentMethod: method, customerName: args.p_customer_name };
      report.requests.push(request);
      const { data: order } = await call("submit", () => client.rpc("submit_customer_order", args));
      report.submitted++;
      request.orderId = order.id; request.orderNumber = order.order_number;
      if (index % 10 === 0) {
        const { data: repeated } = await call("retry", () => client.rpc("submit_customer_order", args));
        if (order.id !== repeated.id || order.order_number !== repeated.order_number) throw new Error("동일 요청의 재시도로 주문이 달라졌습니다.");
        report.duplicateChecks++;
      }
      const { data: items } = await call("readItems", () => client.from("order_items").select("id, menu_id, menu_name, quantity, menu_price, cooked_quantity, served_quantity, status, sale_line_id, set_name, sale_quantity, cooked_at").eq("order_id", order.id));
      const { data: sales } = await call("readSales", () => client.from("order_sales").select("*").eq("order_id", order.id));
      verifyPlan(plan, sales, items);
      const tracked = { ...order, items, expected: args.p_items, plan, expectedPayment, completed: false };
      accepted.push(tracked);
      balance = balance - used + credited;
      if (payments === "mixed") accounts.set(customerName, balance);
      report.paymentCounts[method] = (report.paymentCounts[method] ?? 0) + 1;
      for (const line of plan.lines) {
        const coverage = report.menuCoverage[line.menu_id] ??= { name: line.name, lines: 0, quantity: 0 };
        coverage.lines++; coverage.quantity += line.quantity;
      }
      report.setLines += plan.lines.filter(line => line.type === "set").length;
      report.optionLines += plan.lines.filter(line => line.input.selections?.length).length;
      for (const item of items) {
        const sale = sales.find(sale => sale.id === item.sale_line_id);
        const work = plan.lines.find(line => line.menu_id === sale.menu_id).work.find(work => work.menu_id === item.menu_id);
        report.kitchenUnits[work.group] = (report.kitchenUnits[work.group] ?? 0) + item.quantity;
        kitchens[work.group - 1].push(item);
      }
    }
  };
  const cook = async group => {
    while (!shouldStop()) {
      const item = kitchens[group].shift();
      if (!item) {
        if (producersDone) return;
        await wait(100); continue;
      }
      while (item.cooked_quantity < item.quantity && !shouldStop()) {
        await wait(cookMs);
        if (shouldStop()) return;
        const next = item.cooked_quantity + 1;
        const { data } = await call("cook", () => client.from("order_items")
          .update({ cooked_quantity: next, status: next === item.quantity ? "cooked" : "pending" })
          .eq("id", item.id).eq("status", "pending").eq("cooked_quantity", item.cooked_quantity).select("id"));
        if (!data?.length) {
          const { data: stored } = await call("recoverCook", () => client.from("order_items").select("cooked_quantity").eq("id", item.id).single());
          if (stored?.cooked_quantity !== next) { report.conflicts++; throw new Error("조리 상태 충돌: 테스트 화면에서는 수량을 직접 변경하지 마세요."); }
        }
        item.cooked_quantity = next;
      }
    }
  };
  const serve = async () => {
    while (!shouldStop()) {
      const order = accepted.find(order => !order.completed && order.items.some(item => item.cooked_quantity > item.served_quantity));
      if (!order) {
        if (producersDone && accepted.every(order => order.completed)) return;
        await wait(100); continue;
      }
      const item = order.items.find(item => item.cooked_quantity > item.served_quantity);
      await wait(serveMs);
      if (shouldStop()) return;
      // 최신 조리 수량을 읽고 실제 서빙 화면과 같은 조건부 갱신을 수행한다.
      const { data: current } = await call("readServing", () => client.from("order_items").select("cooked_quantity, served_quantity, quantity").eq("id", item.id).single());
      const next = current.served_quantity + 1;
      if (next > current.cooked_quantity) throw new Error("서빙할 준비 수량이 부족합니다.");
      const { data } = await call("serve", () => client.from("order_items")
        .update({ served_quantity: next, status: next === current.quantity ? "served" : current.cooked_quantity === current.quantity ? "cooked" : "pending" })
        .eq("id", item.id).eq("cooked_quantity", current.cooked_quantity).eq("served_quantity", current.served_quantity).select("id"));
      if (!data?.length) {
        const { data: stored } = await call("recoverServe", () => client.from("order_items").select("served_quantity").eq("id", item.id).single());
        if (stored?.served_quantity !== next) { report.conflicts++; continue; }
      }
      item.served_quantity = next;
      if (order.items.every(item => item.served_quantity === item.quantity)) {
        const { count } = await call("checkComplete", () => client.from("order_items").select("id", { count: "exact", head: true }).eq("order_id", order.id).neq("status", "served"));
        if (count !== 0) throw new Error("완료 전 수량 검사에 실패했습니다.");
        const { data } = await call("complete", () => client.from("orders").update({ status: "completed" }).eq("id", order.id).eq("store_id", storeId).neq("status", "completed").select("id"));
        if (!data?.length) {
          const { data: stored } = await call("recoverComplete", () => client.from("orders").select("status").eq("id", order.id).eq("store_id", storeId).single());
          if (stored?.status !== "completed") throw new Error("주문 완료 처리에 실패했습니다.");
        }
        order.completed = true;
        report.completed++;
      }
    }
  };

  const { data: baseline } = await call("baselineStats", () => client.rpc("get_dashboard_totals", { p_store_id: storeId }));
  const producerJobs = Array.from({ length: 6 }, (_, index) => guarded(`주문${index + 1}`, () => produce(index)));
  const kitchenJobs = Array.from({ length: 7 }, (_, index) => guarded(`주방${index + 1}`, () => cook(index)));
  const servingJob = guarded("서빙", serve);
  const progress = setInterval(() => console.log(`접수 ${report.submitted}/${orders} · 완료 ${report.completed} · 충돌 ${report.conflicts} · 재시도 ${report.transientRetries}`), 10000);
  try {
    await Promise.all(producerJobs);
    producersDone = true;
    await Promise.all([...kitchenJobs, servingJob]);
    await guarded("최종 검증", async () => {
      const numbers = new Set();
      for (const order of accepted) {
        const { data: stored } = await call("verifyOrder", () => client.from("orders").select("status, order_number, cash_due, cash_received, coupon_used, coupon_credited").eq("id", order.id).single());
        const { data: items } = await call("verifyItems", () => client.from("order_items").select("*").eq("order_id", order.id));
        if (numbers.has(stored.order_number)) throw new Error("중복 주문번호 발견");
        numbers.add(stored.order_number);
        const { data: sales } = await call("verifySales", () => client.from("order_sales").select("*").eq("order_id", order.id));
        verifyPlan(order.plan, sales, items, true);
        if (stored.status !== "completed" || stored.cash_due !== order.expectedPayment.due || stored.cash_received !== order.expectedPayment.received
          || stored.coupon_used !== order.expectedPayment.used || stored.coupon_credited !== order.expectedPayment.credited) throw new Error(`주문 ${order.order_number}의 결제·완료 상태 불일치`);
      }
      for (const [name, balance] of accounts) {
        const { data } = await call("verifyBalance", () => client.rpc("lookup_coupon_account", { p_store_id: storeId, p_customer_type: "외부자", p_customer_name: name, p_member_name: "" }));
        if (data?.balance !== balance) throw new Error("리허설 전용 쿠폰 잔액 불일치");
      }
      const { data: totals } = await call("finalStats", () => client.rpc("get_dashboard_totals", { p_store_id: storeId }));
      const expectedRevenue = accepted.reduce((sum, order) => sum + order.expected.reduce((subtotal, item) => subtotal + item.unit_price * item.quantity, 0), 0);
      for (const [field, key] of [["couponUsed", "used"], ["cashDue", "due"], ["cashReceived", "received"], ["couponCredited", "credited"]]) {
        const expected = accepted.reduce((sum, order) => sum + order.expectedPayment[key], 0);
        if (totals[field] - baseline[field] !== expected) throw new Error(`${field} 결제 통계 불일치`);
      }
      report.testCouponAccounts = [...accounts].map(([name, balance]) => ({ name, expectedBalance: balance }));
      report.expectedRevenue = expectedRevenue;
      report.actualRevenueIncrease = totals.totalRevenue - baseline.totalRevenue;
      if (totals.totalOrders - baseline.totalOrders !== orders || report.actualRevenueIncrease !== expectedRevenue
        || totals.pendingItems !== baseline.pendingItems || totals.cookedItems !== baseline.cookedItems) throw new Error("테스트 전후 통계 증가량이 예상 결과와 다릅니다.");
    });
  } finally { clearInterval(progress); }
  report.uncoveredMenus = availableMenus(menus).filter(menu => !report.menuCoverage[menu.id]).map(menu => ({ id: menu.id, name: menu.name }));
  report.interrupted = !!signal?.aborted;
  report.passed = !report.interrupted && !report.errors.length && report.completed === orders;
  report.elapsedSeconds = (Date.now() - started) / 1000;
  report.timings = Object.fromEntries(Object.entries(report.timings).map(([label, values]) => {
    values.sort((a, b) => a - b);
    return [label, { count: values.length, p95Ms: Math.round(values[Math.ceil(values.length * 0.95) - 1]), maxMs: Math.round(values.at(-1)) }];
  }));
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    "store-id": { type: "string" }, "store-name": { type: "string" },
    orders: { type: "string", default: "60" }, rpm: { type: "string", default: "12" },
    "cook-ms": { type: "string", default: "300" }, "serve-ms": { type: "string", default: "300" },
    payments: { type: "string", default: "cash" },
    run: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log('node scripts/rehearsal.mjs --store-id UUID --store-name "리허설 전용" [--orders 60 --rpm 12 --cook-ms 300 --serve-ms 300] [--payments cash|mixed] [--run]');
    return;
  }
  if (!values["store-id"] || !values["store-name"]) throw new Error("--store-id와 --store-name을 지정해 주세요. --help로 사용법을 확인하세요.");
  const options = { orders: Number(values.orders), rpm: Number(values.rpm), cookMs: Number(values["cook-ms"]), serveMs: Number(values["serve-ms"]), payments: values.payments };
  if (!["cash", "mixed"].includes(options.payments)) throw new Error("--payments는 cash 또는 mixed로 지정해 주세요.");
  if (!Number.isInteger(options.orders) || options.orders < 1 || !Number.isFinite(options.rpm) || options.rpm <= 0
    || !Number.isFinite(options.cookMs) || options.cookMs < 0 || !Number.isFinite(options.serveMs) || options.serveMs < 0) throw new Error("주문 수·속도·처리 지연 값을 확인해 주세요.");
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }) },
  });
  const { data: store, error } = await client.from("stores").select("id,name").eq("id", values["store-id"]).single();
  if (error) throw error;
  const menus = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("menus").select("*").eq("store_id", store.id).order("id").range(offset, offset + 499);
    if (error) throw error;
    menus.push(...data);
    if (data.length < 500) break;
  }
  validateTarget(store, values["store-name"], menus);
  console.log(`대상: ${store.name} (${store.id}) · 판매 메뉴 ${availableMenus(menus).length}개 (세트·옵션 포함) · 주문6/주방7/서빙1 · ${options.orders}건, 분당 ${options.rpm}건 · 결제 ${options.payments}`);
  if (!values.run) { console.log("설정 확인만 완료했습니다. 주문을 실제 생성하려면 --run을 추가하세요."); return; }
  const controller = new AbortController();
  process.once("SIGINT", () => { console.log("신규 처리를 중지하고 현재 요청 결과를 정리합니다."); controller.abort(); });
  const report = await runRehearsal(client, store.id, menus, { ...options, signal: controller.signal });
  await mkdir("test-results", { recursive: true });
  const path = `test-results/rehearsal-${report.runId}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`${report.passed ? "PASS" : "FAIL/중단"} · 접수 ${report.submitted} · 완료 ${report.completed} · 보고서 ${path}`);
  console.log(`세트 판매 ${report.setLines}행 · 옵션 판매 ${report.optionLines}행 · 일시 오류 재시도 ${report.transientRetries}회`);
  if (report.uncoveredMenus.length) console.log(`이번 실행에서 선택되지 않은 판매 메뉴 ${report.uncoveredMenus.length}개: 보고서를 확인하세요.`);
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message ?? String(error)); process.exitCode = 1; });
}
