-- Run only on a disposable local/non-production database. All fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'recount_tasks', 'safe tasks table exists');
select has_table('public', 'recount_task_secrets', 'protected secrets table exists');
select has_table('public', 'recount_serial_evidence', 'protected evidence table exists');
select has_table('public', 'recount_batches', 'batches table exists');
select has_table('public', 'recount_attempts', 'attempts table exists');
select has_table('public', 'recount_code_resolutions', 'resolutions table exists');
select has_table('public', 'audit_logs', 'audit table exists');

-- Literal outcomes define the locale-independent normalization contract for clients.
select is(public.normalize_inventory_code(E' ａｂ\t12 ' || chr(8203) || chr(65279)), 'AB12', 'NFKC, ASCII casing, whitespace and zero-width normalization');
select is(public.normalize_inventory_code(U&'\00DFi\0131\0130'), U&'\00DFI\0131\0130', 'only ASCII lowercase letters are uppercased');
select is(public.normalize_inventory_code(U&'\FF41\FF42\FF11\FF12'), 'AB12', 'fullwidth ASCII folds before ASCII casing');
select is(public.normalize_inventory_code('A' || chr(133) || chr(5760) || chr(8199) || chr(8239) || chr(12288) || 'B'), 'AB', 'explicit Unicode whitespace set is removed');
select is(public.normalize_inventory_code(null), '', 'null normalizes to empty');
select is(public.mask_inventory_code('12345678AB12', null, 4), '********AB12', 'default final-four masking');
select is(public.mask_inventory_code('AAAA7X9QZZZZ', 5, 4), '****7X9Q****', 'one-based middle window');
select is(public.mask_inventory_code('12345678AB12', 99, 4), '********AB12', 'late windows shift left');
select is(public.mask_inventory_code('12345678AB12', 1, 99), '1234********', 'requested exposure is capped at four');
select is(public.mask_inventory_code('AB12', null, 4), '****', 'short codes never reveal their complete value');
select is(public.mask_inventory_code('A', null, 4), '*', 'single-character code remains secret');
select is(public.mask_inventory_code(null, null, 4), '', 'null masking is safe');
select is(public.mask_inventory_code('ABCDEF', 1, 0), '******', 'zero-width masks everything');

-- Auth owns is_anonymous. A pilot anonymous account has no email or named profile.
select lives_ok($$insert into auth.users (id, email, is_anonymous, raw_user_meta_data)
values ('10000000-0000-0000-0000-000000000008', null, true,
        '{"role":"admin","status":"active","is_anonymous":false}')$$,
  'legacy anonymous registration succeeds without a named profile');
select is((select count(*) from auth.users where id = '10000000-0000-0000-0000-000000000008'), 1::bigint, 'anonymous Auth identity retained');
select is((select count(*) from public.profiles where id = '10000000-0000-0000-0000-000000000008'), 0::bigint, 'anonymous Auth identity has no profile');

