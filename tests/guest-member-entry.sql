\encoding UTF8
\set ON_ERROR_STOP on
\ir ../migrations/20261104_guest_member_entry.sql
BEGIN;
SET ROLE anon;
DO $$
DECLARE r jsonb; req uuid:=gen_random_uuid(); items jsonb:='[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":3000}]';
BEGIN
  r:=public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','지체현장','현금',items,'지체 손님','현장손님',' 홍지체 ',0,NULL);
  ASSERT (SELECT member_name FROM public.orders WHERE id=(r->>'id')::uuid)='홍지체';
  ASSERT public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','현장손님','') IS NULL;
  ASSERT public.submit_customer_order(req,'00000000-0000-0000-0000-000000000002','지체현장','현금',items,'지체 손님','현장손님',' 홍지체 ',0,NULL)=r;
  r:=public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','지체적립','현금',items,'지체 손님','현장손님','홍지체',0,5000);
  ASSERT (SELECT member_name FROM public.orders WHERE id=(r->>'id')::uuid)='홍지체';
  ASSERT public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','현장손님','')->>'member_name'='홍지체';
  ASSERT (public.lookup_coupon_account('00000000-0000-0000-0000-000000000002','지체 손님','현장손님','')->>'balance')::bigint=2000;
  r:=public.submit_customer_order(gen_random_uuid(),'00000000-0000-0000-0000-000000000002','기존보존','현금',items,'지체 손님','현장손님','다른지체',0,NULL);
  ASSERT (SELECT member_name FROM public.orders WHERE id=(r->>'id')::uuid)='홍지체';
END; $$;
RESET ROLE;
ROLLBACK;
