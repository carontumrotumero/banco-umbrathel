-- Salary and marketplace modules with realtime-safe purchase flow

alter table public.transactions
  drop constraint if exists transactions_type_check;

alter table public.transactions
  add constraint transactions_type_check
  check (
    type in (
      'deposit',
      'withdraw',
      'transfer_in',
      'transfer_out',
      'admin_credit',
      'admin_debit',
      'salary_credit',
      'marketplace_buy',
      'marketplace_sale'
    )
  );

create table if not exists public.salary_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  source text not null default 'salary',
  note text,
  paid_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.market_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  unit_price numeric(14,2) not null check (unit_price > 0),
  stock integer check (stock is null or stock >= 0),
  is_unlimited boolean not null default false,
  base_discount_percent numeric(5,2) not null default 0 check (base_discount_percent >= 0 and base_discount_percent <= 100),
  tier_discounts jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.market_purchases (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.market_listings(id) on delete restrict,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null,
  applied_discount_percent numeric(5,2) not null default 0,
  total_amount numeric(14,2) not null,
  created_at timestamptz not null default now()
);

create or replace function public.market_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_market_listings_updated_at on public.market_listings;
create trigger trg_market_listings_updated_at
before update on public.market_listings
for each row execute function public.market_touch_updated_at();

alter table public.salary_records enable row level security;
alter table public.market_listings enable row level security;
alter table public.market_purchases enable row level security;

drop policy if exists salary_records_select_own_or_admin on public.salary_records;
create policy salary_records_select_own_or_admin
on public.salary_records
for select
using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists market_listings_select_public_or_owner on public.market_listings;
create policy market_listings_select_public_or_owner
on public.market_listings
for select
using (is_active = true or seller_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists market_listings_insert_own on public.market_listings;
create policy market_listings_insert_own
on public.market_listings
for insert
with check (seller_id = auth.uid());

drop policy if exists market_listings_update_own_or_admin on public.market_listings;
create policy market_listings_update_own_or_admin
on public.market_listings
for update
using (seller_id = auth.uid() or public.is_admin(auth.uid()))
with check (seller_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists market_purchases_select_related on public.market_purchases;
create policy market_purchases_select_related
on public.market_purchases
for select
using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin(auth.uid()));

create or replace function public.calculate_market_discount(
  p_base_discount numeric,
  p_tiers jsonb,
  p_quantity integer
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_discount numeric := coalesce(p_base_discount, 0);
  v_tier jsonb;
  v_min_qty integer;
  v_percent numeric;
begin
  if p_tiers is null then
    return greatest(0, least(100, v_discount));
  end if;

  for v_tier in select * from jsonb_array_elements(p_tiers)
  loop
    v_min_qty := coalesce((v_tier->>'min_qty')::integer, 0);
    v_percent := coalesce((v_tier->>'discount_percent')::numeric, 0);

    if p_quantity >= v_min_qty and v_percent > v_discount then
      v_discount := v_percent;
    end if;
  end loop;

  return greatest(0, least(100, v_discount));
end;
$$;

create or replace function public.admin_add_salary(
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_account_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'El salario debe ser mayor que 0';
  end if;

  select public.is_admin(auth.uid()) into v_is_admin;
  if not v_is_admin then
    raise exception 'Solo administradores pueden registrar salarios';
  end if;

  select id into v_account_id
  from public.accounts
  where user_id = p_user_id
  for update;

  if v_account_id is null then
    raise exception 'Cuenta del usuario no encontrada';
  end if;

  update public.accounts
  set balance = balance + p_amount
  where id = v_account_id;

  insert into public.salary_records(user_id, amount, source, note, created_by)
  values (p_user_id, p_amount, coalesce(nullif(trim(p_source), ''), 'salary'), p_note, auth.uid());

  insert into public.transactions(type, amount, detail, to_account_id, created_by)
  values ('salary_credit', p_amount, 'Pago de salario', v_account_id, auth.uid());
end;
$$;

create or replace function public.buy_market_listing(
  p_listing_id uuid,
  p_quantity integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.market_listings%rowtype;
  v_buyer_account uuid;
  v_seller_account uuid;
  v_buyer_balance numeric;
  v_discount numeric;
  v_total numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor que 0';
  end if;

  select * into v_listing
  from public.market_listings
  where id = p_listing_id and is_active = true
  for update;

  if v_listing.id is null then
    raise exception 'Articulo no disponible';
  end if;

  if v_listing.seller_id = auth.uid() then
    raise exception 'No puedes comprar tu propio articulo';
  end if;

  if not v_listing.is_unlimited then
    if v_listing.stock is null or v_listing.stock < p_quantity then
      raise exception 'Stock insuficiente';
    end if;
  end if;

  select id, balance into v_buyer_account, v_buyer_balance
  from public.accounts
  where user_id = auth.uid()
  for update;

  if v_buyer_account is null then
    raise exception 'Cuenta compradora no encontrada';
  end if;

  select id into v_seller_account
  from public.accounts
  where user_id = v_listing.seller_id
  for update;

  if v_seller_account is null then
    raise exception 'Cuenta del vendedor no encontrada';
  end if;

  v_discount := public.calculate_market_discount(v_listing.base_discount_percent, v_listing.tier_discounts, p_quantity);
  v_total := round((v_listing.unit_price * p_quantity) * (1 - (v_discount / 100.0)), 2);

  if v_total <= 0 then
    raise exception 'Total de compra invalido';
  end if;

  if v_buyer_balance < v_total then
    raise exception 'Fondos insuficientes para comprar';
  end if;

  update public.accounts set balance = balance - v_total where id = v_buyer_account;
  update public.accounts set balance = balance + v_total where id = v_seller_account;

  if not v_listing.is_unlimited then
    update public.market_listings
    set stock = stock - p_quantity,
        is_active = case when stock - p_quantity <= 0 then false else is_active end
    where id = v_listing.id;
  end if;

  insert into public.market_purchases(listing_id, buyer_id, seller_id, quantity, unit_price, applied_discount_percent, total_amount)
  values (v_listing.id, auth.uid(), v_listing.seller_id, p_quantity, v_listing.unit_price, v_discount, v_total);

  insert into public.transactions(type, amount, detail, from_account_id, to_account_id, created_by)
  values ('marketplace_buy', v_total, 'Compra en mercado', v_buyer_account, v_seller_account, auth.uid());

  insert into public.transactions(type, amount, detail, from_account_id, to_account_id, created_by)
  values ('marketplace_sale', v_total, 'Venta en mercado', v_buyer_account, v_seller_account, auth.uid());
end;
$$;

revoke all on function public.admin_add_salary(uuid, numeric, text, text) from public;
revoke all on function public.buy_market_listing(uuid, integer) from public;
grant execute on function public.admin_add_salary(uuid, numeric, text, text) to authenticated;
grant execute on function public.buy_market_listing(uuid, integer) to authenticated;