insert into auth.users (id, email, is_anonymous, raw_user_meta_data)
select ('10000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       'User' || i || '@Example.test', false,
       jsonb_build_object('full_name', ' User ' || i || ' ', 'erp_name', ' ERP ' || i || ' ',
                          'role', 'admin', 'status', 'active', 'is_anonymous', true)
from generate_series(1, 7) i;
select is((select count(*) from public.profiles where role = 'counter' and status = 'pending'), 7::bigint, 'registration metadata cannot grant privileges');
select is((select email from public.profiles where id = '10000000-0000-0000-0000-000000000001'), 'user1@example.test', 'registration lowercases email');
select is((select full_name from public.profiles where id = '10000000-0000-0000-0000-000000000001'), 'User 1', 'registration trims full name');
select is((select erp_name_normalized from public.profiles where id = '10000000-0000-0000-0000-000000000001'), 'ERP1', 'ERP alias normalized at registration');
update public.profiles set updated_at = '2000-01-01' where id = '10000000-0000-0000-0000-000000000001';
select is((select updated_at from public.profiles where id = '10000000-0000-0000-0000-000000000001'), now(), 'profile update timestamp is server-maintained');
select throws_ok($$update public.profiles set erp_name_normalized = 'ERP1' where id = '10000000-0000-0000-0000-000000000002'$$, '23505');
select throws_ok($$select private.bootstrap_initial_admin('99999999-0000-0000-0000-000000000000')$$, 'P0002');
select lives_ok($$select private.bootstrap_initial_admin('10000000-0000-0000-0000-000000000007')$$, 'operator can bootstrap initial admin');
select is((select role::text || '/' || status::text from public.profiles where id = '10000000-0000-0000-0000-000000000007'), 'admin/active', 'bootstrap activates intended admin');
select is((select count(*) from public.audit_logs where action = 'bootstrap_initial_admin'), 1::bigint, 'bootstrap audited');
select throws_ok($$select private.bootstrap_initial_admin('10000000-0000-0000-0000-000000000006')$$, '23505');
select ok(not has_function_privilege('authenticated', 'private.bootstrap_initial_admin(uuid)', 'EXECUTE'), 'authenticated cannot bootstrap');
select ok(not has_function_privilege('anon', 'private.bootstrap_initial_admin(uuid)', 'EXECUTE'), 'anon cannot bootstrap');
update public.profiles set status = 'active' where id in ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002');
update public.profiles set status = 'locked' where id = '10000000-0000-0000-0000-000000000004';
update public.profiles set status = 'deleted', deleted_at = now() where id = '10000000-0000-0000-0000-000000000005';
update public.profiles set role = 'manager', status = 'active' where id = '10000000-0000-0000-0000-000000000006';
select throws_ok($$delete from auth.users where id = '10000000-0000-0000-0000-000000000001'$$, '23503');
select lives_ok($$update public.profiles set erp_name_normalized = 'ERP1' where id = '10000000-0000-0000-0000-000000000005'$$, 'deleted alias does not reserve assignment name');

insert into public.inventory_sessions(id, session_name) values ('20000000-0000-0000-0000-000000000001', 'pgTAP fixture');
insert into public.monthly_archives(id, year_month, label)
values ('21000000-0000-0000-0000-000000000001', '2026-09', 'pgTAP archive');
insert into public.recount_batches(id, inventory_session_id, status, created_by)
values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'active', '10000000-0000-0000-0000-000000000006');
insert into public.recount_batches(id, inventory_session_id, status, created_by)
values ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'active', '10000000-0000-0000-0000-000000000006');
insert into public.recount_tasks(id, batch_id, source_detail_row_id, sku, product_name, first_count_status, assigned_user_id, task_type, masked_reference, state)
select ('40000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       '30000000-0000-0000-0000-000000000001', 'row-' || i, 'SKU1', 'Product', 'Bắn thiếu (Chưa quét)',
       ('10000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'missing_serial', '********AB12', 'assigned'
from generate_series(1, 5) i;
insert into public.recount_tasks(id, batch_id, source_detail_row_id, sku, product_name, first_count_status, task_type, masked_reference, state)
values ('40000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000001', 'row-unassigned', 'SKU1', 'Product', 'Bắn thiếu (Chưa quét)', 'missing_serial', '********AB12', 'unassigned');
insert into public.recount_tasks(
  id, batch_id, source_detail_row_id, sku, product_name, first_count_status,
  assigned_user_id, assigned_name_snapshot, task_type, masked_reference, state,
  resolution, completed_by, completed_by_name_snapshot, completed_at
) values (
  '40000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000001',
  'row-completed', 'SKU1', 'Product', 'Bắn thiếu (Chưa quét)',
  '10000000-0000-0000-0000-000000000003', 'User 3', 'missing_serial', '********AB12',
  'completed', 'matched', '10000000-0000-0000-0000-000000000003', 'User 3', now()
);
insert into public.recount_task_secrets(task_id, expected_serial_normalized)
select id, 'SECRET12AB12' from public.recount_tasks;
insert into public.recount_serial_evidence(batch_id, source_detail_row_id, sku, serial_normalized)
values ('30000000-0000-0000-0000-000000000001', 'row-evidence', 'SKU1', 'SECRET12AB12');
select throws_ok($$insert into public.recount_serial_evidence(batch_id, source_detail_row_id, sku, serial_normalized) values ('30000000-0000-0000-0000-000000000001', 'row-evidence', 'SKU1', 'SECRET12AB12')$$, '23505');
select hasnt_column('public', 'recount_tasks', 'expected_serial_normalized', 'safe tasks omit complete expected serial');
select hasnt_column('public', 'recount_tasks', 'first_scanned_code_normalized', 'safe tasks omit complete scanned code');
select col_not_null('public', 'recount_tasks', 'version', 'task version cannot be null');
select col_not_null('public', 'profiles', 'email', 'named profiles still require email');
select is((select version from public.recount_tasks limit 1), 1, 'task version supports later optimistic concurrency');
update public.recount_tasks set updated_at = '2000-01-01' where id = '40000000-0000-0000-0000-000000000001';
select is((select updated_at from public.recount_tasks where id = '40000000-0000-0000-0000-000000000001'), now(), 'task update timestamp is server-maintained');
select throws_ok($$update public.recount_tasks set version = 0 where id = '40000000-0000-0000-0000-000000000001'$$, '23514');
select throws_ok($$update public.recount_tasks set source_detail_row_id = 'row-1' where id = '40000000-0000-0000-0000-000000000002'$$, '23505');
update public.recount_tasks
set state = 'in_progress', assigned_name_snapshot = 'User 3'
where id = '40000000-0000-0000-0000-000000000003';
select ok(not has_table_privilege('authenticated', 'public.' || name, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), name || ': no direct client mutation')
from unnest(array['profiles', 'recount_batches', 'recount_tasks', 'recount_task_secrets', 'recount_serial_evidence', 'recount_attempts', 'recount_code_resolutions', 'audit_logs']) as names(name);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select ok(row_security_active('public.recount_tasks'), 'task RLS applies to authenticated users');
select ok(row_security_active('public.recount_task_secrets'), 'secret RLS is active even with grants revoked');
select ok(row_security_active('public.recount_serial_evidence'), 'evidence RLS is active');
select is(public.current_profile_role()::text, 'counter', 'active role comes from profile');
select ok(public.is_active_profile(), 'active account recognized');
select results_eq($$select source_detail_row_id from public.recount_tasks order by source_detail_row_id$$, $$values ('row-1'::text)$$, 'counter reads only own assigned safe task');
select is((select count(*) from public.recount_batches), 1::bigint, 'counter can read assigned batch metadata');
select is((select count(*) from public.recount_batches where id = '30000000-0000-0000-0000-000000000002'), 0::bigint, 'counter cannot read a batch without assigned work');
select is((select count(*) from public.recount_tasks where id = '40000000-0000-0000-0000-000000000006'), 0::bigint, 'counter cannot read unassigned work in an accessible batch');
select is((select count(*) from public.profiles), 1::bigint, 'counter reads only own profile');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select throws_ok($$select serial_normalized from public.recount_serial_evidence$$, '42501');
select throws_ok($$update public.profiles set role = 'admin'$$, '42501');
select throws_ok($$update public.recount_tasks set state = 'completed'$$, '42501');
select throws_ok($$insert into public.audit_logs(actor_name_snapshot, action, entity_type, entity_id) values ('fake', 'fake', 'task', 'fake')$$, '42501');
select is((select count(*) from public.audit_logs), 0::bigint, 'counter cannot read audit payloads');
select is((select count(*) from public.inventory_sessions), 0::bigint, 'counter cannot read legacy sessions with complete serial payloads');
select is((select count(*) from public.monthly_archives), 0::bigint, 'counter cannot read legacy monthly serial payloads');
select throws_ok($$insert into public.inventory_sessions(session_name) values ('counter write')$$, '42501');
select throws_ok($$insert into public.monthly_archives(year_month, label) values ('2026-10', 'counter write')$$, '42501');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select results_eq($$select source_detail_row_id from public.recount_tasks$$, $$values ('row-2'::text)$$, 'second counter cannot read first counter task');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');

-- Inactive profiles have deliberately assigned tasks: RLS must still deny them.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 0::bigint, 'pending counter has no operational access');
select is((select count(*) from public.recount_batches), 0::bigint, 'pending counter cannot read batches');
select is((select count(*) from public.profiles), 1::bigint, 'pending account can read own waiting status');
select ok(not public.is_active_profile(), 'pending profile is inactive');
select is((select count(*) from public.inventory_sessions), 0::bigint, 'pending account cannot read legacy sessions');
select is((select count(*) from public.monthly_archives), 0::bigint, 'pending account cannot read legacy archives');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 0::bigint, 'locked counter has no operational access');
select is((select count(*) from public.inventory_sessions), 0::bigint, 'locked counter cannot read legacy sessions');
select ok(not public.is_active_profile(), 'locked profile is inactive');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 0::bigint, 'deleted counter has no operational access');
select is((select count(*) from public.monthly_archives), 0::bigint, 'deleted counter cannot read legacy archives');
select ok(not public.is_active_profile(), 'deleted profile is inactive');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 7::bigint, 'active manager can read all safe tasks including unassigned');
select is((select count(*) from public.profiles), 7::bigint, 'active manager can read account list');
select is((select count(*) from public.audit_logs), 1::bigint, 'active manager can read audit');
select is((select count(*) from public.inventory_sessions), 1::bigint, 'active manager can read existing legacy sessions');
select is((select count(*) from public.monthly_archives), 1::bigint, 'active manager can read existing legacy archives');
select lives_ok($$update public.inventory_sessions set session_name = 'manager update'$$, 'active manager can update legacy sessions');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select throws_ok($$select serial_normalized from public.recount_serial_evidence$$, '42501');
select throws_ok($$update public.profiles set role = 'admin'$$, '42501');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 7::bigint, 'active admin can read all safe tasks including unassigned');
select is((select count(*) from public.profiles), 7::bigint, 'active admin can read account list');
select is((select count(*) from public.inventory_sessions), 1::bigint, 'active admin can read existing legacy sessions');
select is((select count(*) from public.monthly_archives), 1::bigint, 'active admin can read existing legacy archives');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select throws_ok($$select serial_normalized from public.recount_serial_evidence$$, '42501');

