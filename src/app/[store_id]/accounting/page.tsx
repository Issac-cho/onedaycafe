"use client";

import { use } from "react";
import { PinLock } from "@/components/PinLock";
import { AccountingDashboard } from "@/components/AccountingDashboard";

export default function AccountingPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  return <PinLock storeId={store_id} role="order"><AccountingDashboard storeId={store_id} /></PinLock>;
}
