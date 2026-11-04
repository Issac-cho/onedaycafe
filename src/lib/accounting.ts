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

export type AccountingClipboardColumn = { menu: string };

export function accountingClipboardColumns(orders: AccountingOrder[], existing: AccountingClipboardColumn[] = []) {
  const columns = [...existing];
  const seen = new Set(columns.map(column => column.menu));
  for (const order of [...orders].sort((a, b) => a.order_number - b.order_number)) {
    for (const sale of [...order.sales].sort((a, b) => a.menu_name.localeCompare(b.menu_name))) {
      if (!seen.has(sale.menu_name)) { seen.add(sale.menu_name); columns.push({ menu: sale.menu_name }); }
    }
  }
  return columns;
}

export function parseAccountingClipboardColumns(value: string | null): AccountingClipboardColumn[] {
  if (!value) return [];
  const columns: unknown = JSON.parse(value);
  if (!Array.isArray(columns) || !columns.every(column => column && typeof column.menu === "string" && !("options" in column))) throw new Error("잘못된 엑셀 열 설정");
  return columns;
}

function clipboardCell(value: string | number | null) {
  if (value == null) return "미기록";
  if (typeof value === "number") return String(value);
  // 한 주문은 한 행으로 붙이고, 입력된 이름·테이블 등이 수식으로 실행되지 않게 한다.
  const text = value.replace(/[\t\r\n]+/g, " ");
  return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
}

export function accountingClipboardHeaders(columns: AccountingClipboardColumn[]) {
  return ["주문번호", "접수 시각", "테이블", "손님유형", "손님이름", "소개한 분", "메뉴·옵션·수량", "결제수단", "주문금액", "쿠폰 사용", "필요 현금", "받은 현금", "쿠폰 적립", "주문 상태",
    ...columns.map(column => column.menu),
  ].map(clipboardCell).join("\t");
}

function accountingOptionLabel(sale: AccountingSale) {
  const values = (text: string) => text.split(", ").map(group => {
    const colon = group.indexOf(": ");
    return colon < 0 ? group : group.slice(colon + 2);
  }).join(", ").replace(/\s*\/\s*/g, "/");
  const summary = sale.option_summary || "";
  if (!sale.components?.length) return values(summary);
  return summary.split(" · ").map(component => {
    const colon = component.indexOf(": ");
    return colon < 0 ? values(component) : `${component.slice(0, colon)}: ${values(component.slice(colon + 2))}`;
  }).join(", ");
}

export function accountingOrderTsv(order: AccountingOrder, columns: AccountingClipboardColumn[]) {
  const counts = new Map<string, Map<string, { label: string; quantity: number }>>();
  for (const sale of order.sales) {
    let options = counts.get(sale.menu_name);
    if (!options) { options = new Map(); counts.set(sale.menu_name, options); }
    const summary = sale.option_summary || "";
    options.set(summary, { label: accountingOptionLabel(sale), quantity: (options.get(summary)?.quantity ?? 0) + sale.quantity });
  }
  if (accountingClipboardColumns([order], columns).length !== columns.length) throw new Error("메뉴 열이 누락되었습니다. 열 제목을 먼저 갱신해 주세요.");
  const menus = order.sales.map(sale => [
    `${sale.menu_name} × ${sale.quantity}`,
    accountingOptionLabel(sale),
  ].filter(Boolean).join(" · ")).join(" / ");
  return [
    order.order_number,
    new Date(order.created_at).toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }),
    order.table_number, customerTypeLabel(order.customer_type ?? "미기록"), order.customer_name ?? "", order.member_name ?? "",
    menus, order.payment_method, accountingOrderAmount(order), order.coupon_used, order.cash_due, order.cash_received, order.coupon_credited,
    order.status === "completed" ? "주문 완료" : "진행 중",
    ...columns.map(column => {
      const options = counts.get(column.menu);
      if (!options) return 0;
      if (options.size === 1 && options.has("")) return options.get("")!.quantity;
      return [...options].sort(([a], [b]) => a.localeCompare(b)).map(([, { label, quantity }]) => `${label || "기본"} : ${quantity}`).join(", ");
    }),
  ].map(clipboardCell).join("\t");
}
