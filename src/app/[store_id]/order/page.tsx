"use client";

import { useEffect, useRef, useState, use } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readPendingOrder, savePendingOrder, clearPendingOrder, orderRpcArgs, isRejectedOrder, type PendingOrder } from "@/lib/orderSubmission";
import { QueueConnectionStatus } from "@/components/QueueConnectionStatus";
import { PinLock } from "@/components/PinLock";

type Menu = { id: string; name: string; price: number; category: string; kitchen_group: number; is_sold_out: boolean; is_hidden: boolean; is_deleted: boolean };

export default function OrderPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [cart, setCart] = useState<{ menu: Menu; quantity: number }[]>([]);
  const [tableNumber, setTableNumber] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("현금");
  const [loading, setLoading] = useState(true);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshMenusRef = useRef<() => void>(() => {});
  const [submitting, setSubmitting] = useState(false);

  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        setPendingOrder(readPendingOrder(sessionStorage, store_id));
      } catch (error) {
        console.error("미확인 주문 복원 실패", error);
        setStorageError("저장된 접수 상태를 확인할 수 없습니다. 관리자에게 확인한 뒤 이용해 주세요.");
      } finally {
        setRestoring(false);
      }
    });
    return () => { active = false; };
  }, [store_id]);

  useEffect(() => {
    let active = true;
    let running = false;
    let queued = false;
    let controller: AbortController | undefined;
    const fetchMenus = async () => {
      if (!active) return;
      if (running) { queued = true; return; }
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const fetched: Menu[] = [];
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await supabase.from("menus").select("*")
            .eq("store_id", store_id).order("category").order("name").order("id")
            .range(offset, offset + 499).abortSignal(controller.signal);
          if (error) throw error;
          fetched.push(...(data ?? []));
          if (!data || data.length < 500) break;
        }
        if (active) {
          setMenus(fetched);
          setMenuError(null);
          setLastUpdated(new Date());
        }
      } catch (error) {
        if (active) {
          console.error("메뉴 갱신 실패", error);
          setMenuError("메뉴 상태를 확인하지 못했습니다. 연결을 확인해 주세요. 자동으로 다시 시도합니다.");
        }
      } finally {
        clearTimeout(timeout);
        running = false;
        if (active) {
          setLoading(false);
          if (queued) { queued = false; void fetchMenus(); }
        }
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void fetchMenus();
    };
    const offline = () => {
      setConnected(false);
      setMenuError("인터넷 연결이 끊겼습니다. 연결 복구 후 메뉴 상태를 다시 확인합니다.");
    };
    refreshMenusRef.current = () => { void fetchMenus(); };
    const channel = supabase.channel(`menus:order:${store_id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "menus", filter: `store_id=eq.${store_id}` }, () => { void fetchMenus(); })
      .subscribe((status, error) => {
        if (!active) return;
        setConnected(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") void fetchMenus();
        if (error) console.error("메뉴 Realtime 연결 실패", status, error);
      });
    void fetchMenus();
    const interval = setInterval(refreshVisible, 5000);
    window.addEventListener("online", refreshVisible);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(interval);
      refreshMenusRef.current = () => {};
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      void supabase.removeChannel(channel);
    };
  }, [store_id]);

  const currentMenus = new Map(menus.map(menu => [menu.id, menu]));
  const cartIssue = (menu: Menu) => {
    const current = currentMenus.get(menu.id);
    if (!current || current.is_hidden || current.is_deleted) return "판매 중단";
    if (current.is_sold_out) return "품절";
    if (current.price !== menu.price) return "가격 변경";
    return null;
  };
  const hasCartIssue = cart.some(item => cartIssue(item.menu));

  const addToCart = (menu: Menu) => {
    if (!currentMenus.has(menu.id) || cartIssue(menu) || menuError || pendingOrder || submitting || restoring || storageError) return;
    setCart((prev) => {
      const existing = prev.find((item) => item.menu.id === menu.id);
      if (existing) {
        return prev.map((item) =>
          item.menu.id === menu.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { menu, quantity: 1 }];
    });
  };

  const removeFromCart = (menuId: string) => {
    if (pendingOrder || submitting || restoring || storageError) return;
    setCart((prev) => {
      const existing = prev.find((item) => item.menu.id === menuId);
      if (existing && existing.quantity > 1) {
        return prev.map((item) =>
          item.menu.id === menuId ? { ...item, quantity: item.quantity - 1 } : item
        );
      }
      return prev.filter((item) => item.menu.id !== menuId);
    });
  };

  const totalPrice = cart.reduce((sum, item) => sum + item.menu.price * item.quantity, 0);

  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) {
      alert("장바구니가 비어있습니다.");
      return;
    }
    if (!tableNumber) {
      alert("테이블 번호를 입력해주세요.");
      return;
    }

    if (restoring || storageError) return;
    await submitOrder();
  };

  const submitOrder = async () => {
    if (submittingRef.current || restoring || storageError) return;
    if (!pendingOrder && (menuError || hasCartIssue)) {
      alert(menuError || "판매 불가 메뉴 또는 변경된 가격을 확인해 주세요.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const request = pendingOrder ?? {
        requestId: crypto.randomUUID(),
        storeId: store_id,
        tableNumber: tableNumber.trim(),
        paymentMethod,
        items: cart.map(({ menu, quantity }) => ({ menu_id: menu.id, quantity, unit_price: menu.price })),
      };
      // 요청을 보내기 전에 보관해 응답 유실·새로고침 후에도 같은 ID로 재시도한다.
      savePendingOrder(sessionStorage, request);
      setPendingOrder(request);
      const { data, error } = await supabase.rpc("submit_order", orderRpcArgs(request));
      if (error) {
        if (isRejectedOrder(error.code)) {
          clearPendingOrder(sessionStorage, store_id);
          setPendingOrder(null);
          refreshMenusRef.current();
          alert("주문이 접수되지 않았습니다: " + error.message + "\n메뉴를 다시 확인해 주세요.");
        } else {
          alert("접수 결과를 확인하지 못했습니다. ‘접수 확인 / 재시도’를 눌러주세요. 같은 요청은 중복 접수되지 않습니다.");
        }
        return;
      }
      if (!data?.id || !Number.isInteger(data.order_number)) throw new Error("주문 응답 형식이 올바르지 않습니다.");
      clearPendingOrder(sessionStorage, store_id);
      setPendingOrder(null);
      setCart([]);
      setTableNumber("");
      alert(`주문이 성공적으로 접수되었습니다!\n\n✨ 주문번호: ${data.order_number}번\n(주문자/손님께 이 번호를 안내해 주세요)`);
    } catch (error) {
      console.error("주문 접수 결과 확인 실패", error);
      alert("접수 결과 확인 또는 임시 저장에 실패했습니다. 이 화면을 유지하고 다시 시도해 주세요.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // Group menus by category
  const groupedMenus = menus.filter(menu => !menu.is_hidden && !menu.is_deleted).reduce((acc, menu) => {
    if (!acc[menu.category]) acc[menu.category] = [];
    acc[menu.category].push(menu);
    return acc;
  }, {} as Record<string, Menu[]>);

  if (loading) return <div className="p-8 text-center">메뉴를 불러오는 중...</div>;

  return (
    <PinLock storeId={store_id} role="order">
      <div className="container mx-auto p-4 max-w-5xl grid grid-cols-1 md:grid-cols-3 gap-6">
      <div className="md:col-span-3"><QueueConnectionStatus connected={connected} error={menuError} lastUpdated={lastUpdated} refresh={() => refreshMenusRef.current()} /></div>
      {menuError && <p className="md:col-span-3 text-sm text-red-700" role="alert">{menuError} 새 주문은 상태 확인 후 접수할 수 있습니다.</p>}
      {storageError && <p className="md:col-span-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700" role="alert">{storageError}</p>}
      {pendingOrder && (
        <div className="md:col-span-3 rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2" role="status">
          <p className="font-semibold">{submitting ? "주문 접수 확인 중..." : "접수 결과를 확인해야 하는 주문이 있습니다."}</p>
          <p className="text-sm">테이블 {pendingOrder.tableNumber} · {pendingOrder.items.reduce((sum, item) => sum + item.quantity, 0)}개 · {pendingOrder.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0).toLocaleString()}원</p>
          <p className="text-sm text-gray-600">아래 버튼으로 먼저 접수 결과를 확인해 주세요. 새로고침해도 이 요청을 이어서 확인합니다.</p>
          <Button type="button" disabled={submitting || restoring || !!storageError} onClick={submitOrder}>접수 확인 / 재시도</Button>
        </div>
      )}
      <fieldset disabled={submitting || !!pendingOrder || restoring || !!storageError} className="contents">
      {/* Menu List */}
      <div className="md:col-span-2 space-y-6">
        <h1 className="text-2xl font-bold border-b pb-2">메뉴 주문</h1>
        
        {Object.keys(groupedMenus).length === 0 ? (
          <p className="text-gray-500">등록된 메뉴가 없습니다.</p>
        ) : (
          Object.keys(groupedMenus).map((category) => (
            <div key={category} className="space-y-4">
              <h2 className="text-xl font-bold bg-primary/10 p-2 rounded">{category}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {groupedMenus[category].map((menu: Menu) => (
                  <Card 
                    key={menu.id} 
                    className={`cursor-pointer transition-colors ${menu.is_sold_out ? 'opacity-50' : 'hover:border-primary'}`}
                    onClick={() => addToCart(menu)}
                  >
                    <CardContent className="p-4 flex justify-between items-center">
                      <div>
                        <h3 className="font-bold text-lg">
                          {menu.name}
                          {menu.is_sold_out && <span className="ml-2 text-sm text-red-500 font-bold">[품절]</span>}
                        </h3>
                        <p className="text-gray-500">{menu.price.toLocaleString()}원</p>
                      </div>
                      <Button variant="secondary" size="sm" disabled={menu.is_sold_out}>추가</Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Cart & Checkout */}
      <div className="md:col-span-1">
        <Card className="sticky top-4">
          <CardHeader className="bg-primary text-primary-foreground rounded-t-xl">
            <CardTitle>장바구니</CardTitle>
          </CardHeader>
          <CardContent className="p-4 flex flex-col h-[calc(100vh-10rem)] max-h-[600px]">
            <div className="flex-1 overflow-y-auto space-y-4 pr-2">
              {cart.length === 0 ? (
                <p className="text-center text-gray-500 py-8">장바구니가 비어있습니다.</p>
              ) : (
                cart.map((item) => {
                  const issue = cartIssue(item.menu);
                  const current = currentMenus.get(item.menu.id);
                  return (
                  <div key={item.menu.id} className="flex justify-between items-center border-b pb-2">
                    <div>
                      <p className="font-bold">{item.menu.name}</p>
                      <p className="text-sm text-gray-500">{item.menu.price.toLocaleString()}원</p>
                      {issue && <p className="text-xs text-red-600" role="alert">{issue}{issue === "가격 변경" && current ? `: ${current.price.toLocaleString()}원` : " · 주문 불가"}</p>}
                      {issue === "가격 변경" && current && <Button type="button" variant="ghost" size="xs" onClick={() => setCart(previous => previous.map(entry => entry.menu.id === item.menu.id ? { ...entry, menu: current } : entry))}>변경 가격 적용</Button>}
                      {issue && <Button type="button" variant="ghost" size="xs" onClick={() => setCart(previous => previous.filter(entry => entry.menu.id !== item.menu.id))}>메뉴 빼기</Button>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="icon" className="h-6 w-6" onClick={() => removeFromCart(item.menu.id)}>-</Button>
                      <span className="w-4 text-center font-bold">{item.quantity}</span>
                      <Button variant="outline" size="icon" className="h-6 w-6" disabled={!!issue || !!menuError} onClick={() => addToCart(item.menu)}>+</Button>
                    </div>
                  </div>
                  );
                })
              )}
            </div>

            <div className="border-t pt-4 mt-4 space-y-4">
              <div className="flex justify-between items-center text-lg font-bold">
                <span>총 결제금액</span>
                <span className="text-primary">{totalPrice.toLocaleString()}원</span>
              </div>

              <form onSubmit={handleSubmitOrder} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="table">테이블 번호</Label>
                  <Input 
                    id="table" 
                    value={tableNumber} 
                    onChange={(e) => setTableNumber(e.target.value)} 
                    placeholder="예: 3번, 야외-1" 
                    required 
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>결제 방식</Label>
                  <Select value={paymentMethod} onValueChange={(val) => setPaymentMethod(val || "현금")}>
                    <SelectTrigger>
                      <SelectValue placeholder="결제 방식을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="현금">현금결제 (계좌이체 등)</SelectItem>
                      <SelectItem value="쿠폰">쿠폰결제 (선결제 티켓)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button 
                  type="submit" 
                  className="w-full text-lg h-12" 
                  disabled={submitting || !!pendingOrder || restoring || !!storageError || !!menuError || hasCartIssue || cart.length === 0}
                >
                  {submitting ? "주문 전송 중..." : "주문 및 결제 완료"}
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
      </fieldset>
    </div>
    </PinLock>
  );
}
