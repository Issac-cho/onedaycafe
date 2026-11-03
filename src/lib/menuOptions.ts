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
