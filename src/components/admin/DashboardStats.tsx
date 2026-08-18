"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DashboardStats({ storeId }: { storeId: string }) {
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalOrders: 0,
    pendingItems: 0,
    cookedItems: 0,
  });

  const fetchStats = async () => {
    // 1. Fetch all orders
    const { data: orders } = await supabase.from("orders").select("id").eq("store_id", storeId);
    
    if (!orders || orders.length === 0) return;
    const orderIds = orders.map((o) => o.id);

    // 2. Fetch all order items
    const { data: items } = await supabase
      .from("order_items")
      .select("quantity, status, menu:menus(price)")
      .in("order_id", orderIds);

    if (items) {
      let revenue = 0;
      let pending = 0;
      let cooked = 0;

      items.forEach((item: any) => {
        revenue += (item.menu?.price || 0) * item.quantity;
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

  return (
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
  );
}
