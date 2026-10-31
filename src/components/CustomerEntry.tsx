"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Customer } from "@/lib/couponPayment";

export function CustomerEntry({ initial, onContinue, disabled }: { initial: Customer | null; onContinue: (customer: Customer) => Promise<void>; disabled: boolean }) {
  const [type, setType] = useState<Customer["type"]>(initial?.type ?? "외부자");
  const [name, setName] = useState(initial?.name ?? "");
  const [busy, setBusy] = useState(false);
  return <form className="mx-auto w-full max-w-md space-y-5 rounded-xl border p-6" onSubmit={async e => {
    e.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    try { await onContinue({ type, name: name.trim(), member: "" }); }
    finally { setBusy(false); }
  }}>
    <h1 className="text-2xl font-bold">손님 정보</h1>
    <fieldset disabled={busy || disabled} className="space-y-5">
      <div className="flex gap-2">{(["외부자", "개척자", "지체 손님"] as const).map(value =>
        <Button key={value} type="button" variant={type === value ? "default" : "outline"} aria-pressed={type === value} onClick={() => { setType(value); setName(""); }}>{value}</Button>)}</div>
      <div className="space-y-2"><Label htmlFor="customer-name">{type === "개척자" ? "개척자 이름" : "손님 이름"}{type === "외부자" ? " (선택)" : ""}</Label><Input id="customer-name" value={name} onChange={e => setName(e.target.value)} required={type !== "외부자"} maxLength={100} /></div>
      <p className="text-sm text-gray-500">등록된 이름을 정확히 입력해 주세요. 동명이인은 홍길동2처럼 구분된 이름을 사용합니다.</p>
      <Button type="submit" className="w-full" disabled={(type !== "외부자" && !name.trim())}>{busy ? "확인 중..." : "주문 받기"}</Button>
    </fieldset>
  </form>;
}
