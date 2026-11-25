-- =============================================================================
-- Lonja · Esquema de la base de datos (Neon Postgres + Data API + Neon Auth)
-- =============================================================================
-- Se aplica sobre la base de datos «neondb» de la rama «production».
--
-- SEGURIDAD
-- La Data API de Neon no tiene permisos propios: cada petición se ejecuta con
-- el rol «authenticated» (usuario con sesión, JWT de Neon Auth) o «anonymous»
-- (invitado, JWT anónimo). Lo que cada uno puede hacer se decide aquí:
--   1. GRANT: qué tablas y funciones puede usar cada rol.
--   2. RLS (Row-Level Security): qué filas ve o modifica cada usuario.
--      auth.user_id() devuelve el id del usuario del JWT (neon_auth.user.id).
--   3. Funciones SECURITY DEFINER (/rest/v1/rpc/...): las reglas de negocio
--      que no caben en RLS (no comprar lo propio, pedidos duplicados, reservas
--      solapadas, transiciones de estado según el rol…). Se ejecutan con los
--      permisos del propietario, comprueban quién llama y validan todo.
-- Las tablas de pedidos, favoritos, mensajes y valoraciones no admiten
-- INSERT/UPDATE directos: solo se modifican a través de esas funciones.
--
-- El script se puede volver a ejecutar (IF NOT EXISTS / OR REPLACE / DROP
-- POLICY IF EXISTS). Después hay que refrescar la caché de la Data API.
-- =============================================================================

begin;

create schema if not exists lonja_internal;
comment on schema lonja_internal is 'Funciones y tablas auxiliares de Lonja. No se exponen en la Data API.';

-- -----------------------------------------------------------------------------
-- Utilidades internas
-- -----------------------------------------------------------------------------

-- Fecha en el mismo formato ISO que usa la web (2026-11-25T09:11:44.528Z).
create or replace function lonja_internal.iso(ts timestamptz) returns text
language sql immutable as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Lanza un error de negocio: el mensaje se muestra al usuario y el «hint» es
-- el código que interpreta la web (auth_required, forbidden, overlap…).
create or replace function lonja_internal.fail(code text, message text) returns void
language plpgsql as $$
begin
  raise exception using message = message, hint = code, errcode = 'P0001';
end $$;

-- Id del usuario que llama; falla si no hay sesión o no tiene perfil.
create or replace function lonja_internal.require_user() returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me text := auth.user_id();
begin
  if me is null or not exists (select 1 from public.profiles where id = me) then
    perform lonja_internal.fail('auth_required', 'Inicia sesión o crea una cuenta para continuar.');
  end if;
  return me;
end $$;

-- Id del usuario del JWT para los disparadores. El esquema «auth» de Neon es de
-- un rol interno y los roles de la Data API no pueden usarlo por su nombre
-- dentro de funciones normales; esta función se ejecuta como el propietario.
create or replace function lonja_internal.current_user_id() returns text
language sql stable security definer set search_path = pg_temp as $$
  select auth.user_id()
$$;

-- «2026-11-30» o «2026-11-30T10:00» → timestamp.
create or replace function lonja_internal.to_ts(value text) returns timestamp
language sql immutable as $$
  select case when length(value) <= 10 then (value || 'T00:00')::timestamp else value::timestamp end
$$;

-- Intervalo [inicio, fin) de una reserva. Una reserva de un solo día ocupa ese día completo.
create or replace function lonja_internal.booking_range(start_date text, end_date text) returns tsrange
language sql immutable as $$
  select tsrange(
    lonja_internal.to_ts(start_date),
    case when lonja_internal.to_ts(end_date) <= lonja_internal.to_ts(start_date)
      then lonja_internal.to_ts(start_date) + interval '1 day'
      else lonja_internal.to_ts(end_date) end,
    '[)')
$$;

-- Unidades de alquiler (horas, días, semanas, meses), igual que computeRentalUnits() en api.js.
create or replace function lonja_internal.rental_units(period text, start_date text, end_date text) returns integer
language plpgsql immutable as $$
declare
  hours numeric := extract(epoch from (lonja_internal.to_ts(end_date) - lonja_internal.to_ts(start_date))) / 3600;
  days numeric := round(hours / 24);
begin
  if hours < 0 then return 0; end if;
  return case period
    when 'hour' then greatest(1, ceil(hours))
    when 'day' then greatest(1, days)
    when 'week' then greatest(1, ceil(days / 7.0))
    when 'month' then greatest(1, ceil(days / 30.0))
    else 0 end;
end $$;

-- Estados en los que un pedido está abierto (el artículo en venta queda «Reservado»).
create or replace function lonja_internal.open_statuses() returns text[]
language sql immutable as $$
  select array['pending', 'accepted', 'preparing', 'shipped', 'confirmed', 'in_progress', 'disputed']
$$;