-- Account lifecycle RPCs authorize from active profiles, preserve roles, and update
-- profile/task/audit state in one database transaction.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.manager_approve_profile('10000000-0000-0000-0000-000000000003', 'ERP NEW')$$,
  '42501',
  null,
  'counter cannot approve a profile'
);

select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select throws_ok(
  $$select public.manager_approve_profile('10000000-0000-0000-0000-000000000003', ' ERP 1 ')$$,
  '23505',
  null,
  'approval rejects a normalized ERP alias already held by a non-deleted profile'
);
select lives_ok(
  $$select public.manager_approve_profile('10000000-0000-0000-0000-000000000003', E' ERP\tNEW ')$$,
  'manager approves a pending counter with an editable ERP alias'
);
select is(
  (select role::text || '/' || status::text || '/' || erp_name_normalized from public.profiles where id = '10000000-0000-0000-0000-000000000003'),
  'counter/active/ERPNEW',
  'approval preserves the counter role and stores a normalized unique alias'
);
select is(
  (select approved_by from public.profiles where id = '10000000-0000-0000-0000-000000000003'),
  '10000000-0000-0000-0000-000000000006'::uuid,
  'approval records the manager'
);
select is((select count(*) from public.audit_logs where action = 'approve_profile' and entity_id = '10000000-0000-0000-0000-000000000003'), 1::bigint, 'approval is audited');
select throws_ok(
  $$select public.manager_approve_profile('10000000-0000-0000-0000-000000000007', 'ADMIN')$$,
  '42501',
  null,
  'manager cannot operate on an admin'
);

