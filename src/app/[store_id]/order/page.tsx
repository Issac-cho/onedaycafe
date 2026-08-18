"use client";

import { useEffect, useState, use } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PinLock } from "@/components/PinLock";

export default function OrderPage({ params }: { params: Promise<{ store_id: string }> }) {
  const { store_id } = use(params);
  const [menus, setMenus] = useState<any[]>([]);
  const [cart, setCart] = useState<{ menu: any; quantity: number }[]>([]);
  const [tableNumber, setTableNumber] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("현금");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchMenus = async () => {
      const { data, error } = await supabase
        .from("menus")
        .select("*")
        .eq("store_id", store_id)
        .eq("is_hidden", false)
        .order("category")
        .order("name");

      if (data) setMenus(data);
      setLoading(false);
    };

    fetchMenus();
  }, [store_id]);

  const addToCart = (menu: any) => {
    if (menu.is_sold_out) return;
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

    setSubmitting(true);

    // 1. Create Order
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .insert([
        {
          store_id,
          table_number: tableNumber,
          payment_method: paymentMethod,
          status: "received",
        },
      ])
      .select()
      .single();

    if (orderError) {
      alert("주문 접수 실패: " + orderError.message);
      setSubmitting(false);
      return;
    }

    // 2. Create Order Items
    const orderItems = cart.map((item) => ({
      order_id: orderData.id,
      menu_id: item.menu.id,
      quantity: item.quantity,
      status: "pending",
    }));

    const { error: itemsError } = await supabase.from("order_items").insert(orderItems);

    if (itemsError) {
      alert("주문 상세 접수 실패: " + itemsError.message);
    } else {
      alert(`주문이 성공적으로 전송되었습니다!\n\n✨ 주문번호: ${orderData.order_number}번\n(주문자/손님께 이 번호를 안내해 주세요)`);
      setCart([]);
      setTableNumber("");
    }

    setSubmitting(false);
  };

  // Group menus by category
  const groupedMenus = menus.reduce((acc, menu) => {
    if (!acc[menu.category]) acc[menu.category] = [];
    acc[menu.category].push(menu);
    return acc;
  }, {} as Record<string, any[]>);

  if (loading) return <div className="p-8 text-center">메뉴를 불러오는 중...</div>;

  return (
    <PinLock storeId={store_id} role="order">
      <div className="container mx-auto p-4 max-w-5xl grid grid-cols-1 md:grid-cols-3 gap-6">
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
                {groupedMenus[category].map((menu) => (
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
                cart.map((item) => (
                  <div key={item.menu.id} className="flex justify-between items-center border-b pb-2">
                    <div>
                      <p className="font-bold">{item.menu.name}</p>
                      <p className="text-sm text-gray-500">{item.menu.price.toLocaleString()}원</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="icon" className="h-6 w-6" onClick={() => removeFromCart(item.menu.id)}>-</Button>
                      <span className="w-4 text-center font-bold">{item.quantity}</span>
                      <Button variant="outline" size="icon" className="h-6 w-6" onClick={() => addToCart(item.menu)}>+</Button>
                    </div>
                  </div>
                ))
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
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
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
                  disabled={submitting || cart.length === 0}
                >
                  {submitting ? "주문 전송 중..." : "주문 및 결제 완료"}
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
    </PinLock>
  );
}
