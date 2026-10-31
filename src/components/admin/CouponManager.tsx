"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmation } from "@/components/useConfirmation";
import { isRejectedOrder } from "@/lib/orderSubmission";
import { parseWon, type Customer } from "@/lib/couponPayment";

type Account = { id: string; customer_type: Customer["type"]; customer_name: string; member_name: string; balance: number };
type Request = { p_request_id: string; p_store_id: string; p_customer_type: Customer["type"]; p_customer_name: string; p_member_name: string; p_amount: number; p_create: boolean };

export function CouponManager({ storeId }: { storeId: string }) {
  const { confirm, confirmationDialog } = useConfirmation();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [totals, setTotals] = useState<{ registered: number; charged: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [type, setType] = useState<Customer["type"]>("개척자");
  const [name, setName] = useState("");
  const [member, setMember] = useState("");
  const [amount, setAmount] = useState("");
  const [selected, setSelected] = useState<Account | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const locked = useRef(false);
  const key = `coupon_admin_pending_${storeId}`;

  const fetchAccounts = async () => {
    try {
      const rows: Account[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from("coupon_accounts").select("*").eq("store_id", storeId)
          .order("customer_name").order("id").range(offset, offset + 499).abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        rows.push(...data);
        if (data.length < 500) break;
      }
      const { data: sums, error: sumsError } = await supabase.rpc("get_coupon_admin_totals", { p_store_id: storeId }).abortSignal(AbortSignal.timeout(10000));
      if (sumsError) throw sumsError;
      setAccounts(rows); setTotals(sums); setError(null);
    } catch { setError("쿠폰 목록을 조회하지 못했습니다. 다시 조회해 주세요."); }
  };
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      try {
        const saved = sessionStorage.getItem(key);
        if (saved) {
          const request = JSON.parse(saved) as Request;
          if (request.p_store_id !== storeId || typeof request.p_request_id !== "string" || !Number.isSafeInteger(request.p_amount)) throw new Error("저장 형식 오류");
          setPending(request);
        }
        setRestored(true);
      } catch { setStorageError("미확인 충전 정보를 읽을 수 없습니다. 저장된 요청을 유지하고 관리자에게 처리 내역을 확인해 주세요."); }
      if (active) await fetchAccounts();
    });
    return () => { active = false; };
    // 매장마다 key로 다시 마운트하며 진행 중 요청은 sessionStorage로 보존한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const send = async (request: Request) => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      sessionStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      const { data, error } = await supabase.rpc("manage_coupon_account", request).abortSignal(AbortSignal.timeout(15000));
      if (error) {
        if (isRejectedOrder(error.code)) { sessionStorage.removeItem(key); setPending(null); alert(error.message); }
        else alert("결과를 확인하지 못했습니다. ‘충전 결과 확인 / 재시도’를 눌러 주세요.");
        return;
      }
      if (!data?.id || !Number.isSafeInteger(data.balance)) throw new Error("응답 오류");
      sessionStorage.removeItem(key); setPending(null); setAmount(""); setName(""); setMember(""); setSelected(null);
      alert(`처리 완료 · 처리 직후 잔액 ${data.balance.toLocaleString()}원`);
      await fetchAccounts();
    } catch { alert("저장 또는 결과 확인에 실패했습니다. 이 화면을 유지하고 같은 요청으로 다시 확인해 주세요."); }
    finally { locked.current = false; setBusy(false); }
  };
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {storageError && <p role="alert" className="text-sm text-red-700">{storageError}</p>}
    <p className="text-sm text-gray-600">최초 등록액 {totals?.registered.toLocaleString() ?? "—"}원 · 관리자 추가 충전 {totals?.charged.toLocaleString() ?? "—"}원 (주문 매출과 별도)</p>
    {pending && <div className="rounded bg-amber-50 p-3 space-y-2"><p>{pending.p_customer_type} · {pending.p_member_name} {pending.p_customer_name} · {pending.p_create ? "등록" : "추가 충전"} {pending.p_amount.toLocaleString()}원</p><Button disabled={busy || !restored} onClick={() => void send(pending)}>충전 결과 확인 / 재시도</Button></div>}
    <form onSubmit={async e => {
      e.preventDefault();
      if (busy || pending || !restored) return;
      const value = parseWon(amount);
      if (value === null || (selected && value === 0) || !name.trim() || (type === "지체 손님" && !member.trim())) { alert("이름과 금액을 확인해 주세요."); return; }
      const request: Request = { p_request_id: crypto.randomUUID(), p_store_id: storeId, p_customer_type: type,
        p_customer_name: name.trim(), p_member_name: type === "지체 손님" ? member.trim() : "", p_amount: value, p_create: !selected };
      if (await confirm({ title: selected ? "쿠폰 추가 충전" : "쿠폰 계정 등록", description: "손님 이름과 금액을 확인해 주세요.",
        details: [`${type} · ${request.p_member_name} ${request.p_customer_name}`, `${selected ? "추가 충전" : "최초 잔액"}: ${value.toLocaleString()}원`, `예상 잔액: ${((selected?.balance ?? 0) + value).toLocaleString()}원`], confirmLabel: selected ? "충전하기" : "등록하기" })) await send(request);
    }}>
      <fieldset disabled={busy || !!pending || !restored} className="space-y-3 rounded-lg border p-4">
        <h3 className="font-semibold">{selected ? "추가 충전" : "새 계정 등록"}</h3>
        <div className="flex flex-wrap gap-2">{(["외부자", "개척자", "지체 손님"] as const).map(value => <Button key={value} type="button" disabled={!!selected} variant={type === value ? "default" : "outline"} onClick={() => { setType(value); setName(""); setMember(""); }}>{value}</Button>)}</div>
        {type === "지체 손님" && <div><Label htmlFor="admin-member">지체 이름</Label><Input id="admin-member" value={member} onChange={e => setMember(e.target.value)} required readOnly={!!selected} maxLength={100} /></div>}
        <div><Label htmlFor="admin-customer">{type === "개척자" ? "개척자 이름" : "손님 이름"}</Label><Input id="admin-customer" value={name} onChange={e => setName(e.target.value)} required readOnly={!!selected} maxLength={100} /></div>
        <div><Label htmlFor="admin-amount">{selected ? "추가 충전액 (원)" : "최초 쿠폰 금액 (원)"}</Label><Input id="admin-amount" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} required /></div>
        <p className="text-xs text-gray-500">동명이인은 홍길동, 홍길동2처럼 구분하여 등록하세요. 지체 이름이 다르면 같은 손님 이름을 사용할 수 있습니다.</p>
        <div className="flex gap-2"><Button type="submit">{selected ? "추가 충전" : "등록"}</Button>{selected && <Button type="button" variant="outline" onClick={() => { setSelected(null); setName(""); setMember(""); setAmount(""); }}>새 계정 등록으로</Button>}</div>
      </fieldset>
    </form>
    <div className="flex gap-2"><Input aria-label="쿠폰 계정 이름 검색" placeholder="지체·손님 이름 검색" value={search} onChange={e => setSearch(e.target.value)} /><Button variant="outline" disabled={busy} onClick={() => void fetchAccounts()}>새로고침</Button></div>
    <div className="max-h-80 overflow-y-auto divide-y">{accounts.filter(a => `${a.customer_name} ${a.member_name}`.includes(search.trim())).map(a => <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><div><p className="font-medium">{a.customer_type} · {a.member_name && `${a.member_name} / `}{a.customer_name}</p><p className="text-sm">잔액 {a.balance.toLocaleString()}원</p></div><Button variant="outline" disabled={busy || !!pending || !restored} onClick={() => { setSelected(a); setType(a.customer_type); setName(a.customer_name); setMember(a.member_name); setAmount(""); }}>추가 충전</Button></div>)}</div>
    {confirmationDialog}
  </div>;
}
