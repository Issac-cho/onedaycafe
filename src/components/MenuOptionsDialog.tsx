"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { SetMenu } from "@/lib/menuSets";
import { selectionLabel, type OptionSpec, type MenuSelection } from "@/lib/menuOptions";

export function MenuOptionsDialog({ menu, specs, onAdd, onClose }: { menu: SetMenu; specs: OptionSpec[]; onAdd: (menu: SetMenu) => void; onClose: () => void }) {
  const [selections, setSelections] = useState<MenuSelection[]>(specs.map(spec => ({ menu_id: spec.menu_id, groups: spec.groups.map(group => Array(group.count * spec.multiplier).fill("")) })));
  const [warning, setWarning] = useState<{ si: number; gi: number; text: string } | null>(null);
  const changeChoice = (si: number, gi: number, choice: string, remove = false) => {
    const values = selections[si].groups[gi];
    const index = remove ? values.lastIndexOf(choice) : values.indexOf("");
    if (index < 0) {
      if (!remove) setWarning({ si, gi, text: `${specs[si].groups[gi].name}은(는) 최대 ${values.length}개까지 선택할 수 있습니다.` });
      return;
    }
    setWarning(null);
    setSelections(previous => previous.map((selection, i) => i !== si ? selection : {
      ...selection, groups: selection.groups.map((entries, j) => j !== gi ? entries : entries.map((entry, k) => k === index ? (remove ? "" : choice) : entry)),
    }));
  };
  const complete = selections.every(selection => selection.groups.every(values => values.every(Boolean)));
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
    <DialogHeader><DialogTitle>{menu.name} · 세부 선택</DialogTitle><DialogDescription>판매 메뉴 1개 기준으로 선택해 주세요. 같은 항목도 여러 번 선택할 수 있습니다.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={e => {
      e.preventDefault();
      if (selections.some(selection => selection.groups.some(values => values.some(value => !value)))) return;
      const normalized = selections.map(selection => ({ ...selection, groups: selection.groups.map(values => [...values].sort()) }));
      onAdd({ ...menu, option_schema: specs, selections: normalized, selection_label: selectionLabel(specs, normalized), cart_key: `${menu.id}:${JSON.stringify(normalized)}` }); onClose();
    }}>
      {specs.map((spec, si) => <div key={spec.menu_id} className="space-y-3"><p className="font-semibold">{spec.name}</p>{spec.groups.map((group, gi) => {
        const values = selections[si].groups[gi];
        return <fieldset key={gi} className="space-y-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{group.name} · {values.filter(Boolean).length}/{values.length}개 선택</legend>
          <div className="flex flex-wrap gap-2">{group.choices.map(choice => {
            const count = values.filter(value => value === choice).length;
            return <div key={choice} className="flex items-center gap-1">
              <Button type="button" variant={count ? "default" : "outline"} className="min-h-11" aria-label={`${choice} 추가`} aria-pressed={count > 0} onClick={() => changeChoice(si, gi, choice)}>{choice}{count > 0 && <span className="ml-1">× {count}</span>}</Button>
              {count > 0 && <Button type="button" variant="outline" size="icon" className="min-h-11 min-w-11" aria-label={`${choice} 하나 빼기`} onClick={() => changeChoice(si, gi, choice, true)}>−</Button>}
            </div>;
          })}</div>
          {warning?.si === si && warning.gi === gi && <p role="alert" className="text-sm text-orange-700">{warning.text}</p>}
        </fieldset>;
      })}</div>)}
      <div className="flex gap-2"><Button type="button" variant="outline" className="min-h-11" onClick={onClose}>취소</Button><Button type="submit" disabled={!complete} className="min-h-11 flex-1">장바구니에 추가</Button></div>
    </form>
  </DialogContent></Dialog>;
}
