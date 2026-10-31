"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Customer } from "@/lib/couponPayment";
import { supabase } from "@/lib/supabase";

type Friend = { id: string; customer_type: "개척자" | "지체 손님"; customer_name: string; member_name: string };

export function CustomerEntry({ storeId, initial, onContinue, disabled }: { storeId: string; initial: Customer | null; onContinue: (customer: Customer) => Promise<void>; disabled: boolean }) {
  const [type, setType] = useState<"외부자" | "지인">(initial && initial.type !== "외부자" ? "지인" : "외부자");
  const [name, setName] = useState(initial?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const chooseFriend = async (friend: Friend) => {
    setBusy(true);
    try { await onContinue({ type: friend.customer_type, name: friend.customer_name, member: friend.member_name }); }
    finally { setBusy(false); }
  };
  return <form className="mx-auto w-full max-w-md space-y-5 rounded-xl border p-6" onSubmit={async e => {
    e.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    try {
      setError(null); setMatches([]);
      if (type === "외부자") { await onContinue({ type, name: name.trim(), member: "" }); return; }
      const { data, error } = await supabase.rpc("find_friend_accounts", { p_store_id: storeId, p_customer_name: name.trim() }).abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("손님 조회 응답 오류");
      if (!data.length) { setError("등록된 지인 정보가 없습니다. 관리자에게 이름과 손님 구분을 등록해 달라고 요청해 주세요."); return; }
      if (data.length === 1) await chooseFriend(data[0]);
      else setMatches(data);
    } catch { setError("지인 정보를 조회하지 못했습니다. 연결을 확인하고 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }}>
    <h1 className="text-2xl font-bold">손님 정보</h1>
    <fieldset disabled={busy || disabled} className="space-y-5">
      <div className="flex gap-2">{(["외부자", "지인"] as const).map(value =>
        <Button key={value} type="button" variant={type === value ? "default" : "outline"} aria-pressed={type === value} onClick={() => { setType(value); setName(""); setMatches([]); setError(null); }}>{value}</Button>)}</div>
      <div className="space-y-2"><Label htmlFor="customer-name">손님 이름{type === "외부자" ? " (선택)" : ""}</Label><Input id="customer-name" value={name} onChange={e => { setName(e.target.value); setMatches([]); setError(null); }} required={type !== "외부자"} maxLength={100} /></div>
      <p className="text-sm text-gray-500">등록된 이름을 정확히 입력해 주세요. 동명이인은 홍길동2처럼 구분된 이름을 사용합니다.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {matches.length > 1 && <div className="space-y-2"><p className="text-sm">같은 이름의 지인이 여러 명입니다. 해당 손님을 선택해 주세요.</p>{matches.map(friend => <Button key={friend.id} type="button" variant="outline" className="w-full" onClick={() => void chooseFriend(friend)}>{friend.customer_type} · {friend.customer_name}{friend.customer_type === "지체 손님" ? ` · 지체: ${friend.member_name || "미등록"}` : ""}</Button>)}</div>}
      <Button type="submit" className="w-full" disabled={(type !== "외부자" && !name.trim())}>{busy ? "확인 중..." : "주문 받기"}</Button>
    </fieldset>
  </form>;
}
