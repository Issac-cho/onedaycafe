"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OptionGroup } from "@/lib/menuOptions";

export function MenuOptionsEditor({ value, onChange }: { value: OptionGroup[]; onChange: (groups: OptionGroup[]) => void }) {
  const update = (index: number, fields: Partial<OptionGroup>) => onChange(value.map((group, i) => i === index ? { ...group, ...fields } : group));
  return <div className="space-y-3 rounded-lg border bg-white p-3">
    <p className="font-semibold">세부 선택 (선택 사항)</p>
    {value.map((group, index) => <div key={index} className="space-y-2 rounded border p-3">
      <Input aria-label={`선택 ${index + 1} 이름`} placeholder="선택 이름 · 예: 온도, 소스, 음료 종류" value={group.name} onChange={e => update(index, { name: e.target.value })} required maxLength={100} />
      <Input aria-label={`선택 ${index + 1} 항목`} placeholder="선택 항목 · 예: 아이스, 핫" value={group.choices.join(",")} onChange={e => update(index, { choices: e.target.value.split(",") })} required />
      <div className="flex flex-wrap items-center gap-2 text-sm"><span>선택 개수</span><Input aria-label={`선택 ${index + 1} 개수`} type="number" className="w-20" min={1} max={10} step={1} value={group.count} onChange={e => update(index, { count: Number(e.target.value) })} required /><Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, i) => i !== index))}>삭제</Button></div>
    </div>)}
    <Button type="button" variant="outline" disabled={value.length >= 10} onClick={() => onChange([...value, { name: "", choices: [], count: 1 }])}>세부 선택 추가</Button>
    <p className="text-xs text-gray-500">항목은 쉼표로 구분합니다. 여러 개를 고를 때 같은 항목을 반복 선택할 수 있습니다. 세트는 구성품에 등록된 선택을 사용합니다.</p>
  </div>;
}