create or replace function lonja_internal.new_id(prefix text, upper_case boolean default false) returns text
language sql volatile as $$
  select case when upper_case
    then upper(prefix) || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
    else prefix || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) end
$$;

-- Transiciones de pedido permitidas por tipo de operación y rol (= ORDER_TRANSITIONS de data.js).
create table if not exists lonja_internal.order_transitions (
  operation_type text not null,
  role text not null,
  from_status text not null,
  to_status text not null,
  primary key (operation_type, role, from_status, to_status)
);
insert into lonja_internal.order_transitions values
  ('sale', 'seller', 'pending', 'accepted'), ('sale', 'seller', 'pending', 'cancelled'),
  ('sale', 'seller', 'accepted', 'preparing'), ('sale', 'seller', 'accepted', 'cancelled'),
  ('sale', 'seller', 'preparing', 'shipped'), ('sale', 'seller', 'shipped', 'completed'),
  ('sale', 'seller', 'disputed', 'completed'), ('sale', 'seller', 'disputed', 'cancelled'),
  ('sale', 'buyer', 'pending', 'cancelled'), ('sale', 'buyer', 'accepted', 'disputed'),
  ('sale', 'buyer', 'preparing', 'disputed'), ('sale', 'buyer', 'shipped', 'completed'),
  ('sale', 'buyer', 'shipped', 'disputed'),
  ('rent', 'seller', 'pending', 'confirmed'), ('rent', 'seller', 'pending', 'cancelled'),
  ('rent', 'seller', 'confirmed', 'in_progress'), ('rent', 'seller', 'confirmed', 'cancelled'),
  ('rent', 'seller', 'in_progress', 'completed'), ('rent', 'seller', 'disputed', 'completed'),
  ('rent', 'seller', 'disputed', 'cancelled'),
  ('rent', 'buyer', 'pending', 'cancelled'), ('rent', 'buyer', 'confirmed', 'cancelled'),
  ('rent', 'buyer', 'confirmed', 'disputed'), ('rent', 'buyer', 'in_progress', 'disputed')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Tablas
-- -----------------------------------------------------------------------------

-- Perfil público. id = neon_auth.user.id (la cuenta de Neon Auth).
create table if not exists public.profiles (
  id text primary key,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  first_name text not null default '' check (char_length(first_name) <= 50),
  last_name text not null default '' check (char_length(last_name) <= 80),
  avatar text check (avatar is null or char_length(avatar) <= 1500000),
  bio text not null default '' check (char_length(bio) <= 1000),
  public_location text not null default '' check (char_length(public_location) <= 80),
  preferences jsonb not null default '{}'::jsonb,
  role text not null default 'user',
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

-- Datos privados del perfil: solo los ve su dueño.
create table if not exists public.profile_private (
  user_id text primary key references public.profiles (id) on delete cascade,
  email text not null default '' check (char_length(email) <= 254),
  phone text not null default '' check (char_length(phone) <= 20),
  birth_date text not null default '' check (char_length(birth_date) <= 10),
  country text not null default 'España' check (char_length(country) <= 60),
  city text not null default '' check (char_length(city) <= 60),
  address text not null default '' check (char_length(address) <= 120)
);

create table if not exists public.listings (
  id text primary key default lonja_internal.new_id('lst'),
  seller_id text not null default auth.user_id() references public.profiles (id),
  title text not null default '' check (char_length(title) <= 120),
  description text not null default '' check (char_length(description) <= 5000),
  category text not null check (char_length(category) <= 40),
  subcategory text,
  operation_type text not null check (operation_type in ('sale', 'rent')),
  price numeric(12, 2) check (price is null or price >= 0),
  currency text not null default 'EUR',
  rental jsonb,
  condition text,
  brand text not null default '' check (char_length(brand) <= 80),
  model text not null default '' check (char_length(model) <= 80),
  availability text not null default '' check (char_length(availability) <= 200),
  delivery_notes text not null default '' check (char_length(delivery_notes) <= 1000),
  attributes jsonb not null default '{}'::jsonb,
  custom_attributes jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 8),
  location jsonb not null default '{}'::jsonb,
  delivery jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'active', 'paused', 'sold', 'rented', 'finished')),
  featured boolean not null default false,
  views integer not null default 0,
  price_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint listings_published_complete check (status = 'draft' or (price > 0 and char_length(title) > 0)),
  constraint listings_images_size check (pg_column_size(images) <= 8000000)
);
create index if not exists listings_seller_idx on public.listings (seller_id);
create index if not exists listings_status_idx on public.listings (status) where deleted_at is null;

