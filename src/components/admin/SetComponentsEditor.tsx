"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SetComponent, SetMenu } from "@/lib/menuSets";

export function SetComponentsEditor({ menus, value, onChange }: { menus: SetMenu[]; value: SetComponent[]; onChange: (value: SetComponent[]) => void }) {
  const choices = menus.filter(menu => menu.menu_type !== "set" && !menu.is_deleted);
  const unused = choices.filter(menu => !value.some(part => part.menu_id === menu.id));
  return <div className="space-y-3 rounded-lg border bg-white p-3">
    <p className="font-semibold">세트 1개에 들어가는 구성품</p>
    {value.map((part, index) => <div key={index} className="flex flex-wrap items-center gap-2">
      <select aria-label={`구성품 ${index + 1}`} className="min-w-0 flex-1 rounded-md border bg-white p-2 text-sm" value={part.menu_id} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, menu_id: e.target.value } : entry))}>
        {!choices.some(menu => menu.id === part.menu_id) && <option value={part.menu_id}>삭제된 구성품 · 다시 선택해 주세요</option>}
        {choices.filter(menu => menu.id === part.menu_id || !value.some(entry => entry.menu_id === menu.id)).map(menu => <option key={menu.id} value={menu.id}>{menu.name} · {menu.kitchen_group}구역{menu.is_sold_out ? " (품절)" : ""}{menu.is_hidden ? " (숨김)" : ""}</option>)}
      </select>
      <Input aria-label={`구성품 ${index + 1} 수량`} className="w-20" type="number" min={1} max={1000} step={1} value={part.quantity} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, quantity: Number(e.target.value) } : entry))} required />
      <span className="text-sm">개</span><Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, i) => i !== index))}>제거</Button>
    </div>)}
    <Button type="button" variant="outline" disabled={!unused.length || value.length >= 50} onClick={() => onChange([...value, { menu_id: unused[0].id, quantity: 1 }])}>구성품 추가</Button>
    {!choices.length && <p className="text-sm text-gray-500">일반 메뉴 또는 세트 구성 전용 메뉴를 먼저 등록해 주세요.</p>}
  </div>;
}
