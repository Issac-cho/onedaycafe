"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MenuManager } from "@/components/admin/MenuManager";
import { StoreSettings } from "@/components/admin/StoreSettings";
import { DashboardStats } from "@/components/admin/DashboardStats";

export default function AdminDashboard() {
  const [session, setSession] = useState<any>(null);
  const [stores, setStores] = useState<any[]>([]);
  const [activeStore, setActiveStore] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [storeName, setStoreName] = useState("");
  const router = useRouter();

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (!session) {
        router.push("/");
      } else {
        fetchStores(session.user.id);
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session);
        if (!session) router.push("/");
      }
    );

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [router]);

  const fetchStores = async (userId: string) => {
    const { data, error } = await supabase.from("stores").select("*").eq("owner_id", userId).order("created_at", { ascending: true });
    if (data) {
      setStores(data);
    }
    setLoading(false);
  };

  const createStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    
    // Check for duplicate store name for this user
    if (stores.some(s => s.name === storeName)) {
      alert("이미 같은 이름의 매장이 존재합니다.");
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.from("stores").insert([{ name: storeName, owner_id: session.user.id }]).select().single();
    if (error) {
      alert("매장 생성 실패: " + error.message);
    } else {
      setStores([...stores, data]);
      setStoreName("");
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/");
  };

  if (loading) return <div className="p-8 text-center text-gray-500">로딩중...</div>;
  if (!session) return null;

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-5xl">
      <div className="flex justify-between items-center py-4 border-b">
        <h1 className="text-2xl font-bold text-primary">관리자 대시보드</h1>
        <Button variant="outline" onClick={handleLogout}>로그아웃</Button>
      </div>

      {!activeStore ? (
        <div className="space-y-8">
          <div>
            <h2 className="text-xl font-bold mb-4">내 매장 목록</h2>
            {stores.length === 0 ? (
              <p className="text-gray-500 bg-gray-50 p-6 rounded-lg text-center">운영 중인 매장이 없습니다. 새 매장을 개설해보세요!</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {stores.map(store => (
                  <Card key={store.id} className="hover:border-primary cursor-pointer transition-colors" onClick={() => setActiveStore(store)}>
                    <CardHeader>
                      <CardTitle>{store.name}</CardTitle>
                      <CardDescription>클릭하여 매장 관리</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <Card className="max-w-md mt-10">
            <CardHeader>
              <CardTitle>새로운 매장 개설</CardTitle>
              <CardDescription>새로운 매장(팀) 이름을 등록해주세요.</CardDescription>
            </CardHeader>
            <form onSubmit={createStore}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="storeName">매장 이름 (중복 불가)</Label>
                  <Input id="storeName" value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="예: 컴퓨터공학과 주점" required />
                </div>
              </CardContent>
              <CardContent>
                <Button type="submit" className="w-full">매장 생성하기</Button>
              </CardContent>
            </form>
          </Card>
        </div>
      ) : (
        <div className="space-y-8 mt-6">
          <div>
            <Button variant="ghost" onClick={() => setActiveStore(null)} className="mb-4">← 목록으로 돌아가기</Button>
            <h2 className="text-3xl font-extrabold mb-2">{activeStore.name}</h2>
            <p className="text-gray-500">매장 관리 화면입니다. 아래 링크를 각 담당 직원들에게 공유해주세요.</p>
          </div>

          <Card className="border-primary/20 shadow-md">
            <CardHeader className="bg-primary/5 pb-4">
              <CardTitle>직원용 전용 접속 링크</CardTitle>
              <CardDescription>각 직원들은 회원가입 없이 아래 링크로 바로 업무 화면에 접속합니다.</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="p-4 border rounded-lg bg-card">
                  <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
                    <span className="text-2xl">📝</span> 홀 주문 담당
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">손님들의 주문을 받고 결제를 처리합니다.</p>
                  <a href={`${baseUrl}/${activeStore.id}/order`} target="_blank" className="text-sm text-blue-600 hover:underline break-all block p-2 bg-blue-50 rounded">
                    {baseUrl}/{activeStore.id}/order
                  </a>
                </div>
                
                <div className="p-4 border rounded-lg bg-card">
                  <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
                    <span className="text-2xl">👨‍🍳</span> 주방 담당
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">들어온 주문을 확인하고 조리 완료 처리를 합니다.</p>
                  <a href={`${baseUrl}/${activeStore.id}/chef`} target="_blank" className="text-sm text-blue-600 hover:underline break-all block p-2 bg-blue-50 rounded">
                    {baseUrl}/{activeStore.id}/chef
                  </a>
                </div>

                <div className="p-4 border rounded-lg bg-card">
                  <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
                    <span className="text-2xl">🏃‍♂️</span> 홀 서빙 담당
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">조리가 완료된 요리를 손님 테이블에 전달합니다.</p>
                  <a href={`${baseUrl}/${activeStore.id}/server`} target="_blank" className="text-sm text-blue-600 hover:underline break-all block p-2 bg-blue-50 rounded">
                    {baseUrl}/{activeStore.id}/server
                  </a>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>직원 접속 보안 (PIN)</CardTitle>
            </CardHeader>
            <CardContent>
              <StoreSettings store={activeStore} />
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <CardTitle>메뉴 관리</CardTitle>
              <CardDescription>판매할 메뉴를 등록하고 상태(품절/숨김)를 관리합니다.</CardDescription>
            </CardHeader>
            <CardContent>
              <MenuManager storeId={activeStore.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>실시간 현황 모니터링</CardTitle>
              <CardDescription>전체 주문/조리 현황을 한눈에 파악합니다.</CardDescription>
            </CardHeader>
            <CardContent>
              <DashboardStats storeId={activeStore.id} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
