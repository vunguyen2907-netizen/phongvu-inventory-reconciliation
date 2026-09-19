-- Chạy một lần trong Supabase Dashboard > SQL Editor.
-- Phiên bản 2: Thêm bảng monthly_archives cho tính năng lưu trữ hàng tháng.
create extension if not exists pgcrypto;

-- ============================================================
-- BẢNG 1: inventory_sessions — lưu đợt kiểm kê đang làm việc
-- ============================================================
create table if not exists public.inventory_sessions (
    id uuid primary key default gen_random_uuid(),
    session_name text not null,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at_column()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists inventory_sessions_updated_at on public.inventory_sessions;
create trigger inventory_sessions_updated_at
before update on public.inventory_sessions
for each row execute procedure public.set_updated_at_column();

alter table public.inventory_sessions enable row level security;

drop policy if exists inventory_sessions_authenticated_all on public.inventory_sessions;

-- ============================================================
-- BẢNG 2: monthly_archives — lưu trữ báo cáo tổng hợp hàng tháng
--          Rolling 12 tháng, tự động xóa tháng cũ khi > 12
-- ============================================================
create table if not exists public.monthly_archives (
    id          uuid primary key default gen_random_uuid(),
    year_month  text not null,          -- Định dạng "YYYY-MM", VD: "2026-07"
    label       text not null,          -- Nhãn hiển thị, VD: "Tháng 07/2026 — Khánh Hội"
    summary     jsonb not null default '{}'::jsonb,  -- df báo cáo tổng hợp (TH-HANG HOA)
    df_recon    jsonb,                  -- df tồn kho đối soát
    df_detail   jsonb,                  -- df chi tiết serial (sheet check)
    df_count_l2 jsonb,                  -- df kiểm đếm lần 2
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint monthly_archives_year_month_key unique (year_month)
);

create index if not exists monthly_archives_year_month_idx
    on public.monthly_archives (year_month desc);

drop trigger if exists monthly_archives_updated_at on public.monthly_archives;
create trigger monthly_archives_updated_at
before update on public.monthly_archives
for each row execute procedure public.set_updated_at_column();

alter table public.monthly_archives enable row level security;

drop policy if exists monthly_archives_authenticated_all on public.monthly_archives;

-- Secure second-count subsystem (202609160001).
-- New objects are migration-managed; apply this section once.
-- Legacy payload policies are installed after the authoritative profile helpers.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.app_role as enum ('admin', 'manager', 'counter');
create type public.profile_status as enum ('pending', 'active', 'locked', 'deleted');
create type public.recount_batch_status as enum ('draft', 'active', 'completed', 'reopened');
create type public.recount_task_type as enum ('missing_serial', 'wrong_serial', 'surplus_scan');
create type public.recount_task_state as enum ('unassigned', 'assigned', 'in_progress', 'ready', 'completed', 'reopened');
create type public.recount_resolution as enum ('matched', 'corrected_serial', 'not_found', 'same_product_multiple_codes', 'mistaken_first_scan', 'genuine_surplus');
create type public.recount_attempt_result as enum ('matched', 'duplicate_first_count', 'wrong_sku', 'unknown_serial', 'duplicate_attempt', 'not_found');

create or replace function public.normalize_inventory_code(p_value text)
returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(
    translate(
      normalize(coalesce(p_value, ''), NFKC),
      'abcdefghijklmnopqrstuvwxyz',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    ),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200D\2028\2029\202F\205F\2060\3000\FEFF]',
    '',
    'g'
  );
$$;

-- p_start is a one-based reveal window; NULL selects the final four.
-- Codes <= 4 characters remain entirely masked: never reveal a complete code.
create or replace function public.mask_inventory_code(p_value text, p_start integer default null, p_length integer default 4)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_code text := public.normalize_inventory_code(p_value);
  v_size integer := char_length(v_code);
  v_width integer := greatest(0, least(coalesce(p_length, 4), 4));
  v_start integer;
begin
  if v_size <= 4 or v_width = 0 then
    return repeat('*', v_size);
  end if;
  v_start := greatest(1, least(coalesce(p_start, v_size - v_width + 1), v_size - v_width + 1));
  return repeat('*', v_start - 1)
      || substr(v_code, v_start, v_width)
      || repeat('*', v_size - v_start - v_width + 1);
end;
$$;

create table public.profiles (
  -- Intentionally non-cascading: lifecycle deletion must disable/soft-delete Auth.
  id uuid primary key references auth.users(id),
  email text not null,
  full_name text not null,
  erp_name text not null,
  erp_name_normalized text not null,
  role public.app_role not null default 'counter',
  status public.profile_status not null default 'pending',
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  locked_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_status_role_idx on public.profiles (status, role);
create unique index profiles_erp_name_normalized_key
  on public.profiles (erp_name_normalized) where status <> 'deleted';

-- Unlock spans PostgreSQL and Auth. Keep a durable, server-owned lease while
-- the profile remains locked so only one request may touch Auth and any failed
-- or interrupted request remains denied by RLS.
create table private.profile_unlock_operations (
  operation_id uuid primary key,
  target_user_id uuid not null unique references public.profiles(id),
  requested_by uuid not null references public.profiles(id),
  requested_by_name_snapshot text not null,
  created_at timestamptz not null default now()
);
revoke all on table private.profile_unlock_operations from public, anon, authenticated, service_role;

create table public.recount_batches (
  id uuid primary key default gen_random_uuid(),
  inventory_session_id uuid not null references public.inventory_sessions(id),
  status public.recount_batch_status not null default 'draft',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  version integer not null default 1 check (version > 0)
);
create index recount_batches_session_status_idx on public.recount_batches (inventory_session_id, status);
-- A session may retain historical active/reopened batches, but only one draft
-- may be refreshed by the manager at a time.
create unique index recount_batches_one_draft_per_session_idx
  on public.recount_batches (inventory_session_id)
  where status = 'draft';

create table public.recount_tasks (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recount_batches(id) on delete cascade,
  source_detail_row_id text not null,
  sku text not null,
  product_name text not null,
  stock_bin text,
  first_count_bin text,
  first_count_status text not null,
  first_counter_erp_name text,
  first_counter_name_snapshot text,
  assigned_user_id uuid references public.profiles(id),
  assigned_name_snapshot text,
  task_type public.recount_task_type not null,
  masked_reference text not null,
  state public.recount_task_state not null default 'unassigned',
  resolution public.recount_resolution,
  reason text,
  completed_by uuid references public.profiles(id),
  completed_by_name_snapshot text,
  completed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, source_detail_row_id)
);
create index recount_tasks_batch_assignee_state_idx on public.recount_tasks (batch_id, assigned_user_id, state);
-- Own-task queries may have no batch filter, so index the leading predicate too.
create index recount_tasks_assignee_idx on public.recount_tasks (assigned_user_id);
create index recount_tasks_batch_sku_idx on public.recount_tasks (batch_id, sku);
create index recount_tasks_batch_type_state_idx on public.recount_tasks (batch_id, task_type, state);

