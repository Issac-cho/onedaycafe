export type Customer = { type: "외부자" | "개척자" | "지체 손님"; name: string; member: string };
export type CouponAccount = { id: string; balance: number; member_name?: string };

// DB 구분값은 기존 계정·미확인 주문의 호환을 위해 유지한다.
export function customerTypeLabel(type: string) {
  return ({ "외부자": "기타", "개척자": "DSM 졸업생", "지체 손님": "지인 소개" } as Record<string, string>)[type] ?? type;
}

export function parseWon(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount <= 1_000_000_000 ? amount : null;
}

export function couponPayment(total: number, balance: number, method: string, couponInput: string, cashInput: string) {
  const used = method === "현금" ? 0 : method === "쿠폰" ? total
    : couponInput === "" ? Math.min(total, balance) : parseWon(couponInput);
  if (used === null || used > total || used > balance) throw new Error("쿠폰 사용액과 잔액을 확인해 주세요.");
  const due = total - used;
  if (method === "쿠폰+현금" && (used === 0 || due === 0)) throw new Error("전액 결제는 현금 또는 쿠폰을 선택해 주세요.");
  const received = method === "쿠폰" ? 0 : cashInput === "" ? due : parseWon(cashInput);
  if (received === null || received < due) throw new Error("받은 현금이 필요한 금액보다 적거나 올바르지 않습니다.");
  return { used, due, received, credited: received - due, remaining: balance - used + received - due };
}
