\encoding UTF8
\set ON_ERROR_STOP on
SET ROLE anon;
BEGIN;
SELECT public.submit_order(:'request_id'::uuid,
 '00000000-0000-0000-0000-000000000002', '동시접수', '현금',
 '[{"menu_id":"00000000-0000-0000-0000-000000000003","quantity":1,"unit_price":3000}]');
SELECT pg_sleep(0.2);
COMMIT;
