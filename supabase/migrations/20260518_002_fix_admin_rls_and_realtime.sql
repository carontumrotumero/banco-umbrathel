-- Fix RLS recursion for admin checks and ensure admin visibility works

create or replace function public.is_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_role text;
begin
  if p_user_id is null then
    return false;
  end if;

  select role into v_role
  from public.profiles
  where id = p_user_id;

  return coalesce(v_role, '') = 'admin';
end;
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated;

drop policy if exists profiles_select_all_for_admin on public.profiles;
create policy profiles_select_all_for_admin
on public.profiles
for select
using (public.is_admin(auth.uid()));

drop policy if exists accounts_select_all_for_admin on public.accounts;
create policy accounts_select_all_for_admin
on public.accounts
for select
using (public.is_admin(auth.uid()));

drop policy if exists transactions_select_related on public.transactions;
create policy transactions_select_related
on public.transactions
for select
using (
  exists (
    select 1
    from public.accounts a
    where (a.id = transactions.from_account_id or a.id = transactions.to_account_id)
      and a.user_id = auth.uid()
  )
  or public.is_admin(auth.uid())
);

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
  or public.is_admin(auth.uid())
);
