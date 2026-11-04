"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { fetchAccountingOrders, type AccountingOrder } from "./accounting";

export function useAccountingOrders(storeId: string, date: string) {
  const [orders, setOrders] = useState<AccountingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let active = true, running = false, queued = false;
    let controller: AbortController | undefined;
    const fetchOrders = async () => {
      if (!active) return;
      if (running) { queued = true; return; }
      running = true;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 10000);
      try {
        const result = await fetchAccountingOrders(supabase, storeId, date, request.signal);
        if (active) { setOrders(result); setError(null); setLastUpdated(new Date()); }
      } catch {
        if (active) setError("주문 정보를 갱신하지 못했습니다. 이전 목록은 최신 상태가 아닐 수 있습니다. 연결을 확인하고 다시 조회해 주세요.");
      } finally {
        clearTimeout(timeout);
        running = false;
        if (active) {
          setLoading(false);
          if (queued) { queued = false; void fetchOrders(); }
        }
      }
    };
    const refreshVisible = () => { if (document.visibilityState === "visible") void fetchOrders(); };
    const offline = () => { if (active) setConnected(false); };
    refreshRef.current = () => { void fetchOrders(); };
    void Promise.resolve().then(() => {
      if (!active) return;
      setOrders([]); setLoading(true); setError(null); setConnected(false); setLastUpdated(null);
      void fetchOrders();
    });
    // 주문·판매 행·결제 정보는 같은 트랜잭션으로 저장된다. orders 알림 후 완성된 판매 내역을 읽는다.
    const channel = supabase.channel(`accounting:${storeId}:${date || "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `store_id=eq.${storeId}` }, () => { void fetchOrders(); })
      .subscribe(state => {
        if (!active) return;
        setConnected(state === "SUBSCRIBED");
        if (state === "SUBSCRIBED") void fetchOrders();
      });
    const interval = setInterval(refreshVisible, 5000);
    window.addEventListener("online", refreshVisible);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      active = false; refreshRef.current = () => {};
      controller?.abort(); clearInterval(interval);
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      void supabase.removeChannel(channel);
    };
  }, [storeId, date]);
  return { orders, loading, error, connected, lastUpdated, refresh };
}
