"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";

import { SetComponentsEditor } from "@/components/admin/SetComponentsEditor";
import { setDescription, type SetMenu as Menu, type SetComponent } from "@/lib/menuSets";

export function MenuManager({ storeId }: { storeId: string }) {
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(true);
  
  // New Menu Form State
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("식사");
  const [kitchenGroup, setKitchenGroup] = useState("1");
  const [menuType, setMenuType] = useState<"single" | "component" | "set">("single");
  const [components, setComponents] = useState<SetComponent[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const resetForm = () => { setName(""); setPrice(""); setComponents([]); setEditing(null); setMenuType("single"); };

  const fetchMenus = useCallback(async () => {
    setLoading(true);
    try {
      const rows: Menu[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from("menus").select("*").eq("store_id", storeId)
          .eq("is_deleted", false).order("created_at", { ascending: false }).order("id").range(offset, offset + 499);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 500) break;
      }
      setMenus(rows);
    } catch { alert("메뉴 목록을 조회하지 못했습니다. 다시 시도해 주세요."); }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    void Promise.resolve().then(fetchMenus);
  }, [fetchMenus]);

  const handleAddMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const amount = menuType === "component" ? 0 : Number(price);
    if (!name.trim() || !Number.isInteger(amount) || amount < 0 || amount > 1000000000
      || (menuType !== "set" && (!Number.isInteger(Number(kitchenGroup)) || Number(kitchenGroup) < 1))
      || (menuType === "set" && (!components.length || components.some(part => !Number.isInteger(part.quantity) || part.quantity < 1 || part.quantity > 1000)))) {
      alert("메뉴 이름·가격·주방·구성품 수량을 확인해 주세요."); return;
    }
    setSaving(true);
    try {
      const fields = { name: name.trim(), price: amount, category, kitchen_group: menuType === "set" ? 1 : Number(kitchenGroup),
        menu_type: menuType, set_components: menuType === "set" ? components : [] };
      const query = editing ? supabase.from("menus").update(fields).eq("id", editing).eq("store_id", storeId).eq("is_deleted", false)
        : supabase.from("menus").insert([{ ...fields, store_id: storeId }]);
      const { data, error } = await query.select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("메뉴를 저장하지 못했습니다.");
      resetForm(); await fetchMenus();
    } catch (error) { alert("메뉴 저장 실패: " + (error instanceof Error ? error.message : "입력 정보를 확인해 주세요.")); }
    finally { setSaving(false); }
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
    if (!confirm("이 메뉴를 삭제하시겠습니까? 기존 주문 내역과 매출 기록은 보존됩니다.")) return;
    try {
      const { data, error } = await supabase.from("menus")
        .update({ is_deleted: true, is_hidden: true })
        .eq("id", menuId).eq("store_id", storeId).eq("is_deleted", false).select("id");
      if (error) throw error;
      if (!data?.length) alert("이미 삭제되었거나 변경 권한이 없는 메뉴입니다.");
      await fetchMenus();
    } catch (error) {
      console.error("메뉴 삭제 실패", error);
      alert("메뉴를 삭제하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleAddMenu} className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end bg-gray-50 p-4 rounded-lg">
        <div className="md:col-span-5 flex flex-wrap gap-2">{([['single', '일반 메뉴'], ['component', '세트 구성 전용'], ['set', '세트 메뉴']] as const).map(([value, label]) => <Button key={value} type="button" disabled={!!editing || saving} variant={menuType === value ? "default" : "outline"} onClick={() => { setMenuType(value); setComponents([]); }}>{label}</Button>)}</div>
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
          <Input id="price" type="number" min={0} step={1} disabled={menuType === "component"} value={menuType === "component" ? "0" : price} onChange={(e) => setPrice(e.target.value)} placeholder="5000" required={menuType !== "component"} />
        </div>
        {menuType !== "set" && <div className="space-y-2">
          <Label htmlFor="kitchenGroup">담당 주방(구역)</Label>
          <Input id="kitchenGroup" type="number" value={kitchenGroup} onChange={(e) => setKitchenGroup(e.target.value)} placeholder="1" min={1} step={1} required />
        </div>}
        {menuType === "set" && <div className="md:col-span-5"><SetComponentsEditor menus={menus} value={components} onChange={setComponents} /></div>}
        {menuType === "component" && <p className="md:col-span-5 text-sm text-gray-500">구성 전용 메뉴는 단품으로 판매하지 않으며 세트의 주방 작업에만 사용합니다. 가격은 세트 메뉴에 입력합니다.</p>}
        <div className="md:col-span-5 flex gap-2">
          <Button type="submit" disabled={saving} className="flex-1">{saving ? "저장 중..." : editing ? "세트 메뉴 수정" : "새 메뉴 등록하기"}</Button>
          {editing && <Button type="button" variant="outline" disabled={saving} onClick={resetForm}>수정 취소</Button>}
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
                      {menu.menu_type === "set" && <span className="ml-2 text-xs text-blue-600">[세트]</span>}
                      {menu.menu_type === "component" && <span className="ml-2 text-xs text-gray-500">[구성 전용]</span>}
                      {menu.menu_type === "set" && <p className="text-xs font-normal text-gray-500">{setDescription(menu, new Map(menus.map(entry => [entry.id, entry])))}</p>}
                      {menu.is_sold_out && <span className="ml-2 text-xs text-red-500 font-bold">[품절]</span>}
                      {menu.is_hidden && <span className="ml-2 text-xs text-gray-500 font-bold">[숨김]</span>}
                    </TableCell>
                    <TableCell>{menu.menu_type === "component" ? "구성 전용" : `${menu.price.toLocaleString()}원`}</TableCell>
                    <TableCell>{menu.menu_type === "set" ? "구성품별 주방" : `${menu.kitchen_group}구역`}</TableCell>
                    <TableCell className="text-right space-x-2 whitespace-nowrap">
                      {menu.menu_type === "set" && <Button variant="outline" size="sm" onClick={() => { setEditing(menu.id); setName(menu.name); setPrice(String(menu.price)); setCategory(menu.category); setMenuType("set"); setComponents(menu.set_components ?? []); }}>세트 수정</Button>}
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