select throws_ok(
  $$select public.manager_lock_profile('10000000-0000-0000-0000-000000000003', '   ')$$,
  '22023',
  null,
  'locking requires a reason'
);
select lives_ok(
  $$select public.manager_lock_profile('10000000-0000-0000-0000-000000000003', 'Nghỉ việc')$$,
  'manager locks a counter'
);
select is((select status::text from public.profiles where id = '10000000-0000-0000-0000-000000000003'), 'locked', 'lock changes profile status');
select is(
  (select state::text || '/' || coalesce(assigned_user_id::text, 'none') || '/' || coalesce(assigned_name_snapshot, 'none') from public.recount_tasks where id = '40000000-0000-0000-0000-000000000003'),
  'unassigned/none/none',
  'locking atomically releases incomplete work'
);
select is(
  (select state::text || '/' || assigned_user_id::text || '/' || assigned_name_snapshot || '/' || completed_by_name_snapshot from public.recount_tasks where id = '40000000-0000-0000-0000-000000000007'),
  'completed/10000000-0000-0000-0000-000000000003/User 3/User 3',
  'locking retains completed assignment and attribution snapshots'
);
select is((select count(*) from public.audit_logs where action = 'lock_profile' and entity_id = '10000000-0000-0000-0000-000000000003' and reason = 'Nghỉ việc'), 1::bigint, 'locking is audited with its reason');
select throws_ok(
  $$select public.manager_lock_profile('10000000-0000-0000-0000-000000000007', 'forbidden')$$,
  '42501',
  null,
  'manager cannot lock an admin'
);

