-- Migración: Login con Discord OAuth
-- Añade discord_id a profiles y actualiza el trigger handle_new_user

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS discord_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS discord_username TEXT,
  ADD COLUMN IF NOT EXISTS discord_avatar TEXT;

-- Actualizar handle_new_user para capturar datos de Discord OAuth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_full_name TEXT;
  v_discord_id TEXT;
  v_discord_username TEXT;
  v_discord_avatar TEXT;
BEGIN
  -- Detectar si es login con Discord OAuth
  IF NEW.raw_app_meta_data->>'provider' = 'discord' THEN
    v_discord_id       := NEW.raw_user_meta_data->>'provider_id';
    v_discord_username := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'user_name');
    v_discord_avatar   := NEW.raw_user_meta_data->>'avatar_url';
    v_email            := COALESCE(NEW.email, v_discord_id || '@discord.local');
    v_full_name        := v_discord_username;
  ELSE
    v_email      := COALESCE(NEW.email, '');
    v_full_name  := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
    v_discord_id := NULL;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, discord_id, discord_username, discord_avatar)
  VALUES (NEW.id, v_email, v_full_name, 'user', v_discord_id, v_discord_username, v_discord_avatar)
  ON CONFLICT (id) DO UPDATE SET
    discord_id       = EXCLUDED.discord_id,
    discord_username = EXCLUDED.discord_username,
    discord_avatar   = EXCLUDED.discord_avatar;

  INSERT INTO public.accounts (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Función de transferencia por discord_id (reemplaza transfer_by_email)
CREATE OR REPLACE FUNCTION public.transfer_by_discord(p_to_discord_id TEXT, p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from_account UUID;
  v_to_account   UUID;
  v_from_balance NUMERIC;
  v_to_name      TEXT;
BEGIN
  PERFORM public.require_positive_amount(p_amount);

  IF p_to_discord_id IS NULL OR length(trim(p_to_discord_id)) = 0 THEN
    RAISE EXCEPTION 'Debes indicar el ID de Discord del destinatario';
  END IF;

  SELECT id, balance INTO v_from_account, v_from_balance
  FROM public.accounts WHERE user_id = auth.uid() FOR UPDATE;

  IF v_from_account IS NULL THEN
    RAISE EXCEPTION 'Tu cuenta no existe';
  END IF;

  SELECT a.id INTO v_to_account
  FROM public.accounts a
  JOIN public.profiles p ON p.id = a.user_id
  WHERE p.discord_id = trim(p_to_discord_id);

  IF v_to_account IS NULL THEN
    RAISE EXCEPTION 'Usuario de Discord no encontrado';
  END IF;

  IF v_to_account = v_from_account THEN
    RAISE EXCEPTION 'No puedes transferirte a ti mismo';
  END IF;

  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Fondos insuficientes';
  END IF;

  UPDATE public.accounts SET balance = balance - p_amount WHERE id = v_from_account;
  UPDATE public.accounts SET balance = balance + p_amount WHERE id = v_to_account;

  SELECT discord_username INTO v_to_name FROM public.profiles WHERE id = (SELECT user_id FROM public.accounts WHERE id = v_to_account);

  INSERT INTO public.transactions(type, amount, detail, from_account_id, to_account_id, created_by)
  VALUES ('transfer_out', p_amount, 'Transferencia a ' || COALESCE(v_to_name, p_to_discord_id), v_from_account, v_to_account, auth.uid());

  INSERT INTO public.transactions(type, amount, detail, from_account_id, to_account_id, created_by)
  VALUES ('transfer_in', p_amount, 'Transferencia recibida', v_from_account, v_to_account, auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_by_discord(TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_by_discord(TEXT, NUMERIC) TO authenticated;

-- Función para que el bot sincronice saldos (usa service_role)
CREATE OR REPLACE FUNCTION public.bot_sync_balance(
  p_discord_id TEXT,
  p_balance    NUMERIC,
  p_guild_id   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_account_id UUID;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles WHERE discord_id = p_discord_id;
  IF v_user_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_account_id FROM public.accounts WHERE user_id = v_user_id;
  IF v_account_id IS NULL THEN RETURN; END IF;

  UPDATE public.accounts SET balance = p_balance WHERE id = v_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_sync_transaction(
  p_discord_id  TEXT,
  p_type        TEXT,
  p_amount      NUMERIC,
  p_description TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    UUID;
  v_account_id UUID;
  v_tx_type    TEXT;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles WHERE discord_id = p_discord_id;
  IF v_user_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_account_id FROM public.accounts WHERE user_id = v_user_id;
  IF v_account_id IS NULL THEN RETURN; END IF;

  -- Mapear tipos del bot a tipos de la web
  v_tx_type := CASE p_type
    WHEN 'credit'   THEN 'admin_credit'
    WHEN 'debit'    THEN 'withdraw'
    WHEN 'salary'   THEN 'admin_credit'
    WHEN 'purchase' THEN 'withdraw'
    WHEN 'sale'     THEN 'admin_credit'
    ELSE 'admin_credit'
  END;

  INSERT INTO public.transactions(type, amount, detail, to_account_id, created_by)
  VALUES (v_tx_type, ABS(p_amount), COALESCE(p_description, 'Operación del bot'), v_account_id, v_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.bot_sync_balance(TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bot_sync_transaction(TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bot_sync_balance(TEXT, NUMERIC, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bot_sync_transaction(TEXT, TEXT, NUMERIC, TEXT) TO service_role;

