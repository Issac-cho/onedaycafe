"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { customerTypeLabel, type Customer } from "@/lib/couponPayment";
import { supabase } from "@/lib/supabase";

type Friend = { id: string; customer_type: "개척자" | "지체 손님"; customer_name: string; member_name: string };

export function CustomerEntry({ storeId, initial, onContinue, disabled }: { storeId: string; initial: Customer | null; onContinue: (customer: Customer) => Promise<void>; disabled: boolean }) {
  const [type, setType] = useState<Customer["type"]>(initial?.type ?? "개척자");
  const [name, setName] = useState(initial?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<Friend[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [member, setMember] = useState("");
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
      if (notFound && type === "지체 손님") {
        await onContinue({ type: "지체 손님", name: name.trim(), member: member.trim() });
        return;
      }
      setError(null); setMatches([]); setNotFound(false);
      if (type === "외부자") { await onContinue({ type, name: name.trim(), member: "" }); return; }
      const { data, error } = await supabase.rpc("find_friend_accounts", { p_store_id: storeId, p_customer_name: name.trim() }).abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("손님 조회 응답 오류");
      const friends = (data as Friend[]).filter(friend => friend.customer_type === type);
      if (!friends.length) {
        if (type === "개척자") { await onContinue({ type, name: name.trim(), member: "" }); return; }
        setNotFound(true); setMember(""); return;
      }
      if (friends.length === 1) await chooseFriend(friends[0]);
      else setMatches(friends);
    } catch { setError("손님 정보를 조회하지 못했습니다. 연결을 확인하고 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }}>
    <h1 className="text-2xl font-bold">어떻게 오셨나요?</h1>
    <fieldset disabled={busy || disabled} className="space-y-5">
      <div className="flex flex-wrap gap-2">{(["개척자", "지체 손님", "외부자"] as const).map(value =>
        <Button key={value} type="button" variant={type === value ? "default" : "outline"} aria-pressed={type === value} onClick={() => { setType(value); setName(""); setMatches([]); setNotFound(false); setMember(""); setError(null); }}>{customerTypeLabel(value)}</Button>)}</div>
      <div className="space-y-2"><Label htmlFor="customer-name">{type === "외부자" ? "손님 이름 (선택)" : type === "개척자" ? "졸업생 이름" : notFound ? "손님 이름" : "손님 이름 또는 소개한 분 이름"}</Label><Input id="customer-name" value={name} onChange={e => { setName(e.target.value); setMatches([]); setNotFound(false); setMember(""); setError(null); }} required={type !== "외부자"} maxLength={100} /></div>
      {notFound && <div className="space-y-2"><p className="text-sm">등록된 손님이 없습니다. 입력한 손님 이름으로 주문을 진행합니다.</p><Label htmlFor="new-guest-member">소개한 분 이름 (선택)</Label><Input id="new-guest-member" value={member} onChange={e => setMember(e.target.value)} maxLength={100} /><p className="text-sm text-muted-foreground">입력 후 주문 받기를 눌러 주세요.</p></div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {matches.length > 1 && <div className="space-y-2"><p className="text-sm">검색된 계정 중 주문할 손님을 선택해 주세요.</p>{matches.map(friend => <Button key={friend.id} type="button" variant="outline" className="w-full h-auto min-h-11 whitespace-normal break-words" onClick={() => void chooseFriend(friend)}>{customerTypeLabel(friend.customer_type)} · {friend.customer_name}{friend.customer_type === "지체 손님" ? ` · 소개: ${friend.member_name || "미등록"}` : ""}</Button>)}</div>}
      <Button type="submit" className="w-full" disabled={(type !== "외부자" && !name.trim())}>{busy ? "확인 중..." : "주문 받기"}</Button>
    </fieldset>
  </form>;
}
