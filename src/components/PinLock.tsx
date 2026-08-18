"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PinLock({ storeId, role, children }: { storeId: string, role: "order" | "chef" | "server", children: React.ReactNode }) {
  const [isLocked, setIsLocked] = useState(true);
  const [pin, setPin] = useState("");
  const [expectedPin, setExpectedPin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkPin = async () => {
      // Check session storage first so they don't have to enter it on refresh
      if (sessionStorage.getItem(`pin_unlocked_${storeId}_${role}`) === "true") {
        setIsLocked(false);
        setLoading(false);
        return;
      }

      const { data } = await supabase.from("stores").select(`${role}_pin`).eq("id", storeId).single();
      if (data) {
        const storePin = (data as any)[`${role}_pin`];
        if (!storePin) {
          setIsLocked(false); // No PIN set
        } else {
          setExpectedPin(storePin);
        }
      }
      setLoading(false);
    };
    checkPin();
  }, [storeId, role]);

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin === expectedPin) {
      sessionStorage.setItem(`pin_unlocked_${storeId}_${role}`, "true");
      setIsLocked(false);
    } else {
      alert("PIN 번호가 올바르지 않습니다.");
      setPin("");
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center p-10 text-gray-500">인증 정보 확인 중...</div>;
  if (!isLocked) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader>
          <CardTitle className="text-center text-xl">직원 전용 화면</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUnlock} className="space-y-4">
            <p className="text-center text-sm text-gray-500 mb-4">
              접속을 위해 관리자가 설정한 PIN 번호를 입력해주세요.
            </p>
            <Input 
              type="password" 
              placeholder="PIN 입력" 
              value={pin} 
              onChange={(e) => setPin(e.target.value)} 
              maxLength={4}
              className="text-center text-2xl tracking-widest h-14"
              required 
            />
            <Button type="submit" className="w-full h-12 text-lg">접속하기</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
