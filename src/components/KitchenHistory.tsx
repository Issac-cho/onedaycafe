"use client";

import { useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fetchKitchenHistory, type KitchenHistoryItem } from "@/lib/kitchenHistory";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function KitchenHistory({ storeId, kitchenGroup }: { storeId: string; kitchenGroup: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<KitchenHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(50);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    void Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true); setError(null); setItems([]); setUpdatedAt(null);
      try {
        const fetched = await fetchKitchenHistory(supabase, storeId, kitchenGroup, controller.signal);
        if (active) { setItems(fetched); setVisible(50); setUpdatedAt(new Date()); }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "완료 내역을 조회하지 못했습니다. 다시 시도해 주세요.");
      } finally {
        clearTimeout(timeout);
        if (active) setLoading(false);
      }
    });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [open, storeId, kitchenGroup, revision]);

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button type="button" variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white" />}>
      <History className="size-4" aria-hidden="true" />완료 내역
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{kitchenGroup}구역 조리 완료 내역</DialogTitle>
        <DialogDescription>메뉴 수량 전체를 조리 완료한 기록입니다. 서빙 완료된 메뉴도 포함됩니다.</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-between gap-2 text-sm text-gray-500">
        <span>{updatedAt ? `${items.length}건 · 조회 ${updatedAt.toLocaleTimeString("ko-KR")}` : "완료 기록 조회"}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="완료 내역 다시 조회" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw className="size-4" /></Button>
      </div>
      {loading ? <p role="status" className="py-8 text-center text-gray-500">완료 내역을 불러오는 중...</p>
        : error ? <p role="alert" className="py-4 text-red-700">{error}</p>
        : !items.length ? <p className="py-8 text-center text-gray-500">이 구역의 조리 완료 내역이 없습니다.</p>
        : <ul className="space-y-3">{items.slice(0, visible).map(item => <li key={item.id} className="rounded-lg border p-3 space-y-1">
          <div className="flex flex-wrap justify-between gap-1"><p className="font-semibold">주문 {item.order.order_number}번 · 테이블 {item.order.table_number}</p><span className="text-xs text-gray-500">{item.served_quantity === item.quantity ? "서빙 완료" : `서빙 ${item.served_quantity}/${item.quantity}`}</span></div>
          <p>{item.menu_name || item.menu.name} × {item.quantity}</p>
          <p className="text-xs text-gray-500">{item.cooked_at ? `조리 완료 ${new Date(item.cooked_at).toLocaleString("ko-KR")}` : `완료 시각 미기록 · 접수 ${new Date(item.created_at).toLocaleString("ko-KR")}`}</p>
        </li>)}</ul>}
      {!loading && !error && visible < items.length && <Button type="button" variant="outline" onClick={() => setVisible(value => value + 50)}>이전 내역 더 보기 ({items.length - visible}건 남음)</Button>}
    </DialogContent>
  </Dialog>;
}
