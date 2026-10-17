-- ======================================================================
-- BẢN MIGRATION ĐẦY ĐỦ CHO HỆ THỐNG CHI NHÁNH (BRANCH SETUP)
-- Chạy bản script này trong Supabase SQL Editor để cấu hình toàn bộ:
-- 1. Bảng public.branches
-- 2. Thêm cột branch_code và managed_branches vào public.profiles
-- 3. Cấp quyền UPDATE và RPC update_profile_branch cho Admin
-- 4. Làm mới PostgREST schema cache
-- ======================================================================

-- 1. Thêm cột branch_code và managed_branches vào bảng profiles (nếu chưa có)
alter table public.profiles
  add column if not exists branch_code text not null default 'KHO-TONG',
  add column if not exists managed_branches text[] not null default '{}'::text[];

create index if not exists profiles_branch_code_idx on public.profiles (branch_code);

-- 2. Cấp quyền UPDATE cột branch cho authenticated role và policy cho admin
grant update (branch_code, managed_branches) on public.profiles to authenticated;

drop policy if exists profiles_update_branch on public.profiles;
create policy profiles_update_branch on public.profiles
  for update
  to authenticated
  using ((select public.current_profile_role()) = 'admin')
  with check ((select public.current_profile_role()) = 'admin');

-- 3. Tạo RPC function update_profile_branch (SECURITY DEFINER)
create or replace function public.update_profile_branch(
  p_target_user_id uuid,
  p_branch_code text default null,
  p_managed_branches text[] default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_caller_role public.app_role;
  v_caller_status public.profile_status;
  v_caller_managed text[];
  v_caller_branch text;
  v_target_role public.app_role;
  v_target_branch text;
begin
  select role, status, managed_branches, branch_code
  into v_caller_role, v_caller_status, v_caller_managed, v_caller_branch
  from public.profiles
  where id = auth.uid();

  if v_caller_status <> 'active' or v_caller_role not in ('admin', 'manager') then
    raise exception 'Chỉ quản trị viên hoặc quản lý hoạt động mới có quyền điều chỉnh Branch'
      using errcode = '42501';
  end if;

  select role, branch_code
  into v_target_role, v_target_branch
  from public.profiles
  where id = p_target_user_id;

  if not found then
    raise exception 'Không tìm thấy tài khoản người dùng' using errcode = 'P0002';
  end if;

  if v_caller_role = 'manager' then
    if v_target_role <> 'counter' then
      raise exception 'Quản lý chỉ có quyền cập nhật chi nhánh cho nhân viên kiểm đếm'
        using errcode = '42501';
    end if;
    if cardinality(v_caller_managed) > 0 and not (v_target_branch = any(v_caller_managed)) then
      raise exception 'Nhân viên này không thuộc các chi nhánh bạn đang phụ trách'
        using errcode = '42501';
    end if;
    if p_branch_code is not null and cardinality(v_caller_managed) > 0 and not (p_branch_code = any(v_caller_managed)) then
      raise exception 'Bạn không phụ trách chi nhánh mục tiêu này'
        using errcode = '42501';
    end if;
    p_managed_branches := null;
  end if;

  update public.profiles
  set
    branch_code = coalesce(nullif(trim(p_branch_code), ''), branch_code),
    managed_branches = case
      when v_caller_role = 'admin' and p_managed_branches is not null then p_managed_branches
      else managed_branches
    end,
    updated_at = now()
  where id = p_target_user_id;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_target_user_id,
    'branch_code', p_branch_code
  );
end;
$$;

grant execute on function public.update_profile_branch(uuid, text, text[]) to authenticated;

-- 4. Bảng danh mục chi nhánh public.branches
create table if not exists public.branches (
  code text primary key,
  name text not null,
  address text default '',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.branches enable row level security;

drop policy if exists branches_read_authenticated on public.branches;
create policy branches_read_authenticated
  on public.branches for select to authenticated using (true);

drop policy if exists branches_write_admin on public.branches;
create policy branches_write_admin
  on public.branches for all to authenticated
  using ((select public.current_profile_role()) = 'admin')
  with check ((select public.current_profile_role()) = 'admin');

-- 5. Seed dữ liệu mặc định (nếu chưa có)
insert into public.branches (code, name, address, is_active)
values
  ('KHO-TONG', 'Kho Tổng TP.HCM', 'Tầng 1 Kho Tổng', true),
  ('KHO-HCM', 'Kho Chi Nhánh HCM', 'Quận 10, TP.HCM', true),
  ('KHO-HN', 'Kho Chi Nhánh Hà Nội', 'Kho Phân Phối Miền Bắc', true),
  ('KHO-DN', 'Kho Chi Nhánh Đà Nẵng', 'Hải Châu, Đà Nẵng', true),
  ('SR-Q10', 'Showroom Quận 10', 'Cách Mạng Tháng 8, Q10, TP.HCM', true),
  ('SR-TB', 'Showroom Tân Bình', 'Hoàng Hoa Thám, Tân Bình, TP.HCM', true),
  ('SR-CVD', 'Showroom Cao Thắng', 'Cao Thắng, Q3, TP.HCM', true)
on conflict (code) do nothing;

-- 6. Làm mới PostgREST schema cache
notify pgrst, 'reload schema';