reset role;
update public.profiles set status = 'locked' where role in ('manager', 'admin');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 0::bigint, 'locked manager loses all task access');
select is((select count(*) from public.audit_logs), 0::bigint, 'locked manager loses audit access');
select is((select count(*) from public.inventory_sessions), 0::bigint, 'locked manager loses legacy session access');
select is((select count(*) from public.monthly_archives), 0::bigint, 'locked manager loses legacy archive access');
select throws_ok(
  $$select public.manager_lock_profile('10000000-0000-0000-0000-000000000001', 'forbidden while inactive')$$,
  '42501',
  null,
  'locked manager cannot call lifecycle RPCs'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
select is((select count(*) from public.recount_tasks), 0::bigint, 'locked admin loses all task access');
select set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-000000000000","role":"authenticated","user_metadata":{"role":"admin","status":"active"}}', true);
select is((select count(*) from public.recount_tasks), 0::bigint, 'missing profile cannot authorize from metadata');
select ok(not public.is_active_profile(), 'missing profile is inactive');
-- Signed-in anonymous Auth users assume authenticated, not the anon SQL role.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000008","role":"authenticated","is_anonymous":true,"user_metadata":{"role":"admin","status":"active"}}', true);
select ok(not public.is_active_profile(), 'signed-in anonymous identity has no active profile');
select is(public.current_profile_role(), null::public.app_role, 'anonymous identity has no application role');
select is((select count(*) from public.profiles), 0::bigint, 'anonymous identity cannot read profiles');
select is((select count(*) from public.recount_tasks), 0::bigint, 'anonymous identity cannot read new tasks');
select is((select count(*) from public.recount_batches), 0::bigint, 'anonymous identity cannot read new batches');
select is((select count(*) from public.recount_attempts), 0::bigint, 'anonymous identity cannot read attempts');
select is((select count(*) from public.recount_code_resolutions), 0::bigint, 'anonymous identity cannot read resolutions');
select is((select count(*) from public.audit_logs), 0::bigint, 'anonymous identity cannot read audit');
select is((select count(*) from public.inventory_sessions), 0::bigint, 'anonymous identity cannot read legacy sessions');
select is((select count(*) from public.monthly_archives), 0::bigint, 'anonymous identity cannot read legacy archives');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select throws_ok($$select serial_normalized from public.recount_serial_evidence$$, '42501');
select throws_ok($$update public.recount_tasks set state = 'completed'$$, '42501');
reset role;
select throws_ok($$select private.bootstrap_initial_admin('10000000-0000-0000-0000-000000000007')$$, '42501');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select * from public.recount_tasks$$, '42501');
select throws_ok($$select expected_serial_normalized from public.recount_task_secrets$$, '42501');
select throws_ok($$select serial_normalized from public.recount_serial_evidence$$, '42501');
reset role;

select * from finish();
rollback;
