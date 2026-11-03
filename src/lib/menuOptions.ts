import type { SetMenu } from "./menuSets";

export type OptionGroup = { name: string; choices: string[]; count: number };
export type MenuSelection = { menu_id: string; groups: string[][] };
export type OptionSpec = { menu_id: string; name: string; groups: OptionGroup[]; multiplier: number };

export function optionSpecs(menu: SetMenu, menus: Map<string, SetMenu>): OptionSpec[] {
  const targets = menu.menu_type === "set" ? (menu.set_components ?? []).map(part => ({ menu: menus.get(part.menu_id), multiplier: part.quantity })) : [{ menu, multiplier: 1 }];
  return targets.flatMap(target => target.menu?.option_groups?.length ? [{ menu_id: target.menu.id, name: target.menu.name, groups: target.menu.option_groups, multiplier: target.multiplier }] : []);
}

export function selectionLabel(specs: OptionSpec[], selections: MenuSelection[]) {
  return specs.map(spec => `${spec.name}: ${spec.groups.map((group, index) => `${group.name} ${selections.find(value => value.menu_id === spec.menu_id)?.groups[index]?.join(" / ") ?? ""}`).join(", ")}`).join(" · ");
}

export function cartKey(menu: SetMenu) { return menu.cart_key ?? menu.id; }

export function refreshedCartMenu(before: SetMenu, current: SetMenu, menus: Map<string, SetMenu>): SetMenu | null {
  const specs = optionSpecs(current, menus);
  if (!specs.length) return { ...current };
  const selections: MenuSelection[] = [];
  for (const spec of specs) {
    const oldSpec = before.option_schema?.find(entry => entry.menu_id === spec.menu_id);
    const oldSelection = before.selections?.find(entry => entry.menu_id === spec.menu_id);
    if (!oldSpec || !oldSelection) return null;
    const groups: string[][] = [];
    for (const group of spec.groups) {
      const indices = oldSpec.groups.flatMap((old, index) => old.name === group.name ? [index] : []);
      if (indices.length !== 1) return null;
      const values = oldSelection.groups[indices[0]];
      if (!values || values.length !== group.count * spec.multiplier || values.some(value => !group.choices.includes(value))) return null;
      groups.push([...values].sort());
    }
    selections.push({ menu_id: spec.menu_id, groups });
  }
  return { ...current, option_schema: specs, selections, selection_label: selectionLabel(specs, selections), cart_key: `${current.id}:${JSON.stringify(selections)}` };
}

export function replaceCartEntry<T extends { menu: SetMenu; quantity: number }>(items: T[], key: string, menu: SetMenu): T[] {
  const index = items.findIndex(item => cartKey(item.menu) === key);
  if (index < 0) return items;
  const original = items[index];
  const remaining = items.filter((_, i) => i !== index);
  const match = remaining.find(item => cartKey(item.menu) === cartKey(menu));
  if (match) return remaining.map(item => item === match ? { ...item, quantity: item.quantity + original.quantity } : item);
  remaining.splice(Math.min(index, remaining.length), 0, { ...original, menu });
  return remaining;
}

export function splitWorkLabel(name: string) {
  const [title, ...details] = name.split(" · ");
  return { title, options: details.join(" · ") };
}
