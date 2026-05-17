-- Allow admin signed balance adjustments (positive/negative)

alter table public.transactions
  drop constraint if exists transactions_type_check;

alter table public.transactions
  add constraint transactions_type_check
  check (type in ('deposit', 'withdraw', 'transfer_in', 'transfer_out', 'admin_credit', 'admin_debit'));

create or replace function public.admin_adjust_user_balance(p_user_id uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to_account uuid;
  v_current_balance numeric;
  v_is_admin boolean;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'El monto debe ser distinto de 0';
  end if;

  select public.is_admin(auth.uid()) into v_is_admin;
  if not v_is_admin then
    raise exception 'Solo administradores pueden ajustar saldo';
  end if;

  select id, balance
  into v_to_account, v_current_balance
  from public.accounts
  where user_id = p_user_id
  for update;

  if v_to_account is null then
    raise exception 'Usuario destino no encontrado';
  end if;

  if p_amount < 0 and v_current_balance < abs(p_amount) then
    raise exception 'Saldo insuficiente para aplicar el ajuste negativo';
  end if;

  update public.accounts
  set balance = balance + p_amount
  where id = v_to_account;

  if p_amount > 0 then
    insert into public.transactions(type, amount, detail, to_account_id, created_by)
    values ('admin_credit', p_amount, 'Ajuste admin positivo', v_to_account, auth.uid());
  else
    insert into public.transactions(type, amount, detail, to_account_id, created_by)
    values ('admin_debit', abs(p_amount), 'Ajuste admin negativo', v_to_account, auth.uid());
  end if;
end;
$$;

revoke all on function public.admin_adjust_user_balance(uuid, numeric) from public;
grant execute on function public.admin_adjust_user_balance(uuid, numeric) to authenticated;
