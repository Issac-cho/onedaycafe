"use client";

import { useEffect, useState, use } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PinLock } from "@/components/PinLock";

export default function ServerPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  const [cookedItems, setCookedItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCookedItems = async () => {
    const { data, error } = await supabase
      .from("order_items")
      .select(`
        id, quantity, status, created_at,
        menu:menus!inner(id, name, kitchen_group, store_id),
        order:orders!inner(id, table_number, order_number)
      `)
      .eq("status", "cooked")
      .eq("menu.store_id", store_id)
      .order("created_at", { ascending: true });

    if (data) {
      setCookedItems(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchCookedItems();

    // Set up real-time subscription
    const channel = supabase
      .channel('public:order_items_server')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        fetchCookedItems(); // Re-fetch on any change
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [store_id]);

  const markAsServed = async (itemId: string) => {
    const { error } = await supabase
      .from("order_items")
      .update({ status: "served" })
      .eq("id", itemId);

    if (error) {
      alert("처리 실패: " + error.message);
    }
    fetchCookedItems();
  };

  return (
    <PinLock storeId={store_id} role="server">
    <div className="container mx-auto p-4 max-w-4xl space-y-6">
      <div className="bg-blue-900 text-white p-4 rounded-lg shadow-md">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          🏃‍♂️ 홀 서빙 대기열
        </h1>
        <p className="text-blue-200 text-sm mt-1">
          주방에서 조리가 완료된 요리들입니다. 손님 테이블로 전달 후 '서빙 완료'를 눌러주세요.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-10">목록을 불러오는 중...</div>
      ) : cookedItems.length === 0 ? (
        <div className="text-center py-20 text-gray-500 border-2 border-dashed rounded-xl">
          <p className="text-xl">현재 서빙 대기 중인 요리가 없습니다! 👏</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cookedItems.map((item) => (
            <Card key={item.id} className="border-l-4 border-l-blue-500 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
              <CardContent className="p-4 flex justify-between items-center">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">
                      주문번호: {item.order.order_number}
                    </span>
                    <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">
                      테이블: {item.order.table_number}
                    </span>
                    <span className="bg-gray-100 text-gray-600 text-xs font-bold px-2 py-1 rounded">
                      출발: {item.menu.kitchen_group}구역
                    </span>
                  </div>
                  <h3 className="text-xl font-bold">
                    {item.menu.name} <span className="text-gray-500 ml-1">x {item.quantity}</span>
                  </h3>
                </div>
                <Button 
                  size="lg" 
                  className="bg-blue-600 hover:bg-blue-700 text-white h-16 w-24 text-lg font-bold"
                  onClick={() => markAsServed(item.id)}
                >
                  서빙<br/>완료
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
    </PinLock>
  );
}
