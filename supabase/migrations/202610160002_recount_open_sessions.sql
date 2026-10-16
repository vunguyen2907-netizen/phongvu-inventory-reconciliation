-- Migration: Mở quyền đọc bảng inventory_sessions cho mọi tài khoản đã đăng nhập
-- Giúp tất cả nhân sự (kể cả role counter) xem được danh sách đợt kiểm kê và danh sách sản phẩm cần kiểm lần 2.

drop policy if exists inventory_sessions_select_authenticated on public.inventory_sessions;
create policy inventory_sessions_select_authenticated
on public.inventory_sessions
for select
to authenticated
using (true);

drop policy if exists inventory_sessions_update_authenticated on public.inventory_sessions;
create policy inventory_sessions_update_authenticated
on public.inventory_sessions
for update
to authenticated
using (true)
with check (true);

-- Cập nhật trigger đăng ký để tài khoản nhân sự mới đăng ký được tự động kích hoạt (active)
-- Nhân sự vào là thấy ngay danh sách kiểm lần 2 để dùng hệ thống kiểm kê nội bộ quét lại
create or replace function private.handle_registered_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_anonymous then
    return new;
  end if;
  insert into public.profiles (id, email, full_name, erp_name, erp_name_normalized, role, status)
  values (
    new.id,
    lower(new.email),
    trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')),
    trim(coalesce(new.raw_user_meta_data ->> 'erp_name', '')),
    public.normalize_inventory_code(new.raw_user_meta_data ->> 'erp_name'),
    'counter',
    'active'
  );
  return new;
end;
$$;