create table public.recount_task_secrets (
  task_id uuid primary key references public.recount_tasks(id) on delete cascade,
  expected_serial_normalized text,
  first_scanned_code_normalized text,
  first_scanned_code_masked text,
  created_at timestamptz not null default now()
);

create table public.recount_serial_evidence (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recount_batches(id) on delete cascade,
  source_detail_row_id text not null,
  sku text not null,
  serial_normalized text not null,
  bin text,
  is_counted boolean not null default true,
  is_excluded boolean not null default false,
  unique (batch_id, source_detail_row_id, serial_normalized)
);
create index recount_serial_evidence_lookup_idx
  on public.recount_serial_evidence (batch_id, serial_normalized)
  where is_excluded = false;

create table public.recount_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.recount_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  user_name_snapshot text not null,
  scanned_value_hash text,
  scanned_value_masked text,
  result public.recount_attempt_result not null,
  reason text,
  created_at timestamptz not null default now()
);
create index recount_attempts_task_created_idx on public.recount_attempts (task_id, created_at desc);

create table public.recount_code_resolutions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.recount_tasks(id) on delete cascade,
  resolution_type text not null,
  removed_source_detail_row_id text,
  confirmed_by uuid not null references public.profiles(id),
  confirmed_by_name_snapshot text not null,
  confirmed_at timestamptz not null default now()
);
create index recount_code_resolutions_task_idx on public.recount_code_resolutions (task_id);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id),
  actor_name_snapshot text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_created_idx on public.audit_logs (entity_type, entity_id, created_at desc);

create or replace function private.set_recount_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_recount_updated_at();
create trigger recount_tasks_updated_at before update on public.recount_tasks
  for each row execute function private.set_recount_updated_at();

create or replace function private.handle_registered_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- Pilot compatibility: only Auth-owned state may bypass named registration.
  if new.is_anonymous then
    return new;
  end if;
  -- Never trust user-editable role/status metadata.
  insert into public.profiles (id, email, full_name, erp_name, erp_name_normalized)
  values (
    new.id,
    lower(new.email),
    trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')),
    trim(coalesce(new.raw_user_meta_data ->> 'erp_name', '')),
    public.normalize_inventory_code(new.raw_user_meta_data ->> 'erp_name')
  );
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_registered_user();

create or replace function public.current_profile_role()
returns public.app_role
language sql stable security definer
set search_path = ''
as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.status = 'active';
$$;

create or replace function public.is_active_profile()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.status = 'active'
  );
$$;

-- Legacy JSON payloads contain complete serials. Only active managers/admins
-- may read or mutate them; counters and inactive/anonymous identities get no rows.
revoke all on table public.inventory_sessions from public, anon, authenticated;
revoke all on table public.monthly_archives from public, anon, authenticated;
grant select, insert, update, delete
  on public.inventory_sessions, public.monthly_archives to authenticated;
drop policy if exists inventory_sessions_active_managers on public.inventory_sessions;
create policy inventory_sessions_active_managers
on public.inventory_sessions
for all
to authenticated
using ((select public.current_profile_role()) in ('admin', 'manager'))
with check ((select public.current_profile_role()) in ('admin', 'manager'));
drop policy if exists monthly_archives_active_managers on public.monthly_archives;
create policy monthly_archives_active_managers
on public.monthly_archives
for all
to authenticated
using ((select public.current_profile_role()) in ('admin', 'manager'))
with check ((select public.current_profile_role()) in ('admin', 'manager'));

alter table public.profiles enable row level security;
alter table public.recount_batches enable row level security;
alter table public.recount_tasks enable row level security;
alter table public.recount_task_secrets enable row level security;
alter table public.recount_serial_evidence enable row level security;
alter table public.recount_attempts enable row level security;
alter table public.recount_code_resolutions enable row level security;
alter table public.audit_logs enable row level security;

-- Supabase may grant broad default privileges: revoke explicitly before allowlists.
revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.recount_batches from public, anon, authenticated;
revoke all on table public.recount_tasks from public, anon, authenticated;
revoke all on table public.recount_task_secrets from public, anon, authenticated;
revoke all on table public.recount_serial_evidence from public, anon, authenticated;
revoke all on table public.recount_attempts from public, anon, authenticated;
revoke all on table public.recount_code_resolutions from public, anon, authenticated;
revoke all on table public.audit_logs from public, anon, authenticated;
revoke all on sequence public.audit_logs_id_seq from public, anon, authenticated;
grant select on public.profiles, public.recount_batches, public.recount_tasks,
  public.recount_attempts, public.recount_code_resolutions, public.audit_logs to authenticated;

-- All writes go through later transactional, audited RPCs. No direct client DML.
create policy profiles_read on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or (select public.current_profile_role()) in ('admin', 'manager')
);
create policy recount_tasks_read on public.recount_tasks for select to authenticated
using (
  (select public.is_active_profile())
  and (
    assigned_user_id = (select auth.uid())
    or (select public.current_profile_role()) in ('admin', 'manager')
  )
);
create policy recount_batches_read on public.recount_batches for select to authenticated
using (
  (select public.is_active_profile())
  and (
    (select public.current_profile_role()) in ('admin', 'manager')
    or exists (
      select 1 from public.recount_tasks t
      where t.batch_id = recount_batches.id and t.assigned_user_id = (select auth.uid())
    )
  )
);
-- Attempt hashes and audit payloads are not part of the counter-facing contract.
create policy recount_attempts_manager_read on public.recount_attempts for select to authenticated
using ((select public.current_profile_role()) in ('admin', 'manager'));
create policy recount_code_resolutions_manager_read on public.recount_code_resolutions for select to authenticated
using ((select public.current_profile_role()) in ('admin', 'manager'));
create policy audit_logs_manager_read on public.audit_logs for select to authenticated
using ((select public.current_profile_role()) in ('admin', 'manager'));
-- No policies or client grants exist for secrets or evidence.

create or replace function private.bootstrap_initial_admin(p_user_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  -- Serialize concurrent bootstrap calls and profile approvals/promotions.
  lock table public.profiles in share row exclusive mode;
  if exists (select 1 from public.profiles where role = 'admin' and status = 'active') then
    raise exception 'An active admin already exists' using errcode = '23505';
  end if;
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Intended administrator must register first' using errcode = 'P0002';
  end if;
  if v_profile.status in ('locked', 'deleted') then
    raise exception 'Cannot bootstrap a locked or deleted profile' using errcode = '42501';
  end if;
  update public.profiles
  set role = 'admin', status = 'active', approved_by = p_user_id, approved_at = now()
  where id = p_user_id;
  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id, before_data, after_data
  ) values (
    p_user_id, v_profile.full_name, 'bootstrap_initial_admin', 'profile', p_user_id::text,
    jsonb_build_object('role', v_profile.role, 'status', v_profile.status),
    jsonb_build_object('role', 'admin', 'status', 'active')
  );
end;
$$;

