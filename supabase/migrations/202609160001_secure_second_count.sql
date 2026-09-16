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
create policy inventory_sessions_authenticated_all
on public.inventory_sessions
for all
to authenticated
using (true)
with check (true);

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
create policy monthly_archives_authenticated_all
on public.monthly_archives
for all
to authenticated
using (true)
with check (true);

-- SPA đăng nhập anonymous qua Supabase Auth và chỉ role authenticated được thao tác.
-- Bật Anonymous Sign-Ins trong Authentication > Providers > Anonymous.

-- Secure second-count subsystem (202609160001).
-- New objects are migration-managed; apply this section once.
-- Legacy anonymous session policies above remain unchanged until named-account rollout.
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
    upper(normalize(coalesce(p_value, ''), NFKC)),
    U&'[[:space:]\200B\200C\200D\2060\FEFF]', '', 'g'
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

revoke all on function public.normalize_inventory_code(text) from public, anon, authenticated;
revoke all on function public.mask_inventory_code(text, integer, integer) from public, anon, authenticated;
revoke all on function public.current_profile_role() from public, anon, authenticated;
revoke all on function public.is_active_profile() from public, anon, authenticated;
revoke all on function private.handle_registered_user() from public, anon, authenticated;
revoke all on function private.set_recount_updated_at() from public, anon, authenticated;
revoke all on function private.bootstrap_initial_admin(uuid) from public, anon, authenticated;
grant execute on function public.normalize_inventory_code(text) to authenticated;
grant execute on function public.mask_inventory_code(text, integer, integer) to authenticated;
grant execute on function public.current_profile_role() to authenticated;
grant execute on function public.is_active_profile() to authenticated;
-- Bootstrap is SQL-Editor/operator-only. Never expose private through the Data API.
