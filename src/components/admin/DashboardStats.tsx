"use client";

import { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { Info } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { fetchCsvOrderItems, buildOrderCsv } from "@/lib/orderCsv";

type DashboardTotals = { totalRevenue: number; totalOrders: number; pendingItems: number; cookedItems: number; couponUsed: number; cashDue: number; cashReceived: number; couponCredited: number };

export function DashboardStats({ storeId }: { storeId: string }) {
  const [stats, setStats] = useState<DashboardTotals | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);

  useEffect(() => {
    let active = true;
    let running = false;
    let queued = false;
    const fetchStats = async () => {
      if (!active) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        const { data, error } = await supabase.rpc("get_dashboard_totals", { p_store_id: storeId })
          .abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        if (!data || ![data.totalRevenue, data.totalOrders, data.pendingItems, data.cookedItems, data.couponUsed, data.cashDue, data.cashReceived, data.couponCredited].every(Number.isFinite)) {
          throw new Error("통계 응답을 확인할 수 없습니다.");
        }
        if (active) { setStats(data); setStatsError(false); }
      } catch (error) {
        console.error("통계 조회 실패", error);
        if (active) setStatsError(true);
      } finally {
        running = false;
        if (active && queued) { queued = false; void fetchStats(); }
      }
    };
    void Promise.resolve().then(() => { if (active) { setStats(null); setStatsError(false); void fetchStats(); } });
    const channel = supabase.channel(`dashboard_stats:${storeId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, () => { void fetchStats(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `store_id=eq.${storeId}` }, () => { void fetchStats(); })
      .subscribe(status => { if (status === "SUBSCRIBED") void fetchStats(); });
    const refreshVisible = () => { if (document.visibilityState === "visible") void fetchStats(); };
    const interval = setInterval(refreshVisible, 15000);
    window.addEventListener("online", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
      void supabase.removeChannel(channel);
    };
  }, [storeId]);

  const downloadCSV = async () => {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);
    try {
      const items = await fetchCsvOrderItems(supabase, storeId);
      if (!items.length) { alert("다운로드할 데이터가 없습니다."); return; }
      const blob = new Blob([buildOrderCsv(items)], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `onedaycafe_data_${Date.now()}.csv`;
      document.body.appendChild(link);
      try { link.click(); }
      finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      console.error("CSV 다운로드 실패", error);
      alert("다운로드에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-1">
        <Button onClick={downloadCSV} disabled={downloading} variant="outline" className="bg-green-50 text-green-700 hover:bg-green-100 border-green-200">
          {downloading ? "다운로드 중..." : "📊 데이터 다운로드 (CSV)"}
        </Button>
        <Dialog>
          <DialogTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="CSV 다운로드 안내" title="CSV 다운로드 안내" />}>
            <Info className="size-4 text-gray-500" aria-hidden="true" />
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>CSV 다운로드 안내</DialogTitle>
              <DialogDescription>
                정확한 기록을 위해 모든 작업을 중지하고 다운로드하는 것을 권장합니다.
                주문 접수와 조리·서빙 처리를 잠시 멈춘 브레이크 타임이나 영업 종료 후 이용해 주세요.
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </div>
      {statsError && <p className="text-sm text-red-700" role="alert">통계를 갱신하지 못했습니다. 표시된 값은 최신 상태가 아닐 수 있습니다. 자동으로 다시 시도합니다.</p>}
      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-gray-50 p-3 text-sm">
        <span>쿠폰 사용 {stats?.couponUsed.toLocaleString() ?? "—"}원</span>
        <span>주문 현금 {stats?.cashDue.toLocaleString() ?? "—"}원</span>
        <span>실제 받은 현금 {stats?.cashReceived.toLocaleString() ?? "—"}원</span>
        <span>초과액 적립 {stats?.couponCredited.toLocaleString() ?? "—"}원</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">총 누적 매출</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-extrabold text-primary">{stats?.totalRevenue.toLocaleString() ?? "—"}원</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">총 주문 건수</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.totalOrders ?? "—"}건</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">조리 대기 (밀림)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-yellow-600">{stats?.pendingItems ?? "—"}개</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 font-medium">서빙 대기 (완료됨)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">{stats?.cookedItems ?? "—"}개</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
