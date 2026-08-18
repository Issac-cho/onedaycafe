"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";

export function MenuManager({ storeId }: { storeId: string }) {
  const [menus, setMenus] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // New Menu Form State
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("식사");
  const [kitchenGroup, setKitchenGroup] = useState("1");

  useEffect(() => {
    fetchMenus();
  }, [storeId]);

  const fetchMenus = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("menus")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false });
    
    if (data) setMenus(data);
    setLoading(false);
  };

  const handleAddMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("menus").insert([
      {
        store_id: storeId,
        name,
        price: parseInt(price),
        category,
        kitchen_group: parseInt(kitchenGroup),
      }
    ]);

    if (error) {
      alert("메뉴 추가 실패: " + error.message);
    } else {
      setName("");
      setPrice("");
      fetchMenus();
    }
  };

  const toggleSoldOut = async (menuId: string, currentStatus: boolean) => {
    await supabase.from("menus").update({ is_sold_out: !currentStatus }).eq("id", menuId);
    fetchMenus();
  };

  const toggleHidden = async (menuId: string, currentStatus: boolean) => {
    await supabase.from("menus").update({ is_hidden: !currentStatus }).eq("id", menuId);
    fetchMenus();
  };

  const deleteMenu = async (menuId: string) => {
    if (confirm("정말 이 메뉴를 삭제하시겠습니까?")) {
      await supabase.from("menus").delete().eq("id", menuId);
      fetchMenus();
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleAddMenu} className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end bg-gray-50 p-4 rounded-lg">
        <div className="space-y-2">
          <Label htmlFor="category">카테고리</Label>
          <Input id="category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="예: 식사, 음료" required />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="name">메뉴명</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="메뉴 이름" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="price">가격 (원)</Label>
          <Input id="price" type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="5000" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="kitchenGroup">담당 주방(구역)</Label>
          <Input id="kitchenGroup" type="number" value={kitchenGroup} onChange={(e) => setKitchenGroup(e.target.value)} placeholder="1" required />
        </div>
        <div className="md:col-span-5">
          <Button type="submit" className="w-full">새 메뉴 등록하기</Button>
        </div>
      </form>

      {loading ? (
        <p className="text-center text-gray-500 py-4">메뉴 목록을 불러오는 중...</p>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>카테고리</TableHead>
                <TableHead>메뉴명</TableHead>
                <TableHead>가격</TableHead>
                <TableHead>주방(구역)</TableHead>
                <TableHead className="text-right">관리 옵션</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {menus.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-gray-500">등록된 메뉴가 없습니다.</TableCell>
                </TableRow>
              ) : (
                menus.map((menu) => (
                  <TableRow key={menu.id} className={menu.is_hidden ? "opacity-50" : ""}>
                    <TableCell>{menu.category}</TableCell>
                    <TableCell className="font-medium">
                      {menu.name}
                      {menu.is_sold_out && <span className="ml-2 text-xs text-red-500 font-bold">[품절]</span>}
                      {menu.is_hidden && <span className="ml-2 text-xs text-gray-500 font-bold">[숨김]</span>}
                    </TableCell>
                    <TableCell>{menu.price.toLocaleString()}원</TableCell>
                    <TableCell>{menu.kitchen_group}구역</TableCell>
                    <TableCell className="text-right space-x-2 whitespace-nowrap">
                      <Button variant="outline" size="sm" onClick={() => toggleSoldOut(menu.id, menu.is_sold_out)}>
                        {menu.is_sold_out ? "품절 해제" : "품절 처리"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => toggleHidden(menu.id, menu.is_hidden)}>
                        {menu.is_hidden ? "표시하기" : "숨기기"}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => deleteMenu(menu.id)}>
                        삭제
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
