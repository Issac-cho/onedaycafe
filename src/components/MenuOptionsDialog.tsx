"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { SetMenu } from "@/lib/menuSets";
import { selectionLabel, type OptionSpec, type MenuSelection } from "@/lib/menuOptions";

export function MenuOptionsDialog({ menu, specs, onAdd, onClose }: { menu: SetMenu; specs: OptionSpec[]; onAdd: (menu: SetMenu) => void; onClose: () => void }) {
  const [selections, setSelections] = useState<MenuSelection[]>(specs.map(spec => ({ menu_id: spec.menu_id, groups: spec.groups.map(group => Array(group.count * spec.multiplier).fill("")) })));
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
    <DialogHeader><DialogTitle>{menu.name} · 세부 선택</DialogTitle><DialogDescription>판매 메뉴 1개 기준으로 선택해 주세요. 같은 항목도 여러 번 선택할 수 있습니다.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={e => {
      e.preventDefault();
      if (selections.some(selection => selection.groups.some(values => values.some(value => !value)))) return;
      const normalized = selections.map(selection => ({ ...selection, groups: selection.groups.map(values => [...values].sort()) }));
      onAdd({ ...menu, option_schema: specs, selections: normalized, selection_label: selectionLabel(specs, normalized), cart_key: `${menu.id}:${JSON.stringify(normalized)}` }); onClose();
    }}>
      {specs.map((spec, si) => <div key={spec.menu_id} className="space-y-3"><p className="font-semibold">{spec.name}</p>{spec.groups.map((group, gi) => <div key={gi} className="space-y-2">{selections[si].groups[gi].map((value, vi) => <label key={vi} className="flex items-center gap-3 text-sm"><span className="min-w-24">{group.name}{selections[si].groups[gi].length > 1 ? ` ${vi + 1}` : ""}</span><select className="min-w-0 flex-1 rounded border bg-white p-2" required value={value} onChange={e => setSelections(previous => previous.map((selection, i) => i !== si ? selection : { ...selection, groups: selection.groups.map((values, j) => j !== gi ? values : values.map((entry, k) => k === vi ? e.target.value : entry)) }))}><option value="">선택하세요</option>{group.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select></label>)}</div>)}</div>)}
      <div className="flex gap-2"><Button type="button" variant="outline" onClick={onClose}>취소</Button><Button type="submit" className="flex-1">장바구니에 추가</Button></div>
    </form>
  </DialogContent></Dialog>;
}
