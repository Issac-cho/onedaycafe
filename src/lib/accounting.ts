import type { SupabaseClient } from "@supabase/supabase-js";
import { customerTypeLabel } from "./couponPayment";

export type AccountingSale = {
  id: string;
  menu_name: string;
  menu_price: number;
  quantity: number;
  option_summary: string;
  components: { menu_name: string; quantity: number }[];
};

export type AccountingOrder = {
  id: string;
  order_number: number;
  table_number: string;
  created_at: string;
  status: string;
  payment_method: string;
  customer_type: string | null;
  customer_name: string | null;
  member_name: string | null;
  coupon_used: number | null;
  cash_due: number | null;
  cash_received: number | null;
  coupon_credited: number | null;
  sales: AccountingSale[];
};

export function koreaToday() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

export function accountingDateRange(date: string) {
  const start = new Date(`${date}T00:00:00+09:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

export async function fetchAccountingOrders(client: SupabaseClient, storeId: string, date: string, signal: AbortSignal) {
  const orders: AccountingOrder[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = client.from("orders").select(`
      id, order_number, table_number, created_at, status, payment_method,
      customer_type, customer_name, member_name, coupon_used, cash_due, cash_received, coupon_credited,
      sales:order_sales(id, menu_name, menu_price, quantity, option_summary, components)
    `).eq("store_id", storeId);
    if (date) {
      const range = accountingDateRange(date);
      query = query.gte("created_at", range.start).lt("created_at", range.end);
    }
    const { data, error } = await query.order("order_number", { ascending: true })
      .range(offset, offset + 499).abortSignal(signal);
    if (error) throw error;
    orders.push(...((data ?? []) as unknown as AccountingOrder[]));
    if (!data || data.length < 500) return orders;
  }
}

export function accountingOrderAmount(order: AccountingOrder) {
  if (!order.sales.length) return null;
  return order.sales.reduce((sum, sale) => sum + sale.menu_price * sale.quantity, 0);
}

export function accountingTotals(orders: AccountingOrder[]) {
  // 과거 주문의 미기록 결제값을 0원으로 단정하지 않는다.
  const sum = (key: "coupon_used" | "cash_due" | "cash_received" | "coupon_credited") =>
    orders.some(order => order[key] == null) ? null : orders.reduce((total, order) => total + order[key]!, 0);
  return {
    amount: orders.some(order => !order.sales.length) ? null : orders.reduce((total, order) => total + accountingOrderAmount(order)!, 0),
    coupon: sum("coupon_used"), cashDue: sum("cash_due"), cashReceived: sum("cash_received"), credited: sum("coupon_credited"),
  };
}

export function accountingPage(orders: AccountingOrder[], search: string, page: number) {
  const term = search.trim();
  const filtered = orders.filter(order => !term || [String(order.order_number), order.table_number, order.customer_name ?? "", order.member_name ?? ""].some(value => value.includes(term)))
    .sort((a, b) => b.order_number - a.order_number);
  const pages = Math.max(1, Math.ceil(filtered.length / 30));
  const current = Math.max(1, Math.min(page, pages));
  const start = (current - 1) * 30;
  return { orders: filtered.slice(start, start + 30), total: filtered.length, pages, current, start };
}

export const accountingClipboardHeaders = ["주문번호", "접수 시각", "테이블", "손님유형", "손님이름", "소개한 분", "메뉴·옵션·수량·금액", "결제수단", "주문금액", "쿠폰 사용", "필요 현금", "받은 현금", "쿠폰 적립", "주문 상태"].join("\t");

export function accountingOrderTsv(order: AccountingOrder) {
  const menus = order.sales.map(sale => [
    `${sale.menu_name} × ${sale.quantity} (단가 ${sale.menu_price}원, 금액 ${sale.menu_price * sale.quantity}원)`,
    sale.option_summary ? `옵션: ${sale.option_summary}` : "",
    sale.components?.length ? `세트 1개 구성: ${sale.components.map(part => `${part.menu_name} × ${part.quantity}`).join(" / ")}` : "",
  ].filter(Boolean).join(" · ")).join(" / ");
  return [
    order.order_number,
    new Date(order.created_at).toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }),
    order.table_number, customerTypeLabel(order.customer_type ?? "미기록"), order.customer_name ?? "", order.member_name ?? "",
    menus, order.payment_method, accountingOrderAmount(order), order.coupon_used, order.cash_due, order.cash_received, order.coupon_credited,
    order.status === "completed" ? "주문 완료" : "진행 중",
  ].map(value => {
    if (value == null) return "미기록";
    if (typeof value === "number") return String(value);
    // 한 주문은 한 행으로 붙이고, 입력된 이름·테이블 등이 수식으로 실행되지 않게 한다.
    const text = value.replace(/[\t\r\n]+/g, " ");
    return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
  }).join("\t");
}
