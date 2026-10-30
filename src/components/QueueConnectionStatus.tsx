"use client";

import { Button } from "@/components/ui/button";

export function QueueConnectionStatus({ connected, error, lastUpdated, refresh }: {
  connected: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}) {
  return (
    <div className="rounded-lg border p-3 space-y-2 text-sm" role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={connected ? "text-green-700" : "text-amber-700"}>
          {connected ? "실시간 연결됨 · 5초 간격 보조 조회" : "실시간 연결 확인 중 · 5초 간격으로 목록 재조회"}
        </span>
        <Button variant="outline" size="sm" onClick={refresh}>목록 다시 조회</Button>
      </div>
      <p className="text-gray-500">마지막 갱신: {lastUpdated ? lastUpdated.toLocaleTimeString() : "아직 확인되지 않음"}</p>
      {error && <p className="text-red-700" role="alert">{error} 이전 목록은 최신 상태가 아닐 수 있습니다.</p>}
    </div>
  );
}
