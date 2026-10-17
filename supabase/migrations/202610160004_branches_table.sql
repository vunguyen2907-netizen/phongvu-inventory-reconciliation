-- Migration: Bảng quản lý danh mục chi nhánh (branches) cho Admin
create table if not exists public.branches (
  code text primary key,
  name text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.branches enable row level security;

-- Cho phép tất cả user đã đăng nhập xem danh sách chi nhánh
create policy "branches_select_authenticated"
  on public.branches
  for select
  to authenticated
  using (true);

-- Chỉ Admin mới có quyền thêm mới, sửa, xóa chi nhánh
create policy "branches_admin_insert"
  on public.branches
  for insert
  to authenticated
  with check (
    (select public.current_profile_role()) = 'admin'
  );

create policy "branches_admin_update"
  on public.branches
  for update
  to authenticated
  using (
    (select public.current_profile_role()) = 'admin'
  )
  with check (
    (select public.current_profile_role()) = 'admin'
  );

create policy "branches_admin_delete"
  on public.branches
  for delete
  to authenticated
  using (
    (select public.current_profile_role()) = 'admin'
  );

-- Thêm các chi nhánh mặc định của hệ thống
insert into public.branches (code, name, address)
values
  ('KHO-TONG', 'Kho Tổng (Trung tâm)', 'Kho Tổng Trung Tâm Phong Vũ'),
  ('KHO-HCM', 'Kho TP. Hồ Chí Minh', 'TP. Hồ Chí Minh'),
  ('KHO-HN', 'Kho Hà Nội', 'Hà Nội'),
  ('KHO-DN', 'Kho Đà Nẵng', 'Đà Nẵng'),
  ('SR-Q10', 'Showroom Q.10 (CMT8)', 'Cách Mạng Tháng 8, Q.10, TP.HCM'),
  ('SR-TB', 'Showroom Tân Bình', 'Hoàng Hoa Thám, Tân Bình, TP.HCM'),
  ('SR-CVD', 'Showroom Cao Thắng', 'Cao Thắng, Q.3, TP.HCM')
on conflict (code) do nothing;
