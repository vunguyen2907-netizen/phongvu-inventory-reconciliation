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
