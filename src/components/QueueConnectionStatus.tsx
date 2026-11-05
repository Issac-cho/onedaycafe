"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export function QueueConnectionStatus({ storeId, connected, error, lastUpdated, refresh }: {
  storeId: string;
  connected: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}) {
  const [store, setStore] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function loadStore() {
      const { data, error } = await supabase.from("stores").select("name")
        .eq("id", storeId).abortSignal(controller.signal).maybeSingle();
      if (!controller.signal.aborted && !error && data) {
        setStore({ id: storeId, name: data.name });
      }
    }
    void loadStore();
    return () => controller.abort();
  }, [storeId]);

  const storeName = store?.id === storeId ? store.name : null;
  return (
    <div className="flex items-center gap-2 whitespace-nowrap rounded-md border px-2 py-1 text-xs" role="status">
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <span className={`size-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} aria-hidden="true" />
        {connected ? "연결 중" : "연결 끊김"}
      </span>
      <span className="min-w-0 truncate text-gray-500">
        마지막 갱신: {lastUpdated ? lastUpdated.toLocaleTimeString("ko-KR", { hour12: false }) : "—"}
      </span>
      {error && <span className="shrink-0 text-red-700" role="alert" title={`${error} 이전 목록은 최신 상태가 아닐 수 있습니다.`}>조회 실패</span>}
      {storeName && <span className="ml-auto min-w-0 truncate text-black" title={storeName}>{storeName}</span>}
      <Button type="button" variant="ghost" size="icon-xs" className={`shrink-0 rounded-full text-gray-500 ${storeName ? "" : "ml-auto"}`} onClick={refresh} aria-label="목록 다시 조회" title="목록 다시 조회">
        <RefreshCw aria-hidden="true" />
      </Button>
    </div>
  );
}