create or replace function public.manager_approve_profile(p_user_id uuid, p_erp_name text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_erp_name text := trim(coalesce(p_erp_name, ''));
  v_erp_name_normalized text := public.normalize_inventory_code(p_erp_name);
begin
  lock table public.profiles in share row exclusive mode;
  select * into v_actor from public.profiles where id = (select auth.uid()) for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Target profile not found' using errcode = 'P0002';
  end if;
  if v_target.role = 'admin' or (v_actor.role = 'manager' and v_target.role <> 'counter') then
    raise exception 'Caller cannot manage this profile role' using errcode = '42501';
  end if;
  if v_target.status <> 'pending' then
    raise exception 'Only pending profiles can be approved' using errcode = '55000';
  end if;
  if v_erp_name = '' or v_erp_name_normalized = '' then
    raise exception 'ERP alias is required' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.profiles p
    where p.id <> p_user_id
      and p.status <> 'deleted'
      and p.erp_name_normalized = v_erp_name_normalized
  ) then
    raise exception 'ERP alias is already assigned' using errcode = '23505';
  end if;

  update public.profiles
  set erp_name = v_erp_name,
      erp_name_normalized = v_erp_name_normalized,
      status = 'active',
      approved_by = v_actor.id,
      approved_at = now(),
      locked_at = null,
      deleted_at = null
  where id = p_user_id;

  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id, before_data, after_data
  ) values (
    v_actor.id, v_actor.full_name, 'approve_profile', 'profile', p_user_id::text,
    jsonb_build_object('role', v_target.role, 'status', v_target.status, 'erp_name', v_target.erp_name),
    jsonb_build_object('role', v_target.role, 'status', 'active', 'erp_name', v_erp_name)
  );
  return jsonb_build_object('user_id', p_user_id, 'status', 'active', 'erp_name', v_erp_name);
end;
$$;

create or replace function public.manager_lock_profile(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_unassigned integer := 0;
begin
  select * into v_actor from public.profiles where id = (select auth.uid()) for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Target profile not found' using errcode = 'P0002';
  end if;
  if v_target.role = 'admin' or (v_actor.role = 'manager' and v_target.role <> 'counter') then
    raise exception 'Caller cannot manage this profile role' using errcode = '42501';
  end if;
  if v_target.status <> 'active' then
    raise exception 'Only active profiles can be locked' using errcode = '55000';
  end if;
  if v_reason = '' then
    raise exception 'Lock reason is required' using errcode = '22023';
  end if;

  update public.profiles set status = 'locked', locked_at = now() where id = p_user_id;
  update public.recount_tasks
  set assigned_user_id = null,
      assigned_name_snapshot = null,
      state = 'unassigned',
      resolution = null,
      reason = null,
      completed_by = null,
      completed_by_name_snapshot = null,
      completed_at = null,
      version = version + 1
  where assigned_user_id = p_user_id and state <> 'completed';
  get diagnostics v_unassigned = row_count;

  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id, before_data, after_data, reason
  ) values (
    v_actor.id, v_actor.full_name, 'lock_profile', 'profile', p_user_id::text,
    jsonb_build_object('role', v_target.role, 'status', v_target.status),
    jsonb_build_object('role', v_target.role, 'status', 'locked', 'unassigned_tasks', v_unassigned),
    v_reason
  );
  return jsonb_build_object('user_id', p_user_id, 'status', 'locked', 'unassigned_tasks', v_unassigned);
end;
$$;

create or replace function public.manager_begin_profile_unlock(p_user_id uuid, p_operation_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_existing private.profile_unlock_operations%rowtype;
begin
  select * into v_actor from public.profiles where id = (select auth.uid()) for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Target profile not found' using errcode = 'P0002';
  end if;
  if v_target.role = 'admin' or (v_actor.role = 'manager' and v_target.role <> 'counter') then
    raise exception 'Caller cannot manage this profile role' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'Unlock operation ID is required' using errcode = '22023';
  end if;
  if v_target.status = 'active' then
    return jsonb_build_object(
      'user_id', p_user_id, 'status', 'active', 'outcome', 'already_active', 'owns_transition', false
    );
  end if;
  if v_target.status <> 'locked' then
    return jsonb_build_object(
      'user_id', p_user_id, 'status', v_target.status, 'outcome', 'rejected', 'owns_transition', false
    );
  end if;

  select * into v_existing
  from private.profile_unlock_operations
  where target_user_id = p_user_id
  for update;
  if found then
    if v_existing.operation_id = p_operation_id then
      if v_existing.requested_by <> v_actor.id then
        raise exception 'Unlock operation belongs to another manager' using errcode = '42501';
      end if;
      return jsonb_build_object(
        'user_id', p_user_id, 'operation_id', p_operation_id, 'requested_by', v_existing.requested_by,
        'status', 'locked', 'outcome', 'acquired', 'owns_transition', true
      );
    end if;
    return jsonb_build_object(
      'user_id', p_user_id, 'operation_id', v_existing.operation_id, 'requested_by', v_existing.requested_by,
      'status', 'locked', 'outcome', 'in_progress', 'owns_transition', false
    );
  end if;

  insert into private.profile_unlock_operations (
    operation_id, target_user_id, requested_by, requested_by_name_snapshot
  ) values (
    p_operation_id, p_user_id, v_actor.id, v_actor.full_name
  );
  return jsonb_build_object(
    'user_id', p_user_id, 'operation_id', p_operation_id, 'requested_by', v_actor.id,
    'status', 'locked', 'outcome', 'acquired', 'owns_transition', true
  );
end;
$$;

-- Reconcile an ambiguous manager begin response using the exact operation ID.
-- This remains service-role-only; the Edge Function checks the operation owner
-- against the already verified manager JWT before touching Auth.
create or replace function public.service_reconcile_profile_unlock(
  p_user_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
  v_operation private.profile_unlock_operations%rowtype;
begin
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object(
      'user_id', p_user_id, 'operation_id', p_operation_id, 'status', null,
      'outcome', 'not_found', 'owns_transition', false
    );
  end if;

  select * into v_operation
  from private.profile_unlock_operations
  where operation_id = p_operation_id and target_user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'user_id', p_user_id, 'operation_id', p_operation_id, 'status', v_target.status,
      'outcome', 'not_found', 'owns_transition', false
    );
  end if;
  if v_target.status = 'active' then
    delete from private.profile_unlock_operations where operation_id = p_operation_id;
    return jsonb_build_object(
      'user_id', p_user_id, 'operation_id', p_operation_id, 'requested_by', v_operation.requested_by,
      'status', 'active', 'outcome', 'already_active', 'owns_transition', false
    );
  end if;
  if v_target.status <> 'locked' then
    delete from private.profile_unlock_operations where operation_id = p_operation_id;
    return jsonb_build_object(
      'user_id', p_user_id, 'operation_id', p_operation_id, 'requested_by', v_operation.requested_by,
      'status', v_target.status, 'outcome', 'superseded', 'owns_transition', false
    );
  end if;
  return jsonb_build_object(
    'user_id', p_user_id, 'operation_id', p_operation_id, 'requested_by', v_operation.requested_by,
    'status', 'locked', 'outcome', 'acquired', 'owns_transition', true
  );
end;
$$;

create or replace function public.service_finish_profile_unlock(
  p_user_id uuid,
  p_operation_id uuid,
  p_succeeded boolean
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
  v_operation private.profile_unlock_operations%rowtype;
  v_unassigned integer := 0;
begin
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object(
      'user_id', p_user_id, 'status', null, 'outcome', 'not_found', 'owns_transition', false
    );
  end if;

  select * into v_operation
  from private.profile_unlock_operations
  where operation_id = p_operation_id
    and target_user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'user_id', p_user_id,
      'status', v_target.status,
      'outcome', case when v_target.status = 'active' then 'already_active' else 'superseded' end,
      'owns_transition', false
    );
  end if;

  if p_succeeded is not true then
    -- Keep the operation lease until Auth has been re-banned. This closes the
    -- gap where a new unlock could unban Auth while the failed request was
    -- still compensating its own unban.
    if v_target.status = 'active' then
      update public.profiles
      set status = 'locked', locked_at = coalesce(locked_at, now())
      where id = p_user_id;
      update public.recount_tasks
      set assigned_user_id = null,
          assigned_name_snapshot = null,
          state = 'unassigned',
          resolution = null,
          reason = null,
          completed_by = null,
          completed_by_name_snapshot = null,
          completed_at = null,
          version = version + 1
      where assigned_user_id = p_user_id and state <> 'completed';
      get diagnostics v_unassigned = row_count;
      insert into public.audit_logs (
        actor_user_id, actor_name_snapshot, action, entity_type, entity_id, before_data, after_data, reason
      ) values (
        v_operation.requested_by, v_operation.requested_by_name_snapshot, 'lock_profile', 'profile', p_user_id::text,
        jsonb_build_object('role', v_target.role, 'status', 'active'),
        jsonb_build_object('role', v_target.role, 'status', 'locked', 'unassigned_tasks', v_unassigned),
        'Auth unlock failed; restored lock'
      );
    elsif v_target.status <> 'locked' then
      return jsonb_build_object(
        'user_id', p_user_id,
        'status', v_target.status,
        'outcome', 'superseded',
        'owns_transition', false
      );
    end if;
    return jsonb_build_object(
      'user_id', p_user_id, 'status', 'locked', 'outcome', 'recovery_pending', 'owns_transition', true
    );
  end if;

  if v_target.status <> 'locked' then
    delete from private.profile_unlock_operations where operation_id = p_operation_id;
    return jsonb_build_object(
      'user_id', p_user_id,
      'status', v_target.status,
      'outcome', case when v_target.status = 'active' then 'already_active' else 'superseded' end,
      'owns_transition', false
    );
  end if;

  update public.profiles set status = 'active', locked_at = null where id = p_user_id;
  delete from private.profile_unlock_operations where operation_id = p_operation_id;
  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id, before_data, after_data
  ) values (
    v_operation.requested_by, v_operation.requested_by_name_snapshot, 'unlock_profile', 'profile', p_user_id::text,
    jsonb_build_object('role', v_target.role, 'status', v_target.status),
    jsonb_build_object('role', v_target.role, 'status', 'active')
  );
  return jsonb_build_object(
    'user_id', p_user_id, 'status', 'active', 'outcome', 'activated', 'owns_transition', true
  );
