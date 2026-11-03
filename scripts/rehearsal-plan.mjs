export function availableMenus(menus) {
  const byId = new Map(menus.map(menu => [menu.id, menu]));
  const active = menu => menu && !menu.is_sold_out && !menu.is_hidden && !menu.is_deleted;
  return menus.filter(menu => active(menu) && menu.menu_type !== "component" && (menu.menu_type !== "set"
    || (menu.set_components?.length && menu.set_components.every(part => active(byId.get(part.menu_id)) && byId.get(part.menu_id).menu_type !== "set"))));
}

export function makePlan(menus, index) {
  const selling = availableMenus(menus);
  if (!selling.length) throw new Error("판매 가능한 메뉴가 없습니다. 세트 구성품의 품절·숨김 상태도 확인해 주세요.");
  const byId = new Map(menus.map(menu => [menu.id, menu]));
  const lines = Array.from({ length: Math.min(3, selling.length) }, (_, offset) => {
    const menu = selling[(index + offset) % selling.length];
    const quantity = (index + offset) % 5 + 1;
    const parts = menu.menu_type === "set" ? menu.set_components : [{ menu_id: menu.id, quantity: 1 }];
    const selections = [];
    const work = parts.map(part => {
      const component = byId.get(part.menu_id);
      if (!Number.isInteger(component.kitchen_group) || component.kitchen_group < 1 || component.kitchen_group > 7) throw new Error(`${component.name ?? component.id}: 주방 구역은 1~7이어야 합니다.`);
      const groups = (component.option_groups ?? []).map((group, gi) => {
        if (!group.choices?.length || !Number.isInteger(group.count) || group.count < 1 || group.count * part.quantity > 100) throw new Error("세부 선택 항목·개수를 확인해 주세요.");
        return Array.from({ length: group.count * part.quantity }, (_, pick) => group.choices[(index + offset + gi + (index % 2 ? pick : 0)) % group.choices.length]).sort();
      });
      if (groups.length) selections.push({ menu_id: component.id, groups });
      return { menu_id: component.id, name: component.name, quantity: quantity * part.quantity,
        group: component.kitchen_group, price: menu.menu_type === "set" ? 0 : menu.price,
        choices: groups.flat(), perSetQuantity: part.quantity };
    });
    return { menu_id: menu.id, name: menu.name, quantity, price: menu.price, type: menu.menu_type ?? "single", work,
      input: { menu_id: menu.id, quantity, unit_price: menu.price,
        ...(menu.menu_type === "set" ? { components: menu.set_components } : {}), ...(selections.length ? { selections } : {}) } };
  });
  return { lines, items: lines.map(line => line.input), revenue: lines.reduce((sum, line) => sum + line.price * line.quantity, 0) };
}

export function verifyPlan(plan, sales, items, completed = false) {
  if (sales.length !== plan.lines.length || items.length !== plan.lines.reduce((sum, line) => sum + line.work.length, 0)) throw new Error("판매 행 또는 구성품 작업 개수가 맞지 않습니다.");
  for (const line of plan.lines) {
    const sale = sales.find(sale => sale.menu_id === line.menu_id);
    if (!sale || sale.quantity !== line.quantity || sale.menu_price !== line.price || sale.menu_name !== line.name) throw new Error("판매 메뉴·수량·세트 가격 스냅샷 불일치");
    if ((sale.components ?? []).length !== (line.type === "set" ? line.work.length : 0)) throw new Error("판매 구성 스냅샷 불일치");
    for (const expected of line.work) {
      const item = items.find(item => item.sale_line_id === sale.id && item.menu_id === expected.menu_id);
      if (!item || item.quantity !== expected.quantity || item.menu_price !== expected.price || !item.menu_name?.startsWith(expected.name)
        || expected.choices.some(choice => !item.menu_name.includes(choice) || !sale.option_summary?.includes(choice))) throw new Error("주방 작업의 구성품·수량·선택 내용 불일치");
      if (line.type === "set") {
        const snapshot = sale.components.find(part => part.menu_id === expected.menu_id);
        if (!snapshot || snapshot.quantity !== expected.perSetQuantity || snapshot.kitchen_group !== expected.group || item.set_name !== line.name || item.sale_quantity !== line.quantity) throw new Error("세트별 작업 연결·담당 구역 불일치");
      }
      if (completed && (item.cooked_quantity !== item.quantity || item.served_quantity !== item.quantity || item.status !== "served" || !item.cooked_at)) throw new Error("최종 조리·서빙 수량 또는 완료 시각 불일치");
    }
  }
}
