"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function StoreSettings({ store }: { store: any }) {
  const [orderPin, setOrderPin] = useState(store.order_pin || "");
  const [chefPin, setChefPin] = useState(store.chef_pin || "");
  const [serverPin, setServerPin] = useState(store.server_pin || "");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase
      .from("stores")
      .update({
        order_pin: orderPin || null,
        chef_pin: chefPin || null,
        server_pin: serverPin || null,
      })
      .eq("id", store.id);

    if (error) {
      alert("설정 저장 실패: " + error.message);
    } else {
      alert("PIN 번호 설정이 저장되었습니다.");
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <p className="text-sm text-gray-500 mb-4">
        직원용 접속 링크를 보호하기 위한 PIN 번호(숫자)를 설정하세요. 비워두면 누구나 접속할 수 있습니다.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>주문 담당 PIN</Label>
          <Input value={orderPin} onChange={(e) => setOrderPin(e.target.value)} maxLength={10} placeholder="예: 1234" />
        </div>
        <div className="space-y-2">
          <Label>주방 담당 PIN</Label>
          <Input value={chefPin} onChange={(e) => setChefPin(e.target.value)} maxLength={10} placeholder="예: 1234" />
        </div>
        <div className="space-y-2">
          <Label>서빙 담당 PIN</Label>
          <Input value={serverPin} onChange={(e) => setServerPin(e.target.value)} maxLength={10} placeholder="예: 1234" />
        </div>
      </div>
      <Button type="submit" className="mt-4">PIN 설정 저장</Button>
    </form>
  );
}