end;
$$;

create or replace function public.service_release_profile_unlock(
  p_user_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
  v_operation private.profile_unlock_operations%rowtype;
begin
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('user_id', p_user_id, 'outcome', 'not_found', 'owns_transition', false);
  end if;
  select * into v_operation
  from private.profile_unlock_operations
  where operation_id = p_operation_id and target_user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object(
      'user_id', p_user_id, 'status', v_target.status, 'outcome', 'already_released', 'owns_transition', false
    );
  end if;
  delete from private.profile_unlock_operations
  where operation_id = p_operation_id and target_user_id = p_user_id;
  return jsonb_build_object(
    'user_id', p_user_id, 'status', v_target.status, 'outcome', 'released', 'owns_transition', true
  );
end;
$$;

create or replace function public.manager_delete_profile(p_user_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_unassigned integer := 0;
begin
  select * into v_actor from public.profiles where id = (select auth.uid()) for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'Target profile not found' using errcode = 'P0002';
  end if;
  if v_target.role = 'admin' or (v_actor.role = 'manager' and v_target.role <> 'counter') then
    raise exception 'Caller cannot manage this profile role' using errcode = '42501';
  end if;
  delete from private.profile_unlock_operations where target_user_id = p_user_id;
  if v_target.status = 'deleted' then
    return jsonb_build_object('user_id', p_user_id, 'status', 'deleted', 'already_deleted', true);
  end if;

  update public.profiles
  set status = 'deleted', deleted_at = now(), locked_at = coalesce(locked_at, now())
  where id = p_user_id;
  update public.recount_tasks
  set assigned_user_id = null,
      assigned_name_snapshot = null,
      state = 'unassigned',
      resolution = null,
      reason = null,
      completed_by = null,
      completed_by_name_snapshot = null,
      completed_at = null,
      version = version + 1
  where assigned_user_id = p_user_id and state <> 'completed';
  get diagnostics v_unassigned = row_count;

  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id, before_data, after_data
  ) values (
    v_actor.id, v_actor.full_name, 'delete_profile', 'profile', p_user_id::text,
    jsonb_build_object('role', v_target.role, 'status', v_target.status),
    jsonb_build_object('role', v_target.role, 'status', 'deleted', 'unassigned_tasks', v_unassigned)
  );
  return jsonb_build_object('user_id', p_user_id, 'status', 'deleted', 'unassigned_tasks', v_unassigned);
end;
$$;

revoke all on function public.normalize_inventory_code(text) from public, anon, authenticated;
revoke all on function public.mask_inventory_code(text, integer, integer) from public, anon, authenticated;
revoke all on function public.current_profile_role() from public, anon, authenticated;
revoke all on function public.is_active_profile() from public, anon, authenticated;
revoke all on function private.handle_registered_user() from public, anon, authenticated;
revoke all on function private.set_recount_updated_at() from public, anon, authenticated;
revoke all on function private.bootstrap_initial_admin(uuid) from public, anon, authenticated;
revoke all on function public.manager_approve_profile(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_lock_profile(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_begin_profile_unlock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_reconcile_profile_unlock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_finish_profile_unlock(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.service_release_profile_unlock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.manager_delete_profile(uuid) from public, anon, authenticated;
grant execute on function public.normalize_inventory_code(text) to authenticated;
grant execute on function public.mask_inventory_code(text, integer, integer) to authenticated;
grant execute on function public.current_profile_role() to authenticated;
grant execute on function public.is_active_profile() to authenticated;
grant execute on function public.manager_approve_profile(uuid, text) to authenticated;
grant execute on function public.manager_lock_profile(uuid, text) to authenticated;
grant execute on function public.manager_begin_profile_unlock(uuid, uuid) to authenticated;
grant execute on function public.service_reconcile_profile_unlock(uuid, uuid) to service_role;
grant execute on function public.service_finish_profile_unlock(uuid, uuid, boolean) to service_role;
grant execute on function public.service_release_profile_unlock(uuid, uuid) to service_role;
grant execute on function public.manager_delete_profile(uuid) to authenticated;
-- Bootstrap is SQL-Editor/operator-only. Never expose private through the Data API.

-- ============================================================
-- Task 6: secure recount batch generation and manager workspace
-- ============================================================

create or replace function public.manager_create_recount_batch(
  p_inventory_session_id uuid,
  p_tasks jsonb,
  p_evidence jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_batch public.recount_batches%rowtype;
  v_task jsonb;
  v_evidence jsonb;
  v_source_id text;
  v_sku text;
  v_product_name text;
  v_stock_bin text;
  v_first_count_bin text;
  v_first_count_status text;
  v_first_counter_erp_name text;
  v_task_type public.recount_task_type;
  v_profile public.profiles%rowtype;
  v_task_id uuid;
  v_reference text;
  v_suffix text;
  v_mask_start integer;
  v_task_count integer := 0;
  v_unassigned_count integer := 0;
  v_in_progress_count integer := 0;
  v_completed_count integer := 0;
  v_has_assignee boolean := false;
begin
  select * into v_actor
  from public.profiles
  where id = (select auth.uid())
  for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  if p_inventory_session_id is null then
    raise exception 'Inventory session is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_tasks, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) <> 'array' then
    raise exception 'Tasks and evidence must be JSON arrays' using errcode = '22023';
  end if;
  if not exists (select 1 from public.inventory_sessions where id = p_inventory_session_id) then
    raise exception 'Inventory session not found' using errcode = 'P0002';
  end if;

  select * into v_batch
  from public.recount_batches
  where inventory_session_id = p_inventory_session_id
    and status = 'draft'
  for update;
  if not found then
    insert into public.recount_batches (inventory_session_id, status, created_by)
    values (p_inventory_session_id, 'draft', v_actor.id)
    returning * into v_batch;
  else
    update public.recount_batches
    set version = version + 1
    where id = v_batch.id
    returning * into v_batch;
  end if;

  -- Validate all task identity/enum values before writing any row. Complete
  -- serials are accepted only in the protected evidence argument, never in
  -- the manager-safe task payload.
  for v_task in select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) loop
    if v_task ? 'expected_serial' or v_task ? 'expected_serial_normalized'
       or v_task ? 'stock_serial' or v_task ? 'first_scanned_code_normalized' then
      raise exception 'Complete serial fields are not allowed in task payload' using errcode = '22023';
    end if;
    v_source_id := trim(coalesce(v_task ->> 'source_detail_row_id', ''));
    if v_source_id = '' then
      raise exception 'Every recount task requires a source detail row ID' using errcode = '22023';
    end if;
    v_task_type := (v_task ->> 'task_type')::public.recount_task_type;
  end loop;

  for v_task in select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) loop
    v_source_id := trim(v_task ->> 'source_detail_row_id');
    v_sku := trim(coalesce(v_task ->> 'sku', ''));
    v_product_name := trim(coalesce(v_task ->> 'product_name', ''));
    v_stock_bin := nullif(trim(coalesce(v_task ->> 'stock_bin', '')), '');
    v_first_count_bin := nullif(trim(coalesce(v_task ->> 'first_count_bin', '')), '');
    v_first_count_status := trim(coalesce(v_task ->> 'first_count_status', ''));
    v_first_counter_erp_name := trim(coalesce(v_task ->> 'first_counter_erp_name', ''));
    v_task_type := (v_task ->> 'task_type')::public.recount_task_type;
    if v_sku = '' or v_product_name = '' or v_first_count_status = '' then
      raise exception 'SKU, product name and first-count status are required' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) e
      where length(public.normalize_inventory_code(e.value ->> 'serial_normalized')) >= 4
        and (public.normalize_inventory_code(v_sku) like '%' || public.normalize_inventory_code(coalesce(e.value ->> 'serial_normalized', '')) || '%'
          or public.normalize_inventory_code(v_product_name) like '%' || public.normalize_inventory_code(coalesce(e.value ->> 'serial_normalized', '')) || '%'
          or public.normalize_inventory_code(coalesce(v_stock_bin, '')) like '%' || public.normalize_inventory_code(coalesce(e.value ->> 'serial_normalized', '')) || '%'
          or public.normalize_inventory_code(coalesce(v_first_count_bin, '')) like '%' || public.normalize_inventory_code(coalesce(e.value ->> 'serial_normalized', '')) || '%'
          or public.normalize_inventory_code(v_first_count_status) like '%' || public.normalize_inventory_code(coalesce(e.value ->> 'serial_normalized', '')) || '%'
          or public.normalize_inventory_code(v_first_counter_erp_name) like '%' || public.normalize_inventory_code(coalesce(e.value ->> 'serial_normalized', '')) || '%'
          or (length(public.normalize_inventory_code(coalesce(e.value ->> 'expected_serial_normalized', ''))) >= 4 and public.normalize_inventory_code(v_sku) like '%' || public.normalize_inventory_code(e.value ->> 'expected_serial_normalized') || '%')
          or (length(public.normalize_inventory_code(coalesce(e.value ->> 'first_scanned_code_normalized', ''))) >= 4 and public.normalize_inventory_code(v_product_name) like '%' || public.normalize_inventory_code(e.value ->> 'first_scanned_code_normalized') || '%'))
    ) then
      raise exception 'Task display fields cannot contain protected serial codes' using errcode = '22023';
    end if;

    select * into v_profile
    from public.profiles
    where status = 'active'
      and role = 'counter'
      and erp_name_normalized = public.normalize_inventory_code(v_first_counter_erp_name)
    order by id
    limit 1;
    v_has_assignee := found;

    insert into public.recount_tasks (
      batch_id, source_detail_row_id, sku, product_name, stock_bin,
      first_count_bin, first_count_status, first_counter_erp_name,
      first_counter_name_snapshot, assigned_user_id, assigned_name_snapshot,
      task_type, masked_reference, state
    ) values (
      v_batch.id, v_source_id, v_sku, v_product_name, v_stock_bin,
      v_first_count_bin, v_first_count_status, nullif(v_first_counter_erp_name, ''),
      case when v_has_assignee then v_profile.full_name else null end,
      case when v_has_assignee then v_profile.id else null end,
      case when v_has_assignee then v_profile.full_name else null end,
      v_task_type, '*',
      (case when v_has_assignee then 'assigned' else 'unassigned' end)::public.recount_task_state
    )
    on conflict (batch_id, source_detail_row_id) do update
    set sku = excluded.sku,
        product_name = excluded.product_name,
        stock_bin = excluded.stock_bin,
        first_count_bin = excluded.first_count_bin,
        first_count_status = excluded.first_count_status,
        first_counter_erp_name = excluded.first_counter_erp_name,
        first_counter_name_snapshot = excluded.first_counter_name_snapshot,
        task_type = excluded.task_type,
        assigned_user_id = case when public.recount_tasks.state in ('completed', 'in_progress', 'ready')
                                then public.recount_tasks.assigned_user_id else excluded.assigned_user_id end,
        assigned_name_snapshot = case when public.recount_tasks.state in ('completed', 'in_progress', 'ready')
                                      then public.recount_tasks.assigned_name_snapshot else excluded.assigned_name_snapshot end,
        state = case when public.recount_tasks.state in ('completed', 'in_progress', 'ready')
                     then public.recount_tasks.state else excluded.state end,
        resolution = case when public.recount_tasks.state in ('completed', 'in_progress', 'ready')
                          then public.recount_tasks.resolution else null end,
        reason = case when public.recount_tasks.state in ('completed', 'in_progress', 'ready')
                      then public.recount_tasks.reason else null end,
        version = public.recount_tasks.version + 1
    returning id into v_task_id;
    v_task_count := v_task_count + 1;

    -- One task may have expected and first-scanned evidence rows. Exact codes
    -- never leave this protected table through the RPC return value.
    for v_evidence in
      select value
      from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb))
      where trim(coalesce(value ->> 'source_detail_row_id', '')) = v_source_id
    loop
      if trim(coalesce(v_evidence ->> 'serial_normalized', '')) = '' then
        raise exception 'Evidence serial cannot be empty' using errcode = '22023';
      end if;
      insert into public.recount_serial_evidence (
        batch_id, source_detail_row_id, sku, serial_normalized, bin,
        is_counted, is_excluded
      ) values (
        v_batch.id, v_source_id, trim(coalesce(v_evidence ->> 'sku', v_sku)),
        public.normalize_inventory_code(v_evidence ->> 'serial_normalized'),
        nullif(trim(coalesce(v_evidence ->> 'bin', '')), ''),
        coalesce((v_evidence ->> 'is_counted')::boolean, true),
        coalesce((v_evidence ->> 'is_excluded')::boolean, false)
      )
      on conflict (batch_id, source_detail_row_id, serial_normalized) do update
      set sku = excluded.sku,
          bin = excluded.bin,
          is_counted = excluded.is_counted,
          is_excluded = excluded.is_excluded;

      insert into public.recount_task_secrets (
        task_id, expected_serial_normalized, first_scanned_code_normalized,
        first_scanned_code_masked
      ) values (
        v_task_id,
        nullif(public.normalize_inventory_code(v_evidence ->> 'expected_serial_normalized'), ''),
        nullif(public.normalize_inventory_code(v_evidence ->> 'first_scanned_code_normalized'), ''),
        nullif(trim(coalesce(v_evidence ->> 'first_scanned_code_masked', '')), '')
      )
      on conflict (task_id) do update
      set expected_serial_normalized = coalesce(excluded.expected_serial_normalized, public.recount_task_secrets.expected_serial_normalized),
          first_scanned_code_normalized = coalesce(excluded.first_scanned_code_normalized, public.recount_task_secrets.first_scanned_code_normalized),
          first_scanned_code_masked = coalesce(excluded.first_scanned_code_masked, public.recount_task_secrets.first_scanned_code_masked);
    end loop;
  end loop;

  delete from public.recount_tasks t
  where t.batch_id = v_batch.id
    and t.state in ('unassigned', 'assigned', 'reopened')
    and not exists (
      select 1 from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) x
      where trim(coalesce(x.value ->> 'source_detail_row_id', '')) = t.source_detail_row_id
    );

  delete from public.recount_serial_evidence e
  where e.batch_id = v_batch.id
    and (not exists (
      select 1 from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) x
      where trim(coalesce(x.value ->> 'source_detail_row_id', '')) = e.source_detail_row_id
    ) or not exists (
      select 1 from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) x
      where trim(coalesce(x.value ->> 'source_detail_row_id', '')) = e.source_detail_row_id
        and public.normalize_inventory_code(x.value ->> 'serial_normalized') = e.serial_normalized
    ));

  -- Compute the final-four mask server-side. A colliding suffix gets the first
  -- differing four-character window; groups containing a short code remain
  -- fully masked so a complete short secret cannot be inferred.
  with refs as (
    select t.id, t.sku, coalesce(s.expected_serial_normalized, s.first_scanned_code_normalized) as reference
    from public.recount_tasks t
    left join public.recount_task_secrets s on s.task_id = t.id
    where t.batch_id = v_batch.id
  ), groups as (
    select sku, reference,
           right(reference, 4) as suffix,
           char_length(reference) as reference_length
    from refs
    where reference is not null and reference <> ''
  ), collision_windows as (
    select r.id, min(pos) as first_difference
    from refs r
    join lateral generate_series(1, greatest(char_length(r.reference), 1)) as positions(pos) on true
    where r.reference is not null and r.reference <> ''
      and (select count(*) from groups g where g.sku = r.sku and g.suffix = right(r.reference, 4)) > 1
      and not exists (
        select 1 from groups g where g.sku = r.sku and g.suffix = right(r.reference, 4) and g.reference_length <= 4
      )
      and (select count(distinct substr(g.reference, pos, 1))
           from groups g where g.sku = r.sku and g.suffix = right(r.reference, 4)) > 1
    group by r.id
  )
  update public.recount_tasks t
  set masked_reference = case
    when refs.reference is null or refs.reference = '' then '*'
    when char_length(refs.reference) <= 4 then repeat('*', char_length(refs.reference))
    when not exists (select 1 from groups g where g.sku = refs.sku and g.suffix = right(refs.reference, 4) and g.reference_length <= 4)
         and (select count(*) from groups g where g.sku = refs.sku and g.suffix = right(refs.reference, 4)) > 1
      then public.mask_inventory_code(refs.reference, collision_windows.first_difference, 4)
    else public.mask_inventory_code(refs.reference, null, 4)
  end
  from refs
  left join collision_windows on collision_windows.id = refs.id
  where t.id = refs.id;

  select count(*) filter (where state = 'unassigned'),
         count(*) filter (where state = 'in_progress'),
         count(*) filter (where state = 'completed')
  into v_unassigned_count, v_in_progress_count, v_completed_count
  from public.recount_tasks where batch_id = v_batch.id;

  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id,
    after_data
  ) values (
    v_actor.id, v_actor.full_name, 'create_recount_batch', 'recount_batch',
    v_batch.id::text,
    jsonb_build_object('inventory_session_id', p_inventory_session_id,
                       'task_count', v_task_count,
                       'unassigned_count', v_unassigned_count)
  );

  return jsonb_build_object(
    'batch_id', v_batch.id,
    'task_count', (select count(*) from public.recount_tasks where batch_id = v_batch.id),
    'unassigned_count', v_unassigned_count,
    'in_progress_count', v_in_progress_count,
    'completed_count', v_completed_count
  );
