import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateTarget(store, expectedName, menus) {
  if (!store || store.name !== expectedName || !/리허설|테스트|부하|test/i.test(store.name)) {
    throw new Error("매장 이름이 일치하고 이름에 리허설·테스트·부하·test 중 하나가 있어야 합니다.");
  }
  if (![1, 2, 3, 4, 5, 6, 7].every(group => menus.some(menu => menu.kitchen_group === group))) {
    throw new Error("주방 1~7구역에 판매 가능한 메뉴를 각각 1개 이상 등록해 주세요.");
  }
}

export async function runRehearsal(client, storeId, menus, options) {
  const { orders, rpm, cookMs, serveMs, signal } = options;
  const runId = randomUUID();
  const report = { runId, startedAt: new Date().toISOString(), plannedOrders: orders,
    submitted: 0, completed: 0, duplicateChecks: 0, conflicts: 0, errors: [], timings: {}, requests: [] };
  let stopped = false, producersDone = false, nextOrder = 0;
  const kitchens = Array.from({ length: 7 }, () => []);
  const accepted = [];
  const started = Date.now();
  const shouldStop = () => stopped || signal?.aborted;
  const wait = async ms => {
    const end = Date.now() + ms;
    while (!shouldStop() && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
  };
  const call = async (label, query) => {
    const before = performance.now();
    try {
      const { data, error, count } = await query;
      if (error) throw error;
      return { data, count };
    } finally {
      (report.timings[label] ??= []).push(performance.now() - before);
    }
  };
  const guarded = async (role, action) => {
    try { await action(); }
    catch (error) {
      report.errors.push({ role, message: error.message ?? String(error) });
      stopped = true;
    }
  };
  const produce = async () => {
    while (!shouldStop()) {
      const index = nextOrder++;
      if (index >= orders) return;
      // 6명이 동시에 접수하는 묶음을 만들고 전체 평균 주문 속도를 맞춘다.
      await wait(Math.max(0, started + Math.floor(index / 6) * 6 * 60000 / rpm - Date.now()));
      if (shouldStop()) return;
      const chosen = [index % 7 + 1, (index + 1) % 7 + 1, (index + 2) % 7 + 1]
        .map(group => menus.filter(menu => menu.kitchen_group === group))
        .map((groupMenus, offset) => groupMenus[(index + offset) % groupMenus.length]);
      const args = { p_request_id: randomUUID(), p_store_id: storeId,
        p_table_number: `TEST-${runId.slice(0, 8)}-${index + 1}`, p_payment_method: "현금",
        p_items: chosen.map((menu, offset) => ({ menu_id: menu.id, quantity: (index + offset) % 5 + 1, unit_price: menu.price })) };
      report.requests.push({ requestId: args.p_request_id, table: args.p_table_number });
      const { data: order } = await call("submit", client.rpc("submit_order", args));
      report.submitted++;
      if (index % 10 === 0) {
        const { data: repeated } = await call("retry", client.rpc("submit_order", args));
        if (order.id !== repeated.id || order.order_number !== repeated.order_number) throw new Error("동일 요청의 재시도로 주문이 달라졌습니다.");
        report.duplicateChecks++;
      }
      const { data: items } = await call("readItems", client.from("order_items").select("id, menu_id, quantity, menu_price, cooked_quantity, served_quantity, status").eq("order_id", order.id));
      if (!items || items.length !== args.p_items.length) throw new Error("주문 상세 개수가 맞지 않습니다.");
      const tracked = { ...order, items, expected: args.p_items, completed: false };
      accepted.push(tracked);
      for (const item of items) kitchens[chosen.find(menu => menu.id === item.menu_id).kitchen_group - 1].push(item);
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
        const { data } = await call("cook", client.from("order_items")
          .update({ cooked_quantity: next, status: next === item.quantity ? "cooked" : "pending" })
          .eq("id", item.id).eq("status", "pending").eq("cooked_quantity", item.cooked_quantity).select("id"));
        if (!data?.length) { report.conflicts++; throw new Error("조리 상태 충돌: 테스트 화면에서는 수량을 직접 변경하지 마세요."); }
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
      const { data: current } = await call("readServing", client.from("order_items").select("cooked_quantity, served_quantity, quantity").eq("id", item.id).single());
      const next = current.served_quantity + 1;
      if (next > current.cooked_quantity) throw new Error("서빙할 준비 수량이 부족합니다.");
      const { data } = await call("serve", client.from("order_items")
        .update({ served_quantity: next, status: next === current.quantity ? "served" : current.cooked_quantity === current.quantity ? "cooked" : "pending" })
        .eq("id", item.id).eq("cooked_quantity", current.cooked_quantity).eq("served_quantity", current.served_quantity).select("id"));
      if (!data?.length) { report.conflicts++; continue; }
      item.served_quantity = next;
      if (order.items.every(item => item.served_quantity === item.quantity)) {
        const { count } = await call("checkComplete", client.from("order_items").select("id", { count: "exact", head: true }).eq("order_id", order.id).neq("status", "served"));
        if (count !== 0) throw new Error("완료 전 수량 검사에 실패했습니다.");
        const { data } = await call("complete", client.from("orders").update({ status: "completed" }).eq("id", order.id).eq("store_id", storeId).neq("status", "completed").select("id"));
        if (!data?.length) throw new Error("주문 완료 처리에 실패했습니다.");
        order.completed = true;
        report.completed++;
      }
    }
  };

  const { data: baseline } = await call("baselineStats", client.rpc("get_dashboard_totals", { p_store_id: storeId }));
  const producerJobs = Array.from({ length: 6 }, (_, index) => guarded(`주문${index + 1}`, produce));
  const kitchenJobs = Array.from({ length: 7 }, (_, index) => guarded(`주방${index + 1}`, () => cook(index)));
  const servingJob = guarded("서빙", serve);
  const progress = setInterval(() => console.log(`접수 ${report.submitted}/${orders} · 완료 ${report.completed} · 충돌 ${report.conflicts}`), 10000);
  try {
    await Promise.all(producerJobs);
    producersDone = true;
    await Promise.all([...kitchenJobs, servingJob]);
    await guarded("최종 검증", async () => {
      const numbers = new Set();
      for (const order of accepted) {
        const { data: stored } = await call("verifyOrder", client.from("orders").select("status, order_number").eq("id", order.id).single());
        const { data: items } = await call("verifyItems", client.from("order_items").select("menu_id, quantity, menu_price, cooked_quantity, served_quantity, status").eq("order_id", order.id));
        if (numbers.has(stored.order_number)) throw new Error("중복 주문번호 발견");
        numbers.add(stored.order_number);
        if (stored.status !== "completed" || items.length !== order.expected.length || order.expected.some(expected => {
          const item = items.find(item => item.menu_id === expected.menu_id);
          return !item || item.quantity !== expected.quantity || item.menu_price !== expected.unit_price
            || item.cooked_quantity !== item.quantity || item.served_quantity !== item.quantity || item.status !== "served";
        })) throw new Error(`주문 ${order.order_number}의 저장 상태·수량·금액 불일치`);
      }
      const { data: totals } = await call("finalStats", client.rpc("get_dashboard_totals", { p_store_id: storeId }));
      const expectedRevenue = accepted.reduce((sum, order) => sum + order.expected.reduce((subtotal, item) => subtotal + item.unit_price * item.quantity, 0), 0);
      report.expectedRevenue = expectedRevenue;
      report.actualRevenueIncrease = totals.totalRevenue - baseline.totalRevenue;
      if (totals.totalOrders - baseline.totalOrders !== orders || report.actualRevenueIncrease !== expectedRevenue
        || totals.pendingItems !== baseline.pendingItems || totals.cookedItems !== baseline.cookedItems) throw new Error("테스트 전후 통계 증가량이 예상 결과와 다릅니다.");
    });
  } finally { clearInterval(progress); }
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
    run: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log('node scripts/rehearsal.mjs --store-id UUID --store-name "리허설 전용" [--orders 60 --rpm 12 --cook-ms 300 --serve-ms 300] [--run]');
    return;
  }
  if (!values["store-id"] || !values["store-name"]) throw new Error("--store-id와 --store-name을 지정해 주세요. --help로 사용법을 확인하세요.");
  const options = { orders: Number(values.orders), rpm: Number(values.rpm), cookMs: Number(values["cook-ms"]), serveMs: Number(values["serve-ms"]) };
  if (!Number.isInteger(options.orders) || options.orders < 1 || !Number.isFinite(options.rpm) || options.rpm <= 0
    || !Number.isFinite(options.cookMs) || options.cookMs < 0 || !Number.isFinite(options.serveMs) || options.serveMs < 0) throw new Error("주문 수·속도·처리 지연 값을 확인해 주세요.");
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }) },
  });
  const { data: store, error } = await client.from("stores").select("id,name").eq("id", values["store-id"]).single();
  if (error) throw error;
  const { data: menus, error: menuError } = await client.from("menus").select("id,price,kitchen_group")
    .eq("store_id", store.id).eq("is_sold_out", false).eq("is_hidden", false).eq("is_deleted", false);
  if (menuError) throw menuError;
  validateTarget(store, values["store-name"], menus);
  console.log(`대상: ${store.name} (${store.id}) · 메뉴 ${menus.length}개 · 주문6/주방7/서빙1 · ${options.orders}건, 분당 ${options.rpm}건`);
  if (!values.run) { console.log("설정 확인만 완료했습니다. 주문을 실제 생성하려면 --run을 추가하세요."); return; }
  const controller = new AbortController();
  process.once("SIGINT", () => { console.log("신규 처리를 중지하고 현재 요청 결과를 정리합니다."); controller.abort(); });
  const report = await runRehearsal(client, store.id, menus, { ...options, signal: controller.signal });
  await mkdir("test-results", { recursive: true });
  const path = `test-results/rehearsal-${report.runId}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`${report.passed ? "PASS" : "FAIL/중단"} · 접수 ${report.submitted} · 완료 ${report.completed} · 보고서 ${path}`);
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message ?? String(error)); process.exitCode = 1; });
}
