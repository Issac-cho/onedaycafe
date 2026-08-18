"use client";

import { useEffect, useState, use } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PinLock } from "@/components/PinLock";

export default function ChefPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  const [kitchenGroup, setKitchenGroup] = useState("1");
  const [pendingItems, setPendingItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPendingItems = async () => {
    const { data, error } = await supabase
      .from("order_items")
      .select(`
        id, quantity, status, created_at,
        menu:menus!inner(id, name, kitchen_group, store_id),
        order:orders!inner(id, table_number, order_number)
      `)
      .eq("status", "pending")
      .eq("menu.store_id", store_id)
      .order("created_at", { ascending: true });

    if (data) {
      const filtered = data.filter((item: any) => item.menu.kitchen_group.toString() === kitchenGroup);
      setPendingItems(filtered);
    }
    setLoading(false);
  };
/* ... skip to render ... */
/* wait, replace_file_content needs contiguous lines. Let's do them in two steps */

  useEffect(() => {
    fetchPendingItems();

    // Set up real-time subscription
    const channel = supabase
      .channel('public:order_items')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        fetchPendingItems(); // Re-fetch on any change
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [store_id, kitchenGroup]);

  const markAsCooked = async (itemId: string) => {
    const { error } = await supabase
      .from("order_items")
      .update({ status: "cooked" })
      .eq("id", itemId);

    if (error) {
      alert("처리 실패: " + error.message);
    }
    // Optimistic UI update or wait for real-time
    fetchPendingItems();
  };

  return (
    <PinLock storeId={store_id} role="chef">
    <div className="container mx-auto p-4 max-w-4xl space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-center bg-gray-900 text-white p-4 rounded-lg shadow-md gap-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          👨‍🍳 주방 현황판
        </h1>
        <div className="flex items-center gap-2 bg-white/10 p-2 rounded">
          <Label htmlFor="kitchenGroup" className="whitespace-nowrap text-white">담당 구역(그룹):</Label>
          <Input 
            id="kitchenGroup" 
            type="number" 
            value={kitchenGroup} 
            onChange={(e) => setKitchenGroup(e.target.value)} 
            className="w-20 text-black"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10">주문 목록을 불러오는 중...</div>
      ) : pendingItems.length === 0 ? (
        <div className="text-center py-20 text-gray-500 border-2 border-dashed rounded-xl">
          <p className="text-xl">현재 대기 중인 주문이 없습니다! 휴식하세요 ☕</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pendingItems.map((item) => (
            <Card key={item.id} className="border-l-4 border-l-yellow-500 shadow-sm animate-in fade-in zoom-in duration-300">
              <CardContent className="p-4 flex justify-between items-center">
                <div>
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
                  className="bg-yellow-500 hover:bg-yellow-600 text-white h-16 w-24 text-lg font-bold"
                  onClick={() => markAsCooked(item.id)}
                >
                  조리<br/>완료
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
