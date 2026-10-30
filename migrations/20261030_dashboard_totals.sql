-- 수량별 조리·서빙 SQL 적용 후 실행. 기존 데이터는 변경하지 않는다.
CREATE OR REPLACE FUNCTION public.get_dashboard_totals(p_store_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'totalRevenue', COALESCE(SUM(COALESCE(i.menu_price, m.price, 0)::BIGINT * i.quantity), 0),
    'totalOrders', COUNT(DISTINCT o.id),
    'pendingItems', COALESCE(SUM(GREATEST(i.quantity - i.cooked_quantity, 0)), 0),
    'cookedItems', COALESCE(SUM(GREATEST(i.cooked_quantity - i.served_quantity, 0)), 0)
  )
  FROM public.orders o
  LEFT JOIN public.order_items i ON i.order_id = o.id
  LEFT JOIN public.menus m ON m.id = i.menu_id
  WHERE o.store_id = p_store_id;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_totals(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_totals(UUID) TO anon, authenticated;