end;
$$;

create or replace function public.manager_bulk_assign_recount_tasks(
  p_task_ids uuid[],
  p_user_id uuid
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_task public.recount_tasks%rowtype;
  v_count integer := 0;
begin
  select * into v_actor from public.profiles where id = (select auth.uid()) for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  if coalesce(array_length(p_task_ids, 1), 0) = 0
     or (select count(*) from unnest(p_task_ids)) <> (select count(distinct id) from unnest(p_task_ids) id) then
    raise exception 'Task IDs must be non-empty and unique' using errcode = '22023';
  end if;
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'At most 500 tasks may be assigned per call' using errcode = '22023';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found or v_target.status <> 'active' or v_target.role <> 'counter' then
    raise exception 'Target must be an active approved counter' using errcode = '42501';
  end if;
  if (select count(*) from public.recount_tasks where id = any(p_task_ids)) <> array_length(p_task_ids, 1) then
    raise exception 'Every task ID must belong to an existing recount task' using errcode = 'P0002';
  end if;
  if (select count(distinct batch_id) from public.recount_tasks where id = any(p_task_ids)) <> 1 then
    raise exception 'All assigned tasks must belong to one batch' using errcode = '22023';
  end if;

  for v_task in
    select * from public.recount_tasks where id = any(p_task_ids) order by id for update
  loop
    if v_task.state = 'completed' then
      raise exception 'Completed tasks must be reopened before reassignment' using errcode = '55000';
    end if;
    update public.recount_tasks
    set assigned_user_id = v_target.id,
        assigned_name_snapshot = v_target.full_name,
        state = 'assigned', resolution = null, reason = null,
        completed_by = null, completed_by_name_snapshot = null,
        completed_at = null, version = version + 1
    where id = v_task.id;
    insert into public.audit_logs (
      actor_user_id, actor_name_snapshot, action, entity_type, entity_id,
      before_data, after_data
    ) values (
      v_actor.id, v_actor.full_name, 'assign_recount_task', 'recount_task', v_task.id::text,
      jsonb_build_object('assigned_user_id', v_task.assigned_user_id, 'state', v_task.state, 'version', v_task.version),
      jsonb_build_object('assigned_user_id', v_target.id, 'assigned_name_snapshot', v_target.full_name,
                         'state', 'assigned', 'version', v_task.version + 1)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.manager_list_recount_tasks(
  p_batch_id uuid,
  p_page integer default 1,
  p_page_size integer default 50,
  p_assignee_id uuid default null,
  p_state public.recount_task_state default null,
  p_task_type public.recount_task_type default null,
  p_sku text default null,
  p_bin text default null
)
returns table (
  id uuid, batch_id uuid, source_detail_row_id text, sku text,
  product_name text, stock_bin text, first_count_bin text,
  first_count_status text, first_counter_erp_name text,
  first_counter_name_snapshot text, assigned_user_id uuid,
  assigned_name_snapshot text, task_type public.recount_task_type,
  masked_reference text, state public.recount_task_state,
  resolution public.recount_resolution, reason text, version integer,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_page_size, 50), 500));
  v_page integer := greatest(1, coalesce(p_page, 1));
