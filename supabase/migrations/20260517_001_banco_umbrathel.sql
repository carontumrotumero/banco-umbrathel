-- Banco de Umbrathel - Esquema inicial
-- Ejecuta esta migracion con Supabase CLI o pegala en SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references public.profiles(id) on delete cascade,
  balance numeric(14,2) not null default 0 check (balance >= 0),
  currency text not null default 'Ḡ',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('deposit', 'withdraw', 'transfer_in', 'transfer_out', 'admin_credit')),
  amount numeric(14,2) not null check (amount > 0),
  detail text,
  from_account_id uuid references public.accounts(id),
  to_account_id uuid references public.accounts(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounts_updated_at on public.accounts;
create trigger trg_accounts_updated_at
before update on public.accounts
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'user'
  )
  on conflict (id) do nothing;

  insert into public.accounts (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;

-- Profiles
create policy if not exists "profiles_select_own"
on public.profiles
for select
using (auth.uid() = id);

create policy if not exists "profiles_select_all_for_admin"
on public.profiles
for select
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy if not exists "profiles_update_own"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- Accounts
create policy if not exists "accounts_select_own"
on public.accounts
for select
using (auth.uid() = user_id);

create policy if not exists "accounts_select_all_for_admin"
on public.accounts
for select
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

-- Transactions
create policy if not exists "transactions_select_related"
on public.transactions
for select
using (
  exists (
    select 1
    from public.accounts a
    where (a.id = transactions.from_account_id or a.id = transactions.to_account_id)
      and a.user_id = auth.uid()
  )
  or exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create or replace function public.require_positive_amount(p_amount numeric)
returns void
language plpgsql
as $$
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que 0';
  end if;
end;
$$;

create or replace function public.deposit_self(p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
begin
  perform public.require_positive_amount(p_amount);

  select id into v_account_id
  from public.accounts
  where user_id = auth.uid();

  if v_account_id is null then
    raise exception 'Cuenta no encontrada';
  end if;

  update public.accounts
  set balance = balance + p_amount
  where id = v_account_id;

  insert into public.transactions(type, amount, detail, to_account_id, created_by)
  values ('deposit', p_amount, 'Ingreso propio', v_account_id, auth.uid());
end;
$$;

create or replace function public.withdraw_self(p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_balance numeric;
begin
  perform public.require_positive_amount(p_amount);

  select id, balance into v_account_id, v_balance
  from public.accounts
  where user_id = auth.uid()
  for update;

  if v_account_id is null then
    raise exception 'Cuenta no encontrada';
  end if;

  if v_balance < p_amount then
    raise exception 'Fondos insuficientes';
  end if;

  update public.accounts
  set balance = balance - p_amount
  where id = v_account_id;

  insert into public.transactions(type, amount, detail, from_account_id, created_by)
  values ('withdraw', p_amount, 'Retiro propio', v_account_id, auth.uid());
end;
$$;

create or replace function public.transfer_by_email(p_to_email text, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_account uuid;
  v_to_account uuid;
  v_from_balance numeric;
begin
  perform public.require_positive_amount(p_amount);

  if p_to_email is null or length(trim(p_to_email)) = 0 then
    raise exception 'Debes indicar el correo destino';
  end if;

  select id, balance into v_from_account, v_from_balance
  from public.accounts
  where user_id = auth.uid()
  for update;

  if v_from_account is null then
    raise exception 'Tu cuenta no existe';
  end if;

  select a.id into v_to_account
  from public.accounts a
  join public.profiles p on p.id = a.user_id
  where lower(p.email) = lower(trim(p_to_email));

  if v_to_account is null then
    raise exception 'Cuenta destino no encontrada';
  end if;

  if v_to_account = v_from_account then
    raise exception 'No puedes transferirte a ti mismo';
  end if;

  if v_from_balance < p_amount then
    raise exception 'Fondos insuficientes';
  end if;

  update public.accounts set balance = balance - p_amount where id = v_from_account;
  update public.accounts set balance = balance + p_amount where id = v_to_account;

  insert into public.transactions(type, amount, detail, from_account_id, to_account_id, created_by)
  values ('transfer_out', p_amount, 'Transferencia enviada', v_from_account, v_to_account, auth.uid());

  insert into public.transactions(type, amount, detail, from_account_id, to_account_id, created_by)
  values ('transfer_in', p_amount, 'Transferencia recibida', v_from_account, v_to_account, auth.uid());
end;
$$;

create or replace function public.admin_credit_user(p_user_id uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_to_account uuid;
begin
  perform public.require_positive_amount(p_amount);

  select exists(
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'Solo administradores pueden acreditar saldo';
  end if;

  select id into v_to_account
  from public.accounts
  where user_id = p_user_id
  for update;

  if v_to_account is null then
    raise exception 'Usuario destino no encontrado';
  end if;

  update public.accounts
  set balance = balance + p_amount
  where id = v_to_account;

  insert into public.transactions(type, amount, detail, to_account_id, created_by)
  values ('admin_credit', p_amount, 'Acreditacion por administrador', v_to_account, auth.uid());
end;
$$;

revoke all on function public.deposit_self(numeric) from public;
revoke all on function public.withdraw_self(numeric) from public;
revoke all on function public.transfer_by_email(text, numeric) from public;
revoke all on function public.admin_credit_user(uuid, numeric) from public;
grant execute on function public.deposit_self(numeric) to authenticated;
grant execute on function public.withdraw_self(numeric) to authenticated;
grant execute on function public.transfer_by_email(text, numeric) to authenticated;
grant execute on function public.admin_credit_user(uuid, numeric) to authenticated;

create or replace view public.transactions_view as
select
  t.id,
  t.type,
  t.amount,
  t.detail,
  t.created_at,
  case
    when a_from.user_id = auth.uid() then t.from_account_id
    else t.to_account_id
  end as account_id
from public.transactions t
left join public.accounts a_from on a_from.id = t.from_account_id
left join public.accounts a_to on a_to.id = t.to_account_id
where (
  a_from.user_id = auth.uid()
  or a_to.user_id = auth.uid()
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);
