# Banco de Umbrathel

Aplicacion bancaria web con Supabase y moneda oficial `Ḡ` (G con raya).

## Funciones incluidas

- Registro e inicio de sesion
- Cuenta bancaria por usuario
- Ver saldo
- Ingresar dinero
- Retirar dinero
- Transferir a otro usuario por correo
- Historial de movimientos
- Rol administrador para agregar dinero a otros usuarios

## Requisitos

- Node.js 18+
- Proyecto en Supabase

## Instalacion

```bash
npm install
cp .env.example .env
```

Rellena `.env` con:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Base de datos SQL persistente (Supabase)

Este proyecto incluye migracion en:

- `supabase/migrations/20260517_001_banco_umbrathel.sql`

Para que no se borre al actualizar:

1. Usa migraciones versionadas (archivo dentro de `supabase/migrations`).
2. Aplica con Supabase CLI (`supabase db push`) o SQL Editor.
3. No uses `db reset` en produccion.

## Levantar la app

```bash
npm run dev
```

## Crear administrador

Despues de registrar un usuario normal, ejecuta en SQL Editor de Supabase:

```sql
update public.profiles
set role = 'admin'
where email = 'tu-admin@correo.com';
```

Ese usuario ya podra usar el panel de administrador para acreditar dinero a otros usuarios.
