import type { SupabaseClient } from "@supabase/supabase-js";

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
