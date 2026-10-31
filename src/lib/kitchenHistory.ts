import type { SupabaseClient } from "@supabase/supabase-js";

export type KitchenHistoryItem = {
  id: string;
  quantity: number;
  served_quantity: number;
  status: string;
  cooked_at: string | null;
  created_at: string;
  menu_name: string | null;
  menu: { name: string; kitchen_group: number };
  order: { order_number: number; table_number: string };
};

export async function fetchKitchenHistory(client: SupabaseClient, storeId: string, group: string, signal: AbortSignal) {
  if (!/^[1-9]\d*$/.test(group)) throw new Error("담당 구역 번호를 확인해 주세요.");
  const items = new Map<string, KitchenHistoryItem>();
  // 조회 중 새 완료가 추가되어도 같은 항목을 두 번 표시하지 않는다.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("order_items").select(`
      id, quantity, served_quantity, status, cooked_at, created_at, menu_name,
      menu:menus!inner(name, kitchen_group),
      order:orders!inner(order_number, table_number)
    `).eq("order.store_id", storeId).eq("menu.store_id", storeId)
      .eq("menu.kitchen_group", Number(group)).in("status", ["cooked", "served"])
      .order("cooked_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + 499).abortSignal(signal);
    if (error) throw error;
    for (const item of (data ?? []) as unknown as KitchenHistoryItem[]) items.set(item.id, item);
    if (!data || data.length < 500) return [...items.values()];
  }
}
