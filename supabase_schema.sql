-- Chạy một lần trong Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.inventory_sessions (
    id uuid primary key default gen_random_uuid(),
    session_name text not null,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create or replace function public.set_inventory_sessions_updated_at()
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
for each row execute procedure public.set_inventory_sessions_updated_at();

-- App Streamlit gọi Supabase từ server bằng SUPABASE_KEY (service_role).
-- Không tạo policy public để tránh dữ liệu kiểm kê bị truy cập trực tiếp qua API.
alter table public.inventory_sessions enable row level security;
