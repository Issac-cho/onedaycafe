"use client";

import { useState, use } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrderQueue } from "@/lib/useOrderQueue";
import { QueueConnectionStatus } from "@/components/QueueConnectionStatus";
import { useConfirmation } from "@/components/useConfirmation";
import { PinLock } from "@/components/PinLock";
import { KitchenHistory } from "@/components/KitchenHistory";

export default function ChefPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  const { confirm, confirmationDialog } = useConfirmation();
  const [kitchenGroup, setKitchenGroup] = useState("1");
  const queue = useOrderQueue(store_id, "pending", kitchenGroup);
  const { items: pendingItems, loading } = queue;
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [cookedCounts, setCookedCounts] = useState<Record<string, number>>({});

  const markAsCooked = async (itemId: string, cookedQuantity: number, quantity: number) => {
    setBusyIds(previous => new Set(previous).add(itemId));
    try {
      const { data, error } = await supabase.from("order_items")
        .update({ cooked_quantity: cookedQuantity + 1, status: cookedQuantity + 1 === quantity ? "cooked" : "pending" })
        .eq("id", itemId).eq("status", "pending").eq("cooked_quantity", cookedQuantity)
        .select("id, cooked_quantity");
      if (error) throw error;
      if (!data?.length) {
        alert("다른 직원이 먼저 처리했거나 상태가 변경되었습니다. 목록을 확인한 뒤 다시 눌러주세요.");
      } else {
        setCookedCounts(previous => ({ ...previous, [itemId]: data[0].cooked_quantity }));
      }
    } catch (error) {
      console.error("조리 완료 처리 실패", error);
      alert("조리 완료 처리에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setBusyIds(previous => {
        const next = new Set(previous);
        next.delete(itemId);
        return next;
      });
      queue.refresh();
    }
  };

  return (
    <PinLock storeId={store_id} role="chef">
    <div className="container mx-auto p-4 max-w-4xl space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-center bg-gray-900 text-white p-4 rounded-lg shadow-md gap-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          👨‍🍳 주방 현황판
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-2">
        <KitchenHistory storeId={store_id} kitchenGroup={kitchenGroup} />
        <div className="flex items-center gap-2 bg-white/10 p-2 rounded">
          <Label htmlFor="kitchenGroup" className="whitespace-nowrap text-white">담당 구역(그룹):</Label>
          <Input 
            id="kitchenGroup" 
            type="number" 
            value={kitchenGroup} 
            onChange={(e) => setKitchenGroup(e.target.value)} 
            className="w-20 text-white"
          />
        </div>
        </div>
      </div>

      <QueueConnectionStatus {...queue} />

      {loading ? (
        <div className="text-center py-10">주문 목록을 불러오는 중...</div>
      ) : queue.error && pendingItems.length === 0 ? (
        <p className="text-center py-10 text-red-700" role="alert">주문 목록을 확인할 수 없습니다. 다시 조회해 주세요.</p>
      ) : pendingItems.length === 0 ? (
        <div className="text-center py-20 text-gray-500 border-2 border-dashed rounded-xl">
          <p className="text-xl">현재 대기 중인 주문이 없습니다! 휴식하세요 ☕</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pendingItems.map((item) => {
            const cookedQuantity = Math.min(item.quantity, Math.max(item.cooked_quantity, cookedCounts[item.id] ?? 0));
            const fullyCooked = cookedQuantity === item.quantity;
            const label = busyIds.has(item.id) ? "처리 중" : cookedQuantity === item.quantity ? "조리 완료됨" : `조리 완료 ${cookedQuantity}/${item.quantity}`;
            const progress = cookedQuantity / item.quantity * 100;
            return (
              <Card key={item.id} className="border-l-4 border-l-yellow-500 shadow-sm animate-in fade-in zoom-in duration-300">
                <CardContent className="p-4 flex justify-between items-center">
                  <div className="min-w-0 flex-1 break-words">
                    <div className="text-sm font-bold text-yellow-600 mb-1">
                      [주문번호: {item.order.order_number}번] 테이블: {item.order.table_number}
                    </div>
                    <h3 className="text-xl font-bold">
                      {item.menu.name} <span className="text-gray-500 ml-2">x {item.quantity}</span>
                    </h3>
                    <div className="text-xs text-gray-400 mt-2">
                      주문 시간: {new Date(item.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                  <Button
                    size="lg"
                    variant="outline"
                    className={`relative isolate shrink-0 overflow-hidden bg-white text-orange-700 hover:bg-white hover:text-orange-700 disabled:opacity-100 h-16 min-w-32 text-base font-bold ml-3 ${fullyCooked ? "border-orange-200" : "border-orange-600"}`}
                    disabled={busyIds.has(item.id) || cookedQuantity === item.quantity || !!queue.error}
                    onClick={async () => {
                      if (cookedQuantity + 1 === item.quantity) {
                        const accepted = await confirm({
                          title: "조리 최종 완료 확인",
                          description: "마지막 1개까지 조리를 마쳤는지 확인해 주세요.",
                          details: [
                            `주문번호 ${item.order.order_number}번 · 테이블 ${item.order.table_number}`,
                            `${item.menu.name} · ${item.menu.kitchen_group}구역`,
                            `조리 완료 ${cookedQuantity}/${item.quantity} → ${item.quantity}/${item.quantity}`,
                          ],
                          confirmLabel: `${item.menu.name} ${item.quantity}개 조리 완료`,
                        });
                        if (!accepted) return;
                      }
                      await markAsCooked(item.id, cookedQuantity, item.quantity);
                    }}
                    aria-label={`${item.menu.name} ${label}, ${item.quantity}개 중 ${cookedQuantity}개 조리 완료`}
                  >
                    <span aria-hidden="true" className={`absolute inset-y-0 left-0 -z-10 transition-[width] duration-200 ${fullyCooked ? "bg-orange-100" : "bg-orange-600"}`} style={{ width: `${progress}%` }} />
                    <span>{label}</span>
                    <span aria-hidden="true" className={`pointer-events-none absolute inset-0 flex items-center justify-center ${fullyCooked ? "text-orange-700" : "text-white"}`} style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}>{label}</span>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
    {confirmationDialog}
    </PinLock>
  );
}
