"use client";

import { use, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOrderQueue } from "@/lib/useOrderQueue";
import { groupServingOrders } from "@/lib/servingOrders";
import { QueueConnectionStatus } from "@/components/QueueConnectionStatus";
import { PinLock } from "@/components/PinLock";

export default function ServerPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  const queue = useOrderQueue(store_id, "serving");
  const orders = groupServingOrders(queue.items);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [servedCounts, setServedCounts] = useState<Record<string, number>>({});

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds(previous => {
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const markAsServed = async (itemId: string, servedQuantity: number, quantity: number) => {
    setBusy(itemId, true);
    try {
      const { data, error } = await supabase.from("order_items")
        .update({
          served_quantity: servedQuantity + 1,
          status: servedQuantity + 1 === quantity ? "served" : "cooked",
        })
        .eq("id", itemId).eq("status", "cooked").eq("served_quantity", servedQuantity)
        .select("id, served_quantity");
      if (error) throw error;
      if (!data?.length) {
        alert("다른 직원이 먼저 처리했거나 상태가 변경되었습니다. 목록을 확인한 뒤 다시 눌러주세요.");
      } else {
        setServedCounts(previous => ({ ...previous, [itemId]: data[0].served_quantity }));
      }
    } catch (error) {
      console.error("서빙 완료 처리 실패", error);
      alert("서빙 완료 처리에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setBusy(itemId, false);
      queue.refresh();
    }
  };

  const completeOrder = async (orderId: string) => {
    setBusy(orderId, true);
    try {
      // 화면에 표시된 목록이 오래되었어도 미서빙 메뉴가 있으면 완료하지 않는다.
      const { count, error: checkError } = await supabase.from("order_items")
        .select("id", { count: "exact", head: true }).eq("order_id", orderId).neq("status", "served");
      if (checkError) throw checkError;
      if (count !== 0) {
        alert("아직 서빙이 완료되지 않은 메뉴가 있습니다. 목록을 갱신합니다.");
        return;
      }
      const { data, error } = await supabase.from("orders").update({ status: "completed" })
        .eq("id", orderId).eq("store_id", store_id).neq("status", "completed").select("id");
      if (error) throw error;
      if (!data?.length) alert("이미 완료되었거나 상태가 변경된 주문입니다. 목록을 갱신합니다.");
    } catch (error) {
      console.error("주문 완료 처리 실패", error);
      alert("주문 완료 처리에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setBusy(orderId, false);
      queue.refresh();
    }
  };

  return (
    <PinLock storeId={store_id} role="server">
      <div className="container mx-auto p-4 max-w-4xl space-y-6">
        <div className="bg-blue-900 text-white p-4 rounded-lg shadow-md">
          <h1 className="text-2xl font-bold">🏃‍♂️ 홀 서빙 대기열</h1>
          <p className="text-blue-200 text-sm mt-1">
            메뉴를 한 개 전달할 때마다 서빙 완료를 눌러주세요. 모두 전달한 주문은 주문 완료로 마무리하세요.
          </p>
        </div>

        <QueueConnectionStatus {...queue} />

        {queue.loading ? (
          <div className="text-center py-10">목록을 불러오는 중...</div>
        ) : queue.error && orders.length === 0 ? (
          <p className="text-center py-10 text-red-700" role="alert">주문 목록을 확인할 수 없습니다. 다시 조회해 주세요.</p>
        ) : orders.length === 0 ? (
          <div className="text-center py-20 text-gray-500 border-2 border-dashed rounded-xl">
            <p className="text-xl">현재 진행 중인 주문이 없습니다! 👏</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            {orders.map(({ order, items, allServed }) => (
              <Card key={order.id} className={`border-l-4 shadow-sm ${allServed ? "border-l-green-500" : "border-l-blue-500"}`}>
                <CardContent className="p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-bold">주문번호 {order.order_number}번</h2>
                    <span className="rounded bg-blue-50 px-2 py-1 text-sm font-semibold text-blue-800">테이블 {order.table_number}</span>
                  </div>
                  <div className="divide-y">
                    {items.map(item => {
                      const cooked = item.status === "cooked";
                      const served = item.status === "served";
                      const servedQuantity = Math.min(item.quantity, Math.max(
                        served ? item.quantity : item.served_quantity,
                        servedCounts[item.id] ?? 0,
                      ));
                      const fullyServed = servedQuantity === item.quantity;
                      const label = busyIds.has(item.id) ? "처리 중" : fullyServed ? "서빙 완료됨" : cooked ? `서빙 완료 ${servedQuantity}/${item.quantity}` : "조리 중";
                      return (
                        <div key={item.id} className={`flex items-center gap-2 py-3 ${!cooked && !served ? "opacity-50" : ""}`}>
                          <span className={`min-w-0 flex-1 font-semibold break-words ${served ? "text-gray-500" : ""}`}>
                            {item.menu.name} <span className="text-sm font-normal">× {item.quantity}</span>
                          </span>
                          <span className="shrink-0 text-xs text-gray-500">출발: {item.menu.kitchen_group}구역</span>
                          <Button
                            size="sm"
                            variant={cooked || served ? "outline" : "secondary"}
                            className={`relative isolate shrink-0 overflow-hidden min-w-28 ${cooked || served ? "border-blue-600 bg-white text-blue-700 hover:bg-white hover:text-blue-700 disabled:opacity-100" : ""}`}
                            disabled={!cooked || fullyServed || busyIds.has(item.id) || !!queue.error}
                            onClick={() => markAsServed(item.id, servedQuantity, item.quantity)}
                            aria-label={`${item.menu.name} ${label}, ${item.quantity}개 중 ${servedQuantity}개 서빙 완료`}
                          >
                            {(cooked || served) && <span aria-hidden="true" className="absolute inset-y-0 left-0 -z-10 bg-blue-600 transition-[width] duration-200" style={{ width: `${servedQuantity / item.quantity * 100}%` }} />}
                            <span>{label}</span>
                            {(cooked || served) && <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center text-white" style={{ clipPath: `inset(0 ${100 - servedQuantity / item.quantity * 100}% 0 0)` }}>{label}</span>}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="border-t pt-3 space-y-2">
                    <p className={`text-xs ${allServed ? "text-green-700" : "text-gray-500"}`}>
                      {allServed ? "모든 메뉴를 서빙했습니다. 주문을 완료해 주세요." : `서빙 완료 ${items.filter(item => item.status === "served").length} / ${items.length}종`}
                    </p>
                    <Button
                      className="w-full bg-green-600 hover:bg-green-700 text-white"
                      disabled={!allServed || busyIds.has(order.id) || !!queue.error}
                      onClick={() => completeOrder(order.id)}
                    >
                      {busyIds.has(order.id) ? "완료 처리 중..." : "주문 완료"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </PinLock>
  );
}
