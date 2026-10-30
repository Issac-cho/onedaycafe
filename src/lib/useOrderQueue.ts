"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

export type QueueItem = {
  id: string;
  quantity: number;
  served_quantity: number;
  status: string;
  created_at: string;
  menu: { id: string; name: string; kitchen_group: number; store_id: string };
  order: { id: string; table_number: string; order_number: number; status: string };
};

export function useOrderQueue(storeId: string, status: "pending" | "cooked" | "serving", kitchenGroup?: string) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let active = true;
    let running = false;
    let queued = false;
    let controller: AbortController | undefined;

    const fetchItems = async () => {
      if (!active) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const allItems: QueueItem[] = [];
        for (let offset = 0; ; offset += 500) {
          let query = supabase.from("order_items").select(`
            id, quantity, served_quantity, status, created_at,
            menu:menus!inner(id, name, kitchen_group, store_id),
            order:orders!inner(id, table_number, order_number, status)
          `).eq("menu.store_id", storeId).eq("order.store_id", storeId);
          if (status === "serving") {
            query = query.neq("order.status", "completed");
          } else {
            query = query.eq("status", status);
          }
          if (kitchenGroup !== undefined) {
            query = query.eq("menu.kitchen_group", Number(kitchenGroup));
          }
          const { data, error } = await query.order("created_at", { ascending: true })
            .order("id", { ascending: true }).range(offset, offset + 499)
            .abortSignal(controller.signal);
          if (error) throw error;
          allItems.push(...((data ?? []) as unknown as QueueItem[]));
          if (!data || data.length < 500) break;
        }
        if (active) {
          setItems(allItems);
          setError(null);
          setLastUpdated(new Date());
        }
      } catch (error) {
        if (active) {
          console.error("주문 목록 조회 실패", error);
          setError("목록을 갱신하지 못했습니다. 연결을 확인하세요. 자동으로 다시 시도합니다.");
        }
      } finally {
        clearTimeout(timeout);
        running = false;
        if (active) {
          setLoading(false);
          if (queued) {
            queued = false;
            void fetchItems();
          }
        }
      }
    };

    const refreshVisible = () => {
      if (document.visibilityState === "visible") void fetchItems();
    };
    const offline = () => setConnected(false);
    refreshRef.current = () => { void fetchItems(); };
    void Promise.resolve().then(() => {
      if (!active) return;
      setItems([]);
      setLoading(true);
      setError(null);
      setConnected(false);
      setLastUpdated(null);
      void fetchItems();
    });

    const channel = supabase.channel(`queue:${storeId}:${status}:${kitchenGroup ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, () => {
        void fetchItems();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `store_id=eq.${storeId}` }, () => {
        void fetchItems();
      })
      .subscribe((state, error) => {
        if (!active) return;
        setConnected(state === "SUBSCRIBED");
        if (state === "SUBSCRIBED") void fetchItems();
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          console.error("주문 Realtime 연결 실패", state, error);
        }
      });

    const interval = setInterval(refreshVisible, 5000);
    window.addEventListener("online", refreshVisible);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      active = false;
      refreshRef.current = () => {};
      controller?.abort();
      clearInterval(interval);
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      void supabase.removeChannel(channel);
    };
  }, [storeId, status, kitchenGroup]);

  return { items, loading, error, connected, lastUpdated, refresh };
}
