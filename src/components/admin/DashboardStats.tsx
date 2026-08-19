"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function DashboardStats({ storeId }: { storeId: string }) {
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalOrders: 0,
    pendingItems: 0,
    cookedItems: 0,
  });
  const [downloading, setDownloading] = useState(false);

  const fetchStats = async () => {
    // 1. Fetch all orders
    const { data: orders } = await supabase.from("orders").select("id").eq("store_id", storeId);
    
    if (!orders || orders.length === 0) return;
    const orderIds = orders.map((o) => o.id);

    // 2. Fetch all order items
    const { data: items } = await supabase
      .from("order_items")
      .select("quantity, status, menu_price, menu:menus(price)")
      .in("order_id", orderIds);

    if (items) {
      let revenue = 0;
      let pending = 0;
      let cooked = 0;

      items.forEach((item: any) => {
        // Fallback to menu.price if menu_price is null (for old data)
        const price = item.menu_price ?? item.menu?.price ?? 0;
        revenue += price * item.quantity;
        if (item.status === "pending") pending += item.quantity;
        if (item.status === "cooked") cooked += item.quantity;
      });

      setStats({
        totalRevenue: revenue,
        totalOrders: orders.length,
        pendingItems: pending,
        cookedItems: cooked,
      });
    }
  };

  useEffect(() => {
    fetchStats();
    
    // Realtime updates
    const channel = supabase.channel('dashboard_stats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        fetchStats();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        fetchStats();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [storeId]);

  const downloadCSV = async () => {
    setDownloading(true);
    try {
      // Fetch all orders for this store
      const { data: ordersData, error: ordersError } = await supabase
        .from("orders")
        .select("id, order_number, table_number, payment_method, created_at")
        .eq("store_id", storeId)
        .order("created_at", { ascending: true });

      if (ordersError || !ordersData || ordersData.length === 0) {
        alert("다운로드할 데이터가 없습니다.");
        return;
      }

      const orderIds = ordersData.map(o => o.id);

      // Fetch all order items
      const { data: itemsData, error: itemsError } = await supabase
        .from("order_items")
        .select("order_id, menu_name, menu_price, quantity, status, menu:menus(name, price)")
        .in("order_id", orderIds);

      if (itemsError) throw itemsError;

      // Group items by order_id for easier lookup
      const itemsByOrderId = itemsData.reduce((acc, item) => {
        if (!acc[item.order_id]) acc[item.order_id] = [];
        acc[item.order_id].push(item);
        return acc;
      }, {} as Record<string, any[]>);

      // Create CSV rows
      let csvContent = "\uFEFF"; // BOM for Excel UTF-8 support
      csvContent += "주문시간,주문번호,테이블번호,결제수단,메뉴명,수량,단가,결제금액,상태\n";

      ordersData.forEach(order => {
        const orderTime = new Date(order.created_at).toLocaleString();
        const items = itemsByOrderId[order.id] || [];
        
        items.forEach(item => {
          const menuName = item.menu_name || item.menu?.name || "삭제된 메뉴";
          const menuPrice = item.menu_price ?? item.menu?.price ?? 0;
          const totalPrice = menuPrice * item.quantity;
          
          let statusText = "";
          if (item.status === "pending") statusText = "조리 대기";
          if (item.status === "cooked") statusText = "서빙 대기";
          if (item.status === "served") statusText = "서빙 완료";

          csvContent += `"${orderTime}",${order.order_number},"${order.table_number}","${order.payment_method}","${menuName}",${item.quantity},${menuPrice},${totalPrice},"${statusText}"\n`;
        });
      });

      // Trigger download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `onedaycafe_data_${new Date().getTime()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e: any) {
      alert("다운로드 중 오류가 발생했습니다: " + e.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={downloadCSV} disabled={downloading} variant="outline" className="bg-green-50 text-green-700 hover:bg-green-100 border-green-200">
          {downloading ? "다운로드 중..." : "📊 데이터 다운로드 (CSV)"}
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">총 누적 매출</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-extrabold text-primary">{stats.totalRevenue.toLocaleString()}원</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">총 주문 건수</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats.totalOrders}건</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">조리 대기 (밀림)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-yellow-600">{stats.pendingItems}개</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">서빙 대기 (완료됨)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">{stats.cookedItems}개</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
