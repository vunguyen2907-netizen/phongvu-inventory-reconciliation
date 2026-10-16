-- Migration: Thêm thông tin Branch cho User và phân quyền quản lý theo Branch
-- Mỗi User thuộc 1 Branch (branch_code)
-- Admin quản lý tất cả (all managers, all branches, all users)
-- Manager quản lý 1 hoặc nhiều Branch (managed_branches)

alter table public.profiles
  add column if not exists branch_code text not null default 'KHO-TONG',
  add column if not exists managed_branches text[] not null default '{}'::text[];

create index if not exists profiles_branch_code_idx on public.profiles (branch_code);

-- Cập nhật trigger khi nhân sự đăng ký tài khoản mới: Lưu branch_code nếu có chọn
create or replace function private.handle_registered_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_branch text;
begin
  if new.is_anonymous then
    return new;
  end if;
  v_branch := coalesce(nullif(trim(new.raw_user_meta_data ->> 'branch_code'), ''), 'KHO-TONG');

  insert into public.profiles (
    id, email, full_name, erp_name, erp_name_normalized, role, status, branch_code, managed_branches
  )
  values (
    new.id,
    lower(new.email),
    trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')),
    trim(coalesce(new.raw_user_meta_data ->> 'erp_name', '')),
    public.normalize_inventory_code(new.raw_user_meta_data ->> 'erp_name'),
    'counter',
    'active',
    v_branch,
    '{}'::text[]
  );
  return new;
end;
$$;

-- RPC cập nhật Branch cho nhân sự (Admin quản lý all, Manager quản lý counter thuộc branch mình)
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
    -- Kiểm tra nếu target không thuộc branch quản lý
    if cardinality(v_caller_managed) > 0 and not (v_target_branch = any(v_caller_managed)) then
      raise exception 'Nhân viên này không thuộc các chi nhánh bạn đang phụ trách'
        using errcode = '42501';
    end if;
    -- Quản lý chỉ được đổi sang branch mà mình phụ trách
    if p_branch_code is not null and cardinality(v_caller_managed) > 0 and not (p_branch_code = any(v_caller_managed)) then
      raise exception 'Bạn không phụ trách chi nhánh mục tiêu này'
        using errcode = '42501';
    end if;
    -- Quản lý không được đổi managed_branches
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
