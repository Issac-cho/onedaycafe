import type { OptionGroup, OptionSpec, MenuSelection } from "./menuOptions";
export type SetComponent = { menu_id: string; quantity: number };
export type SetMenu = {
  id: string; name: string; price: number; category: string; kitchen_group: number;
  is_sold_out: boolean; is_hidden: boolean; is_deleted?: boolean;
  menu_type?: "single" | "component" | "set";
  set_components?: SetComponent[];
  option_groups?: OptionGroup[];
  cart_key?: string;
  option_schema?: OptionSpec[];
  selections?: MenuSelection[];
  selection_label?: string;
};

export function menuSaleIssue(menu: SetMenu, menus: Map<string, SetMenu>): string | null {
  if (menu.is_deleted || menu.is_hidden || menu.menu_type === "component") return "판매 중단";
  if (menu.is_sold_out) return "품절";
  if (menu.menu_type !== "set") return null;
  if (!menu.set_components?.length) return "세트 구성 확인 필요";
  for (const part of menu.set_components) {
    const component = menus.get(part.menu_id);
    if (!component || component.is_deleted || component.is_hidden || component.menu_type === "set") return "구성품 판매 중단";
    if (component.is_sold_out) return "구성품 품절";
  }
  return null;
}

export function setDescription(menu: SetMenu, menus: Map<string, SetMenu>) {
  return menu.menu_type === "set" ? (menu.set_components ?? []).map(part => `${menus.get(part.menu_id)?.name ?? "삭제된 구성품"} × ${part.quantity}`).join(" / ") : "";
}

export function setChanged(before: SetMenu, after: SetMenu) {
  return (before.menu_type ?? "single") !== (after.menu_type ?? "single")
    || JSON.stringify(before.set_components ?? []) !== JSON.stringify(after.set_components ?? []);
}
