"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createQueueAlertTracker, type AlertItem, type AlertMode } from "@/lib/queueAlerts";

export function QueueSoundAlert({ mode, items, loading, error }: {
  mode: AlertMode;
  items: AlertItem[];
  loading: boolean;
  error: string | null;
}) {
  const tracker = useRef<ReturnType<typeof createQueueAlertTracker> | null>(null);
  if (tracker.current === null) tracker.current = createQueueAlertTracker(mode);
  const audio = useRef<HTMLAudioElement | null>(null);
  const allowed = useRef(false);
  const active = useRef(true);
  const [enabled, setEnabled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [soundError, setSoundError] = useState<string | null>(null);

  const failed = () => {
    allowed.current = false;
    if (active.current) { setEnabled(false); setSoundError("알림음 재생 실패 · 다시 켜거나 기기 음량을 확인해 주세요."); }
  };
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; allowed.current = false; audio.current?.pause(); };
  }, []);
  useEffect(() => {
    if (loading || error) return;
    const changed = tracker.current!(items);
    if (changed && allowed.current && audio.current?.paused) {
      audio.current.currentTime = 0;
      void audio.current.play().catch(failed);
    }
  }, [items, loading, error]);

  const play = async () => {
    setStarting(true); setSoundError(null);
    try {
      audio.current ??= new Audio("/onedaycafe-alert.wav");
      audio.current.currentTime = 0;
      await audio.current.play();
      if (active.current) { allowed.current = true; setEnabled(true); }
    } catch { failed(); }
    finally { if (active.current) setStarting(false); }
  };
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <Button type="button" variant="outline" size="sm" disabled={starting} aria-pressed={enabled} onClick={() => {
      if (!enabled) { void play(); return; }
      allowed.current = false; audio.current?.pause(); setEnabled(false);
    }}>{starting ? "소리 확인 중..." : enabled ? "🔔 알림음 켜짐" : "🔕 알림음 켜기"}</Button>
    {enabled ? <Button type="button" variant="ghost" size="sm" disabled={starting} onClick={() => void play()}>소리 테스트</Button>
      : <span className="text-gray-500">화면을 열 때 한 번 눌러 주세요. 시험 소리가 재생됩니다.</span>}
    {soundError && <span role="alert" className="text-red-700">{soundError}</span>}
  </div>;
}
