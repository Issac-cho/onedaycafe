-- 기존 계정·잔액·주문은 유지하고 지체 이름으로도 손님 계정을 검색한다.
BEGIN;
CREATE OR REPLACE FUNCTION public.find_friend_accounts(p_store_id UUID,p_customer_name TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'customer_type',customer_type,
    'customer_name',customer_name,'member_name',member_name) ORDER BY customer_name,customer_type,id),'[]'::jsonb)
  FROM public.coupon_accounts
  WHERE store_id=p_store_id AND btrim(p_customer_name)<>''
    AND customer_type IN ('개척자','지체 손님')
    AND (customer_name=btrim(p_customer_name)
      OR (customer_type='지체 손님' AND member_name=btrim(p_customer_name)));
$$;
REVOKE ALL ON FUNCTION public.find_friend_accounts(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_friend_accounts(UUID,TEXT) TO anon,authenticated;
COMMIT;