create table if not exists public.orders (
  id text primary key,
  listing_id text not null references public.listings (id),
  buyer_id text not null references public.profiles (id),
  seller_id text not null references public.profiles (id),
  operation_type text not null check (operation_type in ('sale', 'rent')),
  amount numeric(12, 2) not null,
  currency text not null default 'EUR',
  units integer,
  start_date text,
  end_date text,
  status text not null,
  delivery jsonb not null default '{}'::jsonb,
  status_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_listing_idx on public.orders (listing_id);
create index if not exists orders_buyer_idx on public.orders (buyer_id);
create index if not exists orders_seller_idx on public.orders (seller_id);

create table if not exists public.favorites (
  id text primary key default lonja_internal.new_id('fav'),
  user_id text not null references public.profiles (id),
  listing_id text not null references public.listings (id),
  created_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

create table if not exists public.messages (
  id text primary key default lonja_internal.new_id('msg'),
  conversation_id text not null,
  listing_id text not null references public.listings (id),
  sender_id text not null references public.profiles (id),
  receiver_id text not null references public.profiles (id),
  content text not null check (char_length(content) between 1 and 1000),
  created_at timestamptz not null default now(),
  read boolean not null default false
);
create index if not exists messages_conversation_idx on public.messages (conversation_id);
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists messages_receiver_idx on public.messages (receiver_id);

create table if not exists public.reviews (
  id text primary key default lonja_internal.new_id('rev'),
  order_id text not null references public.orders (id),
  listing_id text not null references public.listings (id),
  reviewer_id text not null references public.profiles (id),
  reviewee_id text not null references public.profiles (id),
  rating integer not null check (rating between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  unique (order_id, reviewer_id)
);

create table if not exists public.reports (
  id text primary key default lonja_internal.new_id('rep'),
  type text not null check (type in ('listing', 'problem')),
  user_id text not null default auth.user_id() references public.profiles (id),
  listing_id text references public.listings (id),
  reason text not null check (char_length(reason) between 1 and 40),
  details text not null check (char_length(details) between 10 and 1000),
  status text not null default 'registered',
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Vistas públicas (sin datos personales)
-- -----------------------------------------------------------------------------

-- Pedidos que bloquean un anuncio: ventas abiertas («Reservado») y reservas
-- confirmadas o en curso («Fechas ya reservadas»). No incluye quién compra.
create or replace view public.listing_reservations as
  select id, listing_id, operation_type, status, start_date, end_date
  from public.orders
  where (operation_type = 'sale' and status = any (lonja_internal.open_statuses()))
     or (operation_type = 'rent' and status in ('confirmed', 'in_progress'));

-- Cuántas personas tienen cada anuncio en favoritos.
create or replace view public.listing_favorite_counts as
  select listing_id, count(*)::integer as favorites
  from public.favorites
  group by listing_id;

-- -----------------------------------------------------------------------------
-- Disparadores: campos que la web no puede fijar por su cuenta
-- -----------------------------------------------------------------------------
-- Solo actúan en peticiones de la Data API (roles authenticated/anonymous).
-- Las funciones SECURITY DEFINER y los scripts del propietario no se ven afectados.

create or replace function lonja_internal.profiles_guard() returns trigger
language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anonymous') then return new; end if;
  if tg_op = 'INSERT' then
    new.id := lonja_internal.current_user_id();
    new.is_demo := false;
    new.role := 'user';
    new.created_at := now();
  else
    new.id := old.id;
    new.is_demo := old.is_demo;
    new.role := old.role;
    new.created_at := old.created_at;
    -- Las cuentas de prueba se localizan por su nombre de usuario: no se puede cambiar.
    if old.is_demo then new.username := old.username; end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function lonja_internal.profiles_guard();

create or replace function lonja_internal.listings_guard() returns trigger
language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anonymous') then return new; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('active', 'draft') then
      perform lonja_internal.fail('validation', 'Un anuncio nuevo solo puede publicarse o guardarse como borrador.');
    end if;
    new.seller_id := lonja_internal.current_user_id();
    new.views := 0;
    new.featured := false;
    new.deleted_at := null;
    new.created_at := now();
    new.updated_at := now();
    new.price_history := case when new.price is not null
      then jsonb_build_array(jsonb_build_object('price', new.price, 'date', lonja_internal.iso(now())))
      else '[]'::jsonb end;
  else
    new.id := old.id;
    new.seller_id := old.seller_id;
    new.views := old.views;
    new.featured := old.featured;
    new.status := old.status;            -- los cambios de estado van por set_listing_status / publish_listing
    new.created_at := old.created_at;
    new.deleted_at := old.deleted_at;
    new.price_history := old.price_history;
    if new.price is not null and new.price is distinct from old.price then
      new.price_history := old.price_history || jsonb_build_array(jsonb_build_object('price', new.price, 'date', lonja_internal.iso(now())));
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists listings_guard on public.listings;
create trigger listings_guard before insert or update on public.listings
  for each row execute function lonja_internal.listings_guard();

create or replace function lonja_internal.reports_guard() returns trigger
language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anonymous') then return new; end if;
  new.user_id := lonja_internal.current_user_id();
  new.status := 'registered';
  new.created_at := now();
  return new;
end $$;
drop trigger if exists reports_guard on public.reports;
create trigger reports_guard before insert on public.reports
  for each row execute function lonja_internal.reports_guard();

-- -----------------------------------------------------------------------------
-- Funciones de negocio (Data API: POST /rest/v1/rpc/<nombre>)
-- -----------------------------------------------------------------------------

-- Crea un pedido (venta) o una solicitud de reserva (alquiler).
create or replace function public.create_order(
  p_listing_id text, p_delivery_method text,
  p_start_date text default null, p_end_date text default null, p_notes text default ''
) returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  l public.listings;
  existing public.orders;
  result public.orders;
  v_units integer;
  v_now text := lonja_internal.iso(now());
  v_delivery jsonb := jsonb_build_object('method', p_delivery_method, 'notes', left(trim(coalesce(p_notes, '')), 300));
  v_history jsonb := jsonb_build_array(jsonb_build_object('status', 'pending', 'date', lonja_internal.iso(now()), 'by', me));
begin
  -- FOR UPDATE: dos compras simultáneas del mismo artículo se atienden de una en una.
  select * into l from public.listings where id = p_listing_id and deleted_at is null for update;
  if not found then perform lonja_internal.fail('not_found', 'El anuncio ya no está disponible.'); end if;
  if l.seller_id = me then perform lonja_internal.fail('forbidden', 'No puedes comprar ni alquilar tu propio anuncio.'); end if;
  if l.status <> 'active' then perform lonja_internal.fail('unavailable', 'Este anuncio no está disponible en este momento.'); end if;
  if coalesce((l.delivery ->> p_delivery_method)::boolean, false) is not true then
    perform lonja_internal.fail('validation', 'Selecciona una modalidad de entrega disponible.');
  end if;

  if l.operation_type = 'sale' then
    select * into existing from public.orders
      where listing_id = l.id and operation_type = 'sale' and status = any (lonja_internal.open_statuses()) limit 1;
    if found then
      if existing.buyer_id = me then perform lonja_internal.fail('duplicate', 'Ya tienes un pedido abierto para este artículo.'); end if;
      perform lonja_internal.fail('unavailable', 'Este artículo está reservado por otro comprador.');
    end if;
    insert into public.orders (id, listing_id, buyer_id, seller_id, operation_type, amount, currency, status, delivery, status_history)
      values (lonja_internal.new_id('PED', true), l.id, me, l.seller_id, 'sale', l.price, l.currency, 'pending', v_delivery, v_history)
      returning * into result;
    return result;
  end if;

  -- Alquiler
  if coalesce(p_start_date, '') = '' or coalesce(p_end_date, '') = '' then
    perform lonja_internal.fail('validation', 'Indica las fechas de inicio y fin.');
  end if;
  if lonja_internal.to_ts(p_end_date) < lonja_internal.to_ts(p_start_date) then
    perform lonja_internal.fail('validation', 'La fecha de fin debe ser posterior a la de inicio.');
  end if;
  if lonja_internal.to_ts(p_start_date)::date < (now() at time zone 'Europe/Madrid')::date then
    perform lonja_internal.fail('validation', 'La fecha de inicio no puede estar en el pasado.');
  end if;
  v_units := lonja_internal.rental_units(l.rental ->> 'period', p_start_date, p_end_date);
  if coalesce((l.rental ->> 'minDuration')::integer, 0) > 0 and v_units < (l.rental ->> 'minDuration')::integer then
    perform lonja_internal.fail('validation', format('La duración mínima es de %s unidades del periodo de alquiler.', l.rental ->> 'minDuration'));
  end if;
  if coalesce((l.rental ->> 'maxDuration')::integer, 0) > 0 and v_units > (l.rental ->> 'maxDuration')::integer then
    perform lonja_internal.fail('validation', format('La duración máxima es de %s unidades del periodo de alquiler.', l.rental ->> 'maxDuration'));
  end if;
  if exists (
    select 1 from public.orders b
    where b.listing_id = l.id and b.operation_type = 'rent' and b.status in ('confirmed', 'in_progress')
      and lonja_internal.booking_range(b.start_date, b.end_date) && lonja_internal.booking_range(p_start_date, p_end_date)
  ) then
    perform lonja_internal.fail('overlap', 'Las fechas elegidas se solapan con una reserva ya confirmada.');
  end if;
  if exists (
    select 1 from public.orders d
    where d.listing_id = l.id and d.buyer_id = me and d.status = 'pending' and d.start_date = p_start_date and d.end_date = p_end_date
  ) then
    perform lonja_internal.fail('duplicate', 'Ya has enviado una solicitud para estas mismas fechas.');
  end if;
  insert into public.orders (id, listing_id, buyer_id, seller_id, operation_type, amount, currency, units, start_date, end_date, status, delivery, status_history)
    values (lonja_internal.new_id('RES', true), l.id, me, l.seller_id, 'rent', v_units * l.price, l.currency, v_units, p_start_date, p_end_date, 'pending', v_delivery, v_history)
    returning * into result;
  return result;
end $$;

-- Cambia el estado de un pedido según el rol de quien llama y las transiciones permitidas.
create or replace function public.update_order_status(p_order_id text, p_next_status text) returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  o public.orders;
  v_role text;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then perform lonja_internal.fail('not_found', 'Pedido no encontrado.'); end if;
  v_role := case when o.seller_id = me then 'seller' when o.buyer_id = me then 'buyer' end;
  if v_role is null then perform lonja_internal.fail('forbidden', 'No participas en este pedido.'); end if;
  if not exists (
    select 1 from lonja_internal.order_transitions t
    where t.operation_type = o.operation_type and t.role = v_role and t.from_status = o.status and t.to_status = p_next_status
  ) then
    perform lonja_internal.fail('invalid_transition', 'Esta acción ya no está disponible para el pedido.');
  end if;
  if o.operation_type = 'rent' and p_next_status = 'confirmed' and exists (
    select 1 from public.orders b
    where b.listing_id = o.listing_id and b.id <> o.id and b.operation_type = 'rent' and b.status in ('confirmed', 'in_progress')
      and lonja_internal.booking_range(b.start_date, b.end_date) && lonja_internal.booking_range(o.start_date, o.end_date)
  ) then
    perform lonja_internal.fail('overlap', 'No se puede confirmar: se solapa con otra reserva confirmada.');
  end if;
  update public.orders
    set status = p_next_status,
        updated_at = now(),
        status_history = status_history || jsonb_build_array(jsonb_build_object('status', p_next_status, 'date', lonja_internal.iso(now()), 'by', me))
    where id = o.id
    returning * into o;
  -- Una venta completada marca el artículo como vendido.
  if o.operation_type = 'sale' and p_next_status = 'completed' then
    update public.listings set status = 'sold', updated_at = now() where id = o.listing_id;
  end if;
  return o;
end $$;

-- Pausar, reactivar, marcar vendido/alquilado o finalizar un anuncio propio.
create or replace function public.set_listing_status(p_listing_id text, p_status text) returns public.listings
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  l public.listings;
  allowed text[];
begin
  select * into l from public.listings where id = p_listing_id and deleted_at is null for update;
  if not found then perform lonja_internal.fail('not_found', 'El anuncio no existe o ha sido eliminado.'); end if;
  if l.seller_id <> me then perform lonja_internal.fail('forbidden', 'Solo el propietario puede modificar este anuncio.'); end if;
  allowed := case l.status
    when 'active' then array['paused', 'sold', 'rented', 'finished']
    when 'paused' then array['active', 'finished']
    when 'pending_review' then array['paused']
    when 'sold' then array['active']
    when 'rented' then array['active', 'finished']
    when 'finished' then array['active']
    else array[]::text[] end;
  if not (p_status = any (allowed)) then perform lonja_internal.fail('invalid_transition', 'Este cambio de estado no está permitido.'); end if;
  if p_status = 'sold' and l.operation_type <> 'sale' then perform lonja_internal.fail('invalid_transition', 'Solo los anuncios de venta pueden marcarse como vendidos.'); end if;
  if p_status = 'rented' and l.operation_type <> 'rent' then perform lonja_internal.fail('invalid_transition', 'Solo los anuncios de alquiler pueden marcarse como alquilados.'); end if;
  if p_status = 'active' then
    if coalesce(l.price, 0) <= 0 or char_length(l.title) = 0 then
      perform lonja_internal.fail('validation', 'El anuncio está incompleto. Edítalo antes de reactivarlo.');
    end if;
    if l.operation_type = 'sale' and exists (select 1 from public.orders where listing_id = l.id and status = 'completed') then
      perform lonja_internal.fail('conflict', 'Este artículo ya tiene una venta completada. Publica un anuncio nuevo si tienes otra unidad.');
    end if;
  end if;
  update public.listings set status = p_status, updated_at = now() where id = l.id returning * into l;
  return l;
end $$;

-- Publica un borrador propio.
create or replace function public.publish_listing(p_listing_id text) returns public.listings
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  l public.listings;
begin
  select * into l from public.listings where id = p_listing_id and deleted_at is null for update;
  if not found then perform lonja_internal.fail('not_found', 'El anuncio no existe o ha sido eliminado.'); end if;
  if l.seller_id <> me then perform lonja_internal.fail('forbidden', 'Solo el propietario puede modificar este anuncio.'); end if;
  if l.status = 'draft' then
    update public.listings set status = 'active', updated_at = now() where id = l.id returning * into l;
  end if;
  return l;
end $$;

-- Borrado lógico: los pedidos históricos conservan el anuncio al que se refieren.
create or replace function public.delete_listing(p_listing_id text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  l public.listings;
begin
  select * into l from public.listings where id = p_listing_id and deleted_at is null for update;
  if not found then perform lonja_internal.fail('not_found', 'El anuncio no existe o ha sido eliminado.'); end if;
  if l.seller_id <> me then perform lonja_internal.fail('forbidden', 'Solo el propietario puede modificar este anuncio.'); end if;
  if exists (select 1 from public.orders where listing_id = l.id and status = any (lonja_internal.open_statuses())) then
    perform lonja_internal.fail('conflict', 'Este anuncio tiene pedidos o reservas en curso. Complétalos o cancélalos antes de eliminarlo.');
  end if;
  update public.listings set deleted_at = now(), status = 'finished', updated_at = now() where id = l.id;
  delete from public.favorites where listing_id = l.id;
  return l.id;
end $$;

-- Cuenta una visita (no las del propio vendedor). También para invitados.
create or replace function public.register_view(p_listing_id text) returns integer
language sql security definer set search_path = public, pg_temp as $$
  update public.listings set views = views + 1
  where id = p_listing_id and status = 'active' and deleted_at is null and seller_id is distinct from auth.user_id()
  returning views
$$;

-- Añade o quita un favorito. Devuelve true si queda guardado.
create or replace function public.toggle_favorite(p_listing_id text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  l public.listings;
begin
  if exists (select 1 from public.favorites where user_id = me and listing_id = p_listing_id) then
    delete from public.favorites where user_id = me and listing_id = p_listing_id;
    return false;
  end if;
  select * into l from public.listings where id = p_listing_id and deleted_at is null;
  if not found then perform lonja_internal.fail('not_found', 'El anuncio ya no está disponible.'); end if;
  if l.seller_id = me then perform lonja_internal.fail('forbidden', 'No puedes guardar tu propio anuncio en favoritos.'); end if;
  insert into public.favorites (user_id, listing_id) values (me, p_listing_id) on conflict do nothing;
  return true;
end $$;

-- Envía un mensaje. La conversación se identifica por anuncio + comprador.
create or replace function public.send_message(p_listing_id text, p_receiver_id text, p_content text) returns public.messages
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  v_text text := trim(coalesce(p_content, ''));
  l public.listings;
  receiver public.profiles;
  v_buyer text;
  v_conversation text;
  result public.messages;
begin
  if v_text = '' then perform lonja_internal.fail('validation', 'Escribe un mensaje.'); end if;
  if char_length(v_text) > 1000 then perform lonja_internal.fail('validation', 'El mensaje no puede superar los 1000 caracteres.'); end if;
  select * into l from public.listings where id = p_listing_id;
  if not found then perform lonja_internal.fail('not_found', 'El anuncio asociado no existe.'); end if;
  if p_receiver_id = me then perform lonja_internal.fail('forbidden', 'No puedes enviarte mensajes a ti mismo.'); end if;
  select * into receiver from public.profiles where id = p_receiver_id;
  if not found then perform lonja_internal.fail('not_found', 'Destinatario no encontrado.'); end if;
  if l.seller_id not in (me, p_receiver_id) then perform lonja_internal.fail('forbidden', 'Solo puedes escribir al vendedor de este anuncio.'); end if;
  v_buyer := case when l.seller_id = me then p_receiver_id else me end;
  v_conversation := 'conv_' || l.id || '_' || v_buyer;
  if not exists (select 1 from public.messages where conversation_id = v_conversation)
     and receiver.preferences -> 'privacy' ->> 'allowMessagesFrom' = 'nobody' then
    perform lonja_internal.fail('forbidden', 'Este usuario no acepta mensajes nuevos.');
  end if;
  insert into public.messages (conversation_id, listing_id, sender_id, receiver_id, content)
    values (v_conversation, l.id, me, p_receiver_id, v_text)
    returning * into result;
  return result;
end $$;

create or replace function public.mark_conversation_read(p_conversation_id text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare me text := lonja_internal.require_user();
begin
  update public.messages set read = true where conversation_id = p_conversation_id and receiver_id = me and not read;
  return true;
end $$;

-- Valoración del comprador tras una operación completada.
create or replace function public.create_review(p_order_id text, p_rating integer, p_comment text default '') returns public.reviews
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me text := lonja_internal.require_user();
  o public.orders;
  result public.reviews;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or o.buyer_id <> me then perform lonja_internal.fail('forbidden', 'Solo el comprador puede valorar este pedido.'); end if;
  if o.status <> 'completed' then perform lonja_internal.fail('invalid_state', 'Solo se pueden valorar operaciones completadas.'); end if;
  if exists (select 1 from public.reviews where order_id = p_order_id and reviewer_id = me) then
    perform lonja_internal.fail('duplicate', 'Ya has valorado esta operación.');
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then perform lonja_internal.fail('validation', 'Selecciona una puntuación de 1 a 5 estrellas.'); end if;
  insert into public.reviews (order_id, listing_id, reviewer_id, reviewee_id, rating, comment)
    values (o.id, o.listing_id, me, o.seller_id, p_rating, left(trim(coalesce(p_comment, '')), 500))
    returning * into result;
  return result;
end $$;

-- -----------------------------------------------------------------------------
-- Carga de datos de prueba (solo el propietario: no se expone en la Data API)
-- -----------------------------------------------------------------------------
-- payload: JSON generado por «node db/build-seed.mjs --json». Los usuarios de
-- prueba (u1…u5) se traducen a sus ids reales de Neon Auth por el correo.
-- ⚠️ Vacía las tablas de la marketplace antes de cargar los datos de prueba.
create or replace function lonja_internal.load_seed(payload jsonb) returns text
language plpgsql as $$
declare
  ids jsonb;
begin
  select jsonb_object_agg(m ->> 'legacyId', a.id::text) into ids
    from jsonb_array_elements(payload -> 'accounts') m
    join neon_auth."user" a on lower(a.email) = lower(m ->> 'email');
  if ids is null or (select count(*) from jsonb_object_keys(ids)) <> jsonb_array_length(payload -> 'accounts') then
    raise exception 'Faltan cuentas de prueba en Neon Auth. Ejecuta antes: node db/create-demo-accounts.mjs';
  end if;

  truncate public.reports, public.reviews, public.messages, public.favorites, public.orders,
    public.listings, public.profile_private, public.profiles;

  insert into public.profiles (id, username, display_name, first_name, last_name, avatar, bio, public_location, preferences, is_demo, created_at)
    select ids ->> x.legacy, x.username, x.display_name, x.first_name, x.last_name, x.avatar, x.bio, x.public_location, x.preferences, true, x.created_at
    from jsonb_to_recordset(payload -> 'profiles') as x(legacy text, username text, display_name text, first_name text, last_name text,
      avatar text, bio text, public_location text, preferences jsonb, created_at timestamptz);

  insert into public.profile_private (user_id, email, phone, birth_date, country, city, address)
    select ids ->> x.legacy, x.email, x.phone, x.birth_date, x.country, x.city, x.address
    from jsonb_to_recordset(payload -> 'profiles') as x(legacy text, email text, phone text, birth_date text, country text, city text, address text);

  insert into public.listings (id, seller_id, title, description, category, subcategory, operation_type, price, currency, rental, condition,
      brand, model, availability, delivery_notes, attributes, custom_attributes, images, location, delivery, status, featured, views,
      price_history, created_at, updated_at)
    select x.id, ids ->> x.seller, x.title, x.description, x.category, x.subcategory, x.operation_type, x.price, x.currency, x.rental, x.condition,
      x.brand, x.model, x.availability, x.delivery_notes, x.attributes, x.custom_attributes, x.images, x.location, x.delivery, x.status,
      x.featured, x.views, x.price_history, x.created_at, x.updated_at
    from jsonb_to_recordset(payload -> 'listings') as x(id text, seller text, title text, description text, category text, subcategory text,
      operation_type text, price numeric, currency text, rental jsonb, condition text, brand text, model text, availability text,
      delivery_notes text, attributes jsonb, custom_attributes jsonb, images jsonb, location jsonb, delivery jsonb, status text,
      featured boolean, views integer, price_history jsonb, created_at timestamptz, updated_at timestamptz);

  insert into public.orders (id, listing_id, buyer_id, seller_id, operation_type, amount, currency, units, start_date, end_date, status,
      delivery, status_history, created_at, updated_at)
    select x.id, x.listing_id, ids ->> x.buyer, ids ->> x.seller, x.operation_type, x.amount, x.currency, x.units, x.start_date, x.end_date,
      x.status, x.delivery,
      (select jsonb_agg(h || jsonb_build_object('by', ids ->> (h ->> 'by'))) from jsonb_array_elements(x.status_history) h),
      x.created_at, x.updated_at
    from jsonb_to_recordset(payload -> 'orders') as x(id text, listing_id text, buyer text, seller text, operation_type text, amount numeric,
      currency text, units integer, start_date text, end_date text, status text, delivery jsonb, status_history jsonb,
      created_at timestamptz, updated_at timestamptz);

  insert into public.favorites (id, user_id, listing_id, created_at)
    select x.id, ids ->> x.owner, x.listing_id, x.created_at
    from jsonb_to_recordset(payload -> 'favorites') as x(id text, owner text, listing_id text, created_at timestamptz);

  insert into public.messages (id, conversation_id, listing_id, sender_id, receiver_id, content, created_at, read)
    select x.id, 'conv_' || x.listing_id || '_' || (ids ->> x.buyer), x.listing_id, ids ->> x.sender, ids ->> x.receiver, x.content,
      x.created_at, x.read
    from jsonb_to_recordset(payload -> 'messages') as x(id text, listing_id text, buyer text, sender text, receiver text, content text,
      created_at timestamptz, read boolean);

  insert into public.reviews (id, order_id, listing_id, reviewer_id, reviewee_id, rating, comment, created_at)
    select x.id, x.order_id, x.listing_id, ids ->> x.reviewer, ids ->> x.reviewee, x.rating, x.comment, x.created_at
    from jsonb_to_recordset(payload -> 'reviews') as x(id text, order_id text, listing_id text, reviewer text, reviewee text, rating integer,
      comment text, created_at timestamptz);

  return format('%s perfiles, %s anuncios, %s pedidos, %s favoritos, %s mensajes y %s valoraciones cargados.',
    (select count(*) from public.profiles), (select count(*) from public.listings), (select count(*) from public.orders),
    (select count(*) from public.favorites), (select count(*) from public.messages), (select count(*) from public.reviews));
end $$;
revoke execute on function lonja_internal.load_seed(jsonb) from public;

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profile_private enable row level security;
alter table public.listings enable row level security;
alter table public.orders enable row level security;
alter table public.favorites enable row level security;
alter table public.messages enable row level security;
alter table public.reviews enable row level security;
alter table public.reports enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to anonymous, authenticated using (true);
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = auth.user_id());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.user_id()) with check (id = auth.user_id());

drop policy if exists profile_private_own on public.profile_private;
create policy profile_private_own on public.profile_private for all to authenticated
  using (user_id = auth.user_id()) with check (user_id = auth.user_id());

-- Borradores y anuncios en revisión: solo los ve su dueño.
drop policy if exists listings_read on public.listings;
create policy listings_read on public.listings for select to anonymous, authenticated
  using (status not in ('draft', 'pending_review') or seller_id = auth.user_id());
drop policy if exists listings_insert_own on public.listings;
create policy listings_insert_own on public.listings for insert to authenticated with check (seller_id = auth.user_id());
drop policy if exists listings_update_own on public.listings;
create policy listings_update_own on public.listings for update to authenticated
  using (seller_id = auth.user_id() and deleted_at is null) with check (seller_id = auth.user_id());

drop policy if exists orders_participants on public.orders;
create policy orders_participants on public.orders for select to authenticated
  using (buyer_id = auth.user_id() or seller_id = auth.user_id());

drop policy if exists favorites_own on public.favorites;
create policy favorites_own on public.favorites for select to authenticated using (user_id = auth.user_id());

drop policy if exists messages_participants on public.messages;
create policy messages_participants on public.messages for select to authenticated
  using (sender_id = auth.user_id() or receiver_id = auth.user_id());

drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews for select to anonymous, authenticated using (true);

drop policy if exists reports_own_read on public.reports;
create policy reports_own_read on public.reports for select to authenticated using (user_id = auth.user_id());
drop policy if exists reports_own_insert on public.reports;
create policy reports_own_insert on public.reports for insert to authenticated with check (user_id = auth.user_id());

-- -----------------------------------------------------------------------------
-- Permisos (GRANT)
-- -----------------------------------------------------------------------------

grant usage on schema public to anonymous, authenticated;
grant usage on schema lonja_internal to anonymous, authenticated; -- necesario para los disparadores
-- (No hace falta dar acceso al esquema «auth»: los disparadores usan lonja_internal.current_user_id().)

revoke all on public.profiles, public.profile_private, public.listings, public.orders, public.favorites,
  public.messages, public.reviews, public.reports, public.listing_reservations, public.listing_favorite_counts
  from anonymous, authenticated;

grant select on public.profiles, public.listings, public.reviews, public.listing_reservations, public.listing_favorite_counts
  to anonymous, authenticated;
grant insert, update on public.profiles to authenticated;
grant select, insert, update on public.profile_private to authenticated;
grant insert, update on public.listings to authenticated;
grant select on public.orders, public.favorites, public.messages, public.reports to authenticated;
grant insert on public.reports to authenticated;

-- Las funciones de negocio no se pueden llamar sin sesión (salvo contar visitas).
revoke execute on function
  public.create_order(text, text, text, text, text), public.update_order_status(text, text),
  public.set_listing_status(text, text), public.publish_listing(text), public.delete_listing(text),
  public.register_view(text), public.toggle_favorite(text), public.send_message(text, text, text),
  public.mark_conversation_read(text), public.create_review(text, integer, text)
  from public;
grant execute on function
  public.create_order(text, text, text, text, text), public.update_order_status(text, text),
  public.set_listing_status(text, text), public.publish_listing(text), public.delete_listing(text),
  public.register_view(text), public.toggle_favorite(text), public.send_message(text, text, text),
  public.mark_conversation_read(text), public.create_review(text, integer, text)
  to authenticated;
grant execute on function public.register_view(text) to anonymous;

commit;