begin
  select * into v_actor from public.profiles p where p.id = (select auth.uid());
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  return query
  select t.id, t.batch_id, t.source_detail_row_id, t.sku, t.product_name,
         t.stock_bin, t.first_count_bin, t.first_count_status,
         t.first_counter_erp_name, t.first_counter_name_snapshot,
         t.assigned_user_id, t.assigned_name_snapshot, t.task_type,
         t.masked_reference, t.state, t.resolution, t.reason, t.version,
         t.created_at, t.updated_at
  from public.recount_tasks t
  where t.batch_id = p_batch_id
    and (p_assignee_id is null or t.assigned_user_id = p_assignee_id)
    and (p_state is null or t.state = p_state)
    and (p_task_type is null or t.task_type = p_task_type)
    and (p_sku is null or t.sku ilike '%' || p_sku || '%')
    and (p_bin is null or coalesce(t.stock_bin, '') ilike '%' || p_bin || '%'
                     or coalesce(t.first_count_bin, '') ilike '%' || p_bin || '%')
  order by t.created_at, t.id
  offset (v_page - 1) * v_limit limit v_limit;
end;
$$;

create or replace function public.manager_reopen_recount_tasks(
  p_task_ids uuid[],
  p_reason text
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_task public.recount_tasks%rowtype;
  v_assignee public.profiles%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_count integer := 0;
  v_has_assignee boolean := false;
begin
  select * into v_actor from public.profiles where id = (select auth.uid()) for update;
  if not found or v_actor.status <> 'active' or v_actor.role not in ('manager', 'admin') then
    raise exception 'Active manager or admin profile required' using errcode = '42501';
  end if;
  if v_reason = '' then
    raise exception 'Reopen reason is required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_task_ids, 1), 0) = 0
     or (select count(*) from unnest(p_task_ids)) <> (select count(distinct id) from unnest(p_task_ids) id) then
    raise exception 'Task IDs must be non-empty and unique' using errcode = '22023';
  end if;
  if (select count(*) from public.recount_tasks where id = any(p_task_ids)) <> array_length(p_task_ids, 1) then
    raise exception 'Every task ID must belong to an existing recount task' using errcode = 'P0002';
  end if;
  if (select count(distinct batch_id) from public.recount_tasks where id = any(p_task_ids)) <> 1 then
    raise exception 'All reopened tasks must belong to one batch' using errcode = '22023';
  end if;

  for v_task in
    select * from public.recount_tasks where id = any(p_task_ids) order by id for update
  loop
    if v_task.state <> 'completed' then
      raise exception 'Only completed tasks can be reopened' using errcode = '55000';
    end if;
    select * into v_assignee from public.profiles where id = v_task.assigned_user_id;
    v_has_assignee := found;
    update public.recount_tasks
    set assigned_user_id = case when v_has_assignee and v_assignee.status = 'active' and v_assignee.role = 'counter' then v_assignee.id else null end,
        assigned_name_snapshot = case when v_has_assignee and v_assignee.status = 'active' and v_assignee.role = 'counter' then v_assignee.full_name else null end,
        state = (case when v_has_assignee and v_assignee.status = 'active' and v_assignee.role = 'counter' then 'assigned' else 'unassigned' end)::public.recount_task_state,
        resolution = null, reason = null, completed_by = null,
        completed_by_name_snapshot = null, completed_at = null,
        version = version + 1
    where id = v_task.id;
    insert into public.audit_logs (
      actor_user_id, actor_name_snapshot, action, entity_type, entity_id,
      before_data, after_data, reason
    ) values (
      v_actor.id, v_actor.full_name, 'reopen_recount_task', 'recount_task', v_task.id::text,
      jsonb_build_object('state', v_task.state, 'resolution', v_task.resolution,
                         'assigned_user_id', v_task.assigned_user_id, 'version', v_task.version),
      jsonb_build_object('state', case when v_has_assignee and v_assignee.status = 'active' and v_assignee.role = 'counter' then 'assigned' else 'unassigned' end,
                         'assigned_user_id', case when v_has_assignee and v_assignee.status = 'active' and v_assignee.role = 'counter' then v_assignee.id else null end,
                         'version', v_task.version + 1),
      v_reason
    );
    v_count := v_count + 1;
  end loop;
  update public.recount_batches set status = 'reopened' where id = v_task.batch_id;
  return v_count;
end;
$$;

revoke all on function public.manager_create_recount_batch(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.manager_bulk_assign_recount_tasks(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.manager_list_recount_tasks(uuid, integer, integer, uuid, public.recount_task_state, public.recount_task_type, text, text) from public, anon, authenticated;
revoke all on function public.manager_reopen_recount_tasks(uuid[], text) from public, anon, authenticated;
grant execute on function public.manager_create_recount_batch(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.manager_bulk_assign_recount_tasks(uuid[], uuid) to authenticated;
grant execute on function public.manager_list_recount_tasks(uuid, integer, integer, uuid, public.recount_task_state, public.recount_task_type, text, text) to authenticated;
grant execute on function public.manager_reopen_recount_tasks(uuid[], text) to authenticated;

-- Counter-facing read/write contract.  Counters never query the protected
-- evidence/secrets tables directly: this RPC returns only the masked task
-- projection and the submit RPC records the scan without returning secrets.
create or replace function public.counter_list_recount_tasks(
  p_batch_id uuid default null,
  p_state public.recount_task_state default null
)
returns table (
  id uuid, batch_id uuid, sku text, product_name text, stock_bin text,
  first_count_bin text, first_count_status text,
  first_counter_name_snapshot text, task_type public.recount_task_type,
  masked_reference text, state public.recount_task_state,
  resolution public.recount_resolution, reason text, version integer,
  updated_at timestamptz
)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
begin
  select * into v_actor
  from public.profiles p
  where p.id = (select auth.uid());
  if not found or v_actor.status <> 'active' or v_actor.role <> 'counter' then
    raise exception 'Active counter profile required' using errcode = '42501';
  end if;
  return query
  select t.id, t.batch_id, t.sku, t.product_name, t.stock_bin,
         t.first_count_bin, t.first_count_status,
         t.first_counter_name_snapshot, t.task_type, t.masked_reference,
         t.state, t.resolution, t.reason, t.version, t.updated_at
  from public.recount_tasks t
  where t.assigned_user_id = v_actor.id
    and (p_batch_id is null or t.batch_id = p_batch_id)
    and (p_state is null or t.state = p_state)
  order by t.updated_at desc, t.id;
end;
$$;

-- Record one scan for an assigned task.  Exact serials are compared only in
-- this security-definer transaction and are never returned to the counter.
-- A scan already present in first-count evidence is reported as duplicate;
-- only a verified expected serial (or a confirmed surplus re-scan) completes
-- the task.  The version check makes retries harmless for a completed task.
create or replace function public.counter_submit_recount_attempt(
  p_task_id uuid,
  p_scanned_value text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_task public.recount_tasks%rowtype;
  v_secret public.recount_task_secrets%rowtype;
  v_scan text := public.normalize_inventory_code(p_scanned_value);
  v_result public.recount_attempt_result;
  v_resolution public.recount_resolution;
  v_state public.recount_task_state;
  v_masked text;
  v_hash text;
  v_same_batch boolean := false;
begin
  select * into v_actor
  from public.profiles p
  where p.id = (select auth.uid());
  if not found or v_actor.status <> 'active' or v_actor.role <> 'counter' then
    raise exception 'Active counter profile required' using errcode = '42501';
  end if;
  if p_task_id is null or v_scan = '' then
    raise exception 'Task and scanned serial are required' using errcode = '22023';
  end if;
  if char_length(v_scan) > 256 then
    raise exception 'Scanned serial is too long' using errcode = '22023';
  end if;

  select * into v_task
  from public.recount_tasks t
  where t.id = p_task_id
    and t.assigned_user_id = v_actor.id
  for update;
  if not found then
    raise exception 'Assigned recount task not found' using errcode = 'P0002';
  end if;
  if v_task.state = 'completed' then
    return jsonb_build_object('task_id', v_task.id, 'result', 'duplicate_attempt',
                              'masked_value', public.mask_inventory_code(v_scan),
                              'state', v_task.state);
  end if;

  select * into v_secret from public.recount_task_secrets s where s.task_id = v_task.id;
  v_masked := public.mask_inventory_code(v_scan);
  v_hash := encode(extensions.digest(v_scan, 'sha256'), 'hex');

  if v_secret.expected_serial_normalized is not null
     and v_scan = v_secret.expected_serial_normalized then
    v_result := 'matched';
    v_resolution := 'matched';
    v_state := 'completed';
  elsif v_task.task_type = 'surplus_scan'
        and v_secret.first_scanned_code_normalized is not null
        and v_scan = v_secret.first_scanned_code_normalized then
    v_result := 'matched';
    v_resolution := 'genuine_surplus';
    v_state := 'completed';
  elsif exists (
    select 1 from public.recount_serial_evidence e
    where e.batch_id = v_task.batch_id
      and e.serial_normalized = v_scan
      and not e.is_excluded
  ) then
    select exists (
      select 1 from public.recount_serial_evidence e
      where e.batch_id = v_task.batch_id
        and e.serial_normalized = v_scan
        and public.normalize_inventory_code(e.sku) = public.normalize_inventory_code(v_task.sku)
        and not e.is_excluded
    ) into v_same_batch;
    v_result := case when v_same_batch then 'duplicate_first_count' else 'wrong_sku' end;
    v_resolution := case when v_same_batch then 'mistaken_first_scan' else 'not_found' end;
    v_state := 'in_progress';
  else
    v_result := 'unknown_serial';
    v_resolution := 'not_found';
    v_state := 'in_progress';
  end if;

  insert into public.recount_attempts (
    task_id, user_id, user_name_snapshot, scanned_value_hash,
    scanned_value_masked, result, reason
  ) values (
    v_task.id, v_actor.id, v_actor.full_name, v_hash, v_masked,
    v_result, null
  );

  update public.recount_tasks
  set state = v_state,
      resolution = case when v_state = 'completed' then v_resolution else null end,
      completed_by = case when v_state = 'completed' then v_actor.id else null end,
      completed_by_name_snapshot = case when v_state = 'completed' then v_actor.full_name else null end,
      completed_at = case when v_state = 'completed' then now() else null end,
      version = version + 1
  where id = v_task.id;

  insert into public.audit_logs (
    actor_user_id, actor_name_snapshot, action, entity_type, entity_id,
    before_data, after_data
  ) values (
    v_actor.id, v_actor.full_name, 'submit_recount_attempt', 'recount_task', v_task.id::text,
    jsonb_build_object('state', v_task.state, 'version', v_task.version),
    jsonb_build_object('result', v_result, 'state', v_state, 'version', v_task.version + 1)
  );

  return jsonb_build_object(
    'task_id', v_task.id,
    'result', v_result,
    'masked_value', v_masked,
    'state', v_state,
    'resolution', case when v_state = 'completed' then v_resolution else null end
  );
end;
$$;

revoke all on function public.counter_list_recount_tasks(uuid, public.recount_task_state) from public, anon, authenticated;
revoke all on function public.counter_submit_recount_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.counter_list_recount_tasks(uuid, public.recount_task_state) to authenticated;
grant execute on function public.counter_submit_recount_attempt(uuid, text) to authenticated;
