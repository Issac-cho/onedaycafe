"use client";

import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { QueueConnectionStatus } from "@/components/QueueConnectionStatus";
import { customerTypeLabel } from "@/lib/couponPayment";
import { accountingClipboardHeaders, accountingOrderAmount, accountingOrderTsv, accountingPage, accountingTotals, koreaToday, type AccountingOrder } from "@/lib/accounting";
import { useAccountingOrders } from "@/lib/useAccountingOrders";

const won = (value: number | null) => value == null ? "미기록" : `${value.toLocaleString()}원`;

export function AccountingTable({ orders, onCopy, copiedId, copying }: { orders: AccountingOrder[]; onCopy: (order: AccountingOrder) => void; copiedId: string | null; copying: boolean }) {
  return <div className="overflow-auto rounded-lg border" tabIndex={0} role="region" aria-label="회계 주문 상세 표">
    <table className="w-full min-w-[1400px] text-sm">
      <thead className="bg-gray-100 text-left"><tr>{["복사", "주문번호", "접수 시각", "테이블", "손님", "메뉴·옵션", "결제수단", "주문금액", "쿠폰 사용", "필요 현금", "받은 현금", "쿠폰 적립", "주문 상태"].map(title => <th key={title} scope="col" className="whitespace-nowrap px-3 py-3 font-semibold">{title}</th>)}</tr></thead>
      <tbody>{orders.map(order => <tr id={`accounting-order-${order.id}`} key={order.id} className="border-t align-top odd:bg-white even:bg-gray-50/70">
        <td className="px-3 py-3"><Button type="button" variant="outline" size="sm" className="min-h-11 min-w-16" disabled={copying} aria-label={`${order.order_number}번 주문 복사`} onClick={() => onCopy(order)}>{copiedId === order.id ? "복사됨" : "복사"}</Button></td>
        <th scope="row" className="px-3 py-4 text-left font-bold">{order.order_number}번</th>
        <td className="whitespace-nowrap px-3 py-4">{new Date(order.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}</td>
        <td className="max-w-32 break-words px-3 py-4">{order.table_number}</td>
        <td className="min-w-36 max-w-48 break-words px-3 py-4"><p className="font-medium">{order.customer_name || "이름 미입력"}</p><p className="text-xs text-gray-600">{customerTypeLabel(order.customer_type ?? "미기록")}</p>{order.member_name && <p className="text-xs text-gray-600">소개: {order.member_name}</p>}</td>
        <td className="min-w-64 max-w-sm px-3 py-4"><ul className="space-y-3">{order.sales.map(sale => <li key={sale.id} className="break-words">
          <p className="font-medium">{sale.menu_name} × {sale.quantity}</p>
          {sale.option_summary && <p className="text-xs text-blue-700">{sale.option_summary}</p>}
          {!!sale.components?.length && <p className="text-xs text-gray-600">세트 1개 구성: {sale.components.map(part => `${part.menu_name} × ${part.quantity}`).join(" / ")}</p>}
          <p className="text-xs text-gray-600">단가 {won(sale.menu_price)} · 금액 {won(sale.menu_price * sale.quantity)}</p>
        </li>)}</ul>{!order.sales.length && <p className="text-red-700">판매 내역 없음 · 운영자 확인 필요</p>}</td>
        <td className="whitespace-nowrap px-3 py-4">{order.payment_method}</td>
        <td className="whitespace-nowrap px-3 py-4 text-right font-bold">{won(accountingOrderAmount(order))}</td>
        <td className="whitespace-nowrap px-3 py-4 text-right">{won(order.coupon_used)}</td>
        <td className="whitespace-nowrap px-3 py-4 text-right">{won(order.cash_due)}</td>
        <td className="whitespace-nowrap px-3 py-4 text-right font-semibold">{won(order.cash_received)}</td>
        <td className="whitespace-nowrap px-3 py-4 text-right text-blue-700">{won(order.coupon_credited)}</td>
        <td className="whitespace-nowrap px-3 py-4">{order.status === "completed" ? "주문 완료" : "진행 중"}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function AccountingLedger({ storeId, date }: { storeId: string; date: string }) {
  const queue = useAccountingOrders(storeId, date);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const copyLock = useRef(false);
  const copy = async (text: string, id: string) => {
    if (copyLock.current) return;
    copyLock.current = true; setCopying(true); setCopiedId(null); setCopyError(null);
    try { await navigator.clipboard.writeText(text); setCopiedId(id); }
    catch { setCopyError("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하고 다시 눌러 주세요."); }
    finally { copyLock.current = false; setCopying(false); }
  };
  const totals = accountingTotals(queue.orders);
  const term = search.trim();
  const visible = accountingPage(queue.orders, search, page);
  return <div className="space-y-5">
    <QueueConnectionStatus {...queue} />
    {queue.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{queue.error}</p>}
    {!queue.loading && <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{[
      ["접수 주문", `${queue.orders.length}건`], ["주문금액 합계", won(totals.amount)], ["쿠폰 사용 합계", won(totals.coupon)],
      ["필요 현금 합계", won(totals.cashDue)], ["받은 현금 합계", won(totals.cashReceived)], ["쿠폰 적립 합계", won(totals.credited)],
    ].map(([title, value]) => <div key={title} className="rounded-lg border p-3"><p className="text-xs text-gray-600">{title}</p><p className="mt-1 break-words text-lg font-bold">{value}</p></div>)}</div>}
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="w-full space-y-2 sm:max-w-sm"><Label htmlFor="accounting-search">주문 검색</Label><Input id="accounting-search" placeholder="주문번호, 테이블, 손님 또는 소개한 분" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></div>
      <Button type="button" variant="outline" disabled={copying} onClick={() => void copy(accountingClipboardHeaders, "headers")}>{copiedId === "headers" ? "열 제목 복사됨" : "엑셀 열 제목 복사"}</Button>
    </div>
    <p className="text-xs text-gray-600">처음에는 ‘엑셀 열 제목 복사’를 첫 행에 붙이고, 각 주문의 ‘복사’를 다음 빈 행에 붙여 주세요. 주문 한 건이 한 행으로 입력되며 금액은 숫자로 복사됩니다.</p>
    {copyError && <p role="alert" className="text-sm text-red-700">{copyError}</p>}
    {copiedId && <p role="status" className="text-sm text-blue-700">{copiedId === "headers" ? "열 제목을 복사했습니다." : "주문을 복사했습니다. 스프레드시트의 빈 행에 붙여넣으세요."}</p>}
    {queue.loading ? <p className="py-10 text-center text-gray-500">주문 내역을 불러오는 중...</p>
      : visible.orders.length ? <>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-gray-600">전체 {visible.total}건 중 {visible.start + 1}–{visible.start + visible.orders.length}건 · 주문번호 내림차순</p><nav aria-label="주문 페이지" className="flex items-center gap-2"><Button type="button" variant="outline" disabled={visible.current === 1} onClick={() => setPage(1)}>최신</Button><Button type="button" variant="outline" disabled={visible.current === 1} onClick={() => setPage(visible.current - 1)}>이전</Button><span className="text-sm">{visible.current} / {visible.pages}</span><Button type="button" variant="outline" disabled={visible.current === visible.pages} onClick={() => setPage(visible.current + 1)}>다음</Button></nav></div>
        <AccountingTable orders={visible.orders} onCopy={order => void copy(accountingOrderTsv(order), order.id)} copiedId={copiedId} copying={copying} />
      </>
        : <p className="rounded-lg border border-dashed p-10 text-center text-gray-500">{queue.error ? "주문 정보를 확인할 수 없습니다. 다시 조회해 주세요." : term ? "검색 결과가 없습니다." : "선택한 기간에 접수된 주문이 없습니다."}</p>}
    <p className="text-xs text-gray-600">합계는 선택한 기간 전체 기준이며 검색으로 바뀌지 않습니다. 주문금액은 메뉴 판매금액이고, 초과 수납액은 쿠폰 적립에 포함됩니다. 현금 항목에는 계좌이체 등 현금으로 접수한 결제도 포함됩니다. 관리자 쿠폰 등록·추가 충전은 이 화면에 포함되지 않습니다. 미기록 값이 있는 합계는 ‘미기록’으로 표시합니다.</p>
  </div>;
}

export function AccountingDashboard({ storeId }: { storeId: string }) {
  const [date, setDate] = useState(koreaToday);
  return <main className="mx-auto max-w-[1800px] space-y-5 p-4 md:p-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-2xl font-bold">회계 주문 현황</h1><p className="mt-2 text-sm text-gray-600">큰 주문번호부터 30건씩 표시합니다. 새 주문은 최신 페이지 상단에 실시간으로 반영됩니다.</p></div>
      <div className="flex flex-wrap items-end gap-2"><div className="space-y-2"><Label htmlFor="accounting-date">영업일 (한국 시간)</Label><Input id="accounting-date" type="date" value={date} onChange={event => setDate(event.target.value)} /></div><Button variant="outline" onClick={() => setDate(koreaToday())}>오늘</Button><Button variant={date ? "outline" : "default"} onClick={() => setDate("")}>전체 기간</Button></div>
    </div>
    <AccountingLedger key={`${storeId}:${date}`} storeId={storeId} date={date} />
  </main>;
}
