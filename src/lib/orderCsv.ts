import type { SupabaseClient } from "@supabase/supabase-js";

export type CsvOrderItem = {
  id: string;
  menu_name: string | null;
  menu_price: number | null;
  quantity: number;
  status: string;
  menu: { name: string; price: number } | null;
  order: { order_number: number; table_number: string; payment_method: string; created_at: string };
};

export async function fetchCsvOrderItems(client: SupabaseClient, storeId: string) {
  const items: CsvOrderItem[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("order_items").select(`
      id, menu_name, menu_price, quantity, status,
      menu:menus(name, price),
      order:orders!inner(order_number, table_number, payment_method, created_at)
    `).eq("order.store_id", storeId)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + 499);
    if (error) throw error;
    items.push(...((data ?? []) as unknown as CsvOrderItem[]));
    if (!data || data.length < 500) return items;
  }
}

function csvCell(value: string | number) {
  if (typeof value === "number") return String(value);
  // Excel에서 테이블·메뉴명 등을 수식으로 실행하지 않도록 한다.
  const text = /^[\s]*[=+\-@]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildOrderCsv(items: CsvOrderItem[]) {
  const statusNames: Record<string, string> = { pending: "조리 대기", cooked: "서빙 대기", served: "서빙 완료" };
  const rows = items.map(item => {
    const price = item.menu_price ?? item.menu?.price ?? 0;
    return [
      new Date(item.order.created_at).toLocaleString("ko-KR"),
      item.order.order_number, item.order.table_number, item.order.payment_method,
      item.menu_name || item.menu?.name || "삭제된 메뉴",
      item.quantity, price, price * item.quantity, statusNames[item.status] ?? item.status,
    ].map(csvCell).join(",");
  });
  return "\uFEFF주문시간,주문번호,테이블번호,결제수단,메뉴명,수량,단가,결제금액,상태\r\n" + rows.join("\r\n") + "\r\n";
}
