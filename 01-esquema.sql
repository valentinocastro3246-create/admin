-- =====================================================================
-- VERSIÓN COMPLETA — ESQUEMA DE BASE DE DATOS (Supabase / PostgreSQL)
-- =====================================================================
-- CÓMO USARLO:
--   Supabase > SQL Editor > "New query" > pegá TODO este archivo > Run.
--   Se puede ejecutar más de una vez sin romper nada.
--
-- QUÉ CREA: negocio, categorías, productos (con stock), pedidos, caja,
-- movimientos de stock, seguridad (solo el administrador toca los datos
-- internos) y las funciones que hacen los pedidos de forma segura.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLAS
-- ---------------------------------------------------------------------

create table if not exists public.negocio (
  id int primary key default 1 check (id = 1),          -- siempre una sola fila
  nombre text not null default 'Mi Negocio',
  eslogan text not null default '',
  ciudad text not null default '',
  emoji text not null default '🛍️',
  whatsapp text not null default '',
  alias_transferencia text not null default '',
  instagram text not null default '',
  direccion text not null default '',
  logo_url text not null default '',
  tema jsonb not null default '{"colorPrincipal":"#ff7a00","colorTextoBoton":"#ffffff","colorFondo":"#0f0f0f","colorSuperficie":"#151515","colorTexto":"#ffffff","colorTextoSuave":"#aaaaaa"}',
  horarios jsonb not null default '{"lunes":"09:00 - 18:00","martes":"09:00 - 18:00","miercoles":"09:00 - 18:00","jueves":"09:00 - 18:00","viernes":"09:00 - 18:00","sabado":"09:00 - 13:00","domingo":"CERRADO"}',
  cierre_activo boolean not null default false,
  cierre_mensaje text not null default 'Estamos cerrados temporalmente. ¡Volvemos pronto!',
  permite_retiro boolean not null default true,
  permite_envio boolean not null default true,
  permite_mesa boolean not null default false,
  envio_costo numeric(12,2) not null default 0,
  envio_gratis_desde numeric(12,2) not null default 0,
  envio_minimo numeric(12,2) not null default 0,
  acepta_efectivo boolean not null default true,
  acepta_transferencia boolean not null default true,
  acepta_mercadopago boolean not null default false,
  actualizado_at timestamptz not null default now()
);
insert into public.negocio (id) values (1) on conflict (id) do nothing;

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  creado_at timestamptz not null default now()
);

create table if not exists public.categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  emoji text not null default '',
  orden int not null default 0,
  visible boolean not null default true,
  creado_at timestamptz not null default now()
);

create table if not exists public.productos (
  id uuid primary key default gen_random_uuid(),
  categoria_id uuid references public.categorias(id) on delete set null,
  nombre text not null,
  descripcion text not null default '',
  precio numeric(12,2) not null check (precio >= 0),
  imagen_url text not null default '',
  etiqueta text not null default '',
  visible boolean not null default true,
  controla_stock boolean not null default false,
  stock int not null default 0 check (stock >= 0),
  stock_minimo int not null default 0,
  extras jsonb not null default '[]',        -- [{"nombre":"Bacon","precio":1500}]
  quitables jsonb not null default '[]',     -- ["Lechuga","Tomate"]
  orden int not null default 0,
  creado_at timestamptz not null default now()
);

create table if not exists public.pedidos (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  creado_at timestamptz not null default now(),
  cliente_nombre text not null,
  cliente_telefono text not null default '',
  tipo_entrega text not null check (tipo_entrega in ('retiro','envio','mesa')),
  direccion text not null default '',
  mesa text not null default '',
  notas text not null default '',
  metodo_pago text not null check (metodo_pago in ('efectivo','transferencia','mercadopago')),
  subtotal numeric(12,2) not null default 0,
  envio numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  estado text not null default 'pendiente'
    check (estado in ('pendiente','confirmado','preparando','listo','entregado','cancelado')),
  pago_estado text not null default 'pendiente'
    check (pago_estado in ('pendiente','pagado','reembolsado')),
  pagado_at timestamptz,
  mp_preference_id text,
  mp_payment_id text,
  mp_estado text,
  stock_descontado boolean not null default false,
  origen text not null default 'web' check (origen in ('web','mostrador'))
);
-- (si la tabla ya existía de una versión anterior)
alter table public.pedidos add column if not exists origen text not null default 'web';
create index if not exists pedidos_creado_idx on public.pedidos (creado_at desc);
create index if not exists pedidos_estado_idx on public.pedidos (estado);
create index if not exists pedidos_pagado_idx on public.pedidos (pagado_at);

create table if not exists public.pedido_items (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  producto_id uuid references public.productos(id) on delete set null,
  nombre text not null,
  precio_unitario numeric(12,2) not null,    -- ya incluye los extras
  cantidad int not null check (cantidad > 0),
  extras jsonb not null default '[]',
  quitar jsonb not null default '[]',
  nota text not null default ''
);
create index if not exists pedido_items_pedido_idx on public.pedido_items (pedido_id);

create table if not exists public.movimientos_stock (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references public.productos(id) on delete cascade,
  delta int not null,
  motivo text not null,                       -- venta, cancelacion, reposicion, ajuste
  pedido_id uuid references public.pedidos(id) on delete set null,
  nota text not null default '',
  creado_at timestamptz not null default now()
);
create index if not exists mov_stock_prod_idx on public.movimientos_stock (producto_id, creado_at desc);

create table if not exists public.caja_turnos (
  id uuid primary key default gen_random_uuid(),
  abierto_at timestamptz not null default now(),
  cerrado_at timestamptz,
  monto_inicial numeric(12,2) not null default 0,
  monto_contado numeric(12,2),
  esperado_efectivo numeric(12,2),
  diferencia numeric(12,2),
  resumen jsonb,
  notas text not null default '',
  estado text not null default 'abierta' check (estado in ('abierta','cerrada'))
);
-- Solo puede haber UNA caja abierta a la vez
create unique index if not exists una_sola_caja_abierta
  on public.caja_turnos (estado) where estado = 'abierta';

create table if not exists public.caja_movimientos (
  id uuid primary key default gen_random_uuid(),
  turno_id uuid not null references public.caja_turnos(id) on delete cascade,
  tipo text not null check (tipo in ('ingreso','egreso')),
  concepto text not null,
  monto numeric(12,2) not null check (monto > 0),
  creado_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 2. SEGURIDAD
-- ---------------------------------------------------------------------

create or replace function public.es_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.negocio           enable row level security;
alter table public.admins            enable row level security;   -- sin políticas: nadie la lee desde la web
alter table public.categorias        enable row level security;
alter table public.productos         enable row level security;
alter table public.pedidos           enable row level security;
alter table public.pedido_items      enable row level security;
alter table public.movimientos_stock enable row level security;
alter table public.caja_turnos       enable row level security;
alter table public.caja_movimientos  enable row level security;

-- Lectura pública: datos del negocio, categorías y productos visibles
drop policy if exists negocio_lectura on public.negocio;
create policy negocio_lectura on public.negocio for select to anon, authenticated using (true);

drop policy if exists categorias_lectura on public.categorias;
create policy categorias_lectura on public.categorias for select to anon, authenticated using (visible);

drop policy if exists productos_lectura on public.productos;
create policy productos_lectura on public.productos for select to anon, authenticated using (visible);

-- El administrador puede hacer todo
do $$
declare t text;
begin
  foreach t in array array['negocio','categorias','productos','pedidos','pedido_items',
                           'movimientos_stock','caja_turnos','caja_movimientos']
  loop
    execute format('drop policy if exists admin_todo on public.%I', t);
    execute format(
      'create policy admin_todo on public.%I for all to authenticated
         using (public.es_admin()) with check (public.es_admin())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2b. PERMISOS DE LA API (obligatorios en los proyectos nuevos de Supabase)
--     Desde mayo de 2026 Supabase ya NO habilita automáticamente el acceso a
--     las tablas nuevas: hay que concederlo de forma explícita. Estos permisos
--     abren la puerta; las reglas de seguridad (RLS) de más arriba deciden
--     QUÉ filas puede ver o cambiar cada uno.
-- ---------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

-- Visitantes (la tienda): solo leer lo público
grant select on public.negocio, public.categorias, public.productos to anon, authenticated;

-- Administrador con sesión iniciada (el panel): las políticas exigen es_admin()
grant select, insert, update, delete on
  public.negocio, public.categorias, public.productos, public.pedidos, public.pedido_items,
  public.movimientos_stock, public.caja_turnos, public.caja_movimientos
  to authenticated;

-- La tabla "admins" no se concede a nadie desde la web (solo la leen las funciones internas)

-- Funciones del servidor (crear-pedido y webhook-mp)
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Cualquiera puede preguntar "¿soy administrador?" (devuelve falso si no)
grant execute on function public.es_admin() to anon, authenticated, service_role;


-- Imágenes (productos, logo): lectura pública, escritura solo del administrador
insert into storage.buckets (id, name, public)
values ('imagenes', 'imagenes', true)
on conflict (id) do nothing;

drop policy if exists imagenes_lectura on storage.objects;
create policy imagenes_lectura on storage.objects for select using (bucket_id = 'imagenes');

drop policy if exists imagenes_admin_insert on storage.objects;
create policy imagenes_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'imagenes' and public.es_admin());

drop policy if exists imagenes_admin_update on storage.objects;
create policy imagenes_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'imagenes' and public.es_admin());

drop policy if exists imagenes_admin_delete on storage.objects;
create policy imagenes_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'imagenes' and public.es_admin());

-- Pedidos en tiempo real para el panel
do $$
begin
  alter publication supabase_realtime add table public.pedidos;
exception when duplicate_object then null;
end $$;


-- ---------------------------------------------------------------------
-- 3. LÓGICA DE PEDIDOS
--    Solo la usa el servidor (funciones "crear-pedido" y "webhook-mp").
--    Los precios y el stock SIEMPRE se leen de acá, nunca del navegador.
-- ---------------------------------------------------------------------

create or replace function public.crear_pedido(
  p_nombre text, p_telefono text, p_tipo_entrega text, p_direccion text,
  p_mesa text, p_notas text, p_metodo_pago text, p_items jsonb,
  p_mostrador boolean default false      -- true = venta cargada por el administrador en el local
)
returns public.pedidos
language plpgsql security definer set search_path = public
as $$
declare
  n public.negocio%rowtype;
  v_ped public.pedidos%rowtype;
  v_item jsonb;
  v_prod public.productos%rowtype;
  v_cant int;
  v_unit numeric;
  v_extras jsonb;
  v_quitar jsonb;
  v_txt text;
  v_def jsonb;
  v_subtotal numeric := 0;
  v_envio numeric := 0;
begin
  select * into n from public.negocio where id = 1;

  if n.cierre_activo and not p_mostrador then raise exception 'NEGOCIO_CERRADO'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'DATOS_INVALIDOS:nombre'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'DATOS_INVALIDOS:items';
  end if;

  if not p_mostrador then
    if p_tipo_entrega = 'retiro' and not n.permite_retiro then raise exception 'ENTREGA_NO_DISPONIBLE'; end if;
    if p_tipo_entrega = 'envio'  and not n.permite_envio  then raise exception 'ENTREGA_NO_DISPONIBLE'; end if;
    if p_tipo_entrega = 'mesa'   and not n.permite_mesa   then raise exception 'ENTREGA_NO_DISPONIBLE'; end if;
  end if;
  if p_tipo_entrega = 'envio' and coalesce(trim(p_direccion), '') = '' then raise exception 'DATOS_INVALIDOS:direccion'; end if;
  if p_tipo_entrega = 'mesa'  and coalesce(trim(p_mesa), '') = ''      then raise exception 'DATOS_INVALIDOS:mesa'; end if;

  if not p_mostrador then
    if p_metodo_pago = 'efectivo'      and not n.acepta_efectivo      then raise exception 'PAGO_NO_DISPONIBLE'; end if;
    if p_metodo_pago = 'transferencia' and not n.acepta_transferencia then raise exception 'PAGO_NO_DISPONIBLE'; end if;
    if p_metodo_pago = 'mercadopago'   and not n.acepta_mercadopago   then raise exception 'PAGO_NO_DISPONIBLE'; end if;
  end if;

  insert into public.pedidos (
    cliente_nombre, cliente_telefono, tipo_entrega, direccion, mesa, notas,
    metodo_pago, stock_descontado, origen
  ) values (
    left(trim(p_nombre), 80), left(coalesce(p_telefono, ''), 30), p_tipo_entrega,
    left(coalesce(p_direccion, ''), 200), left(coalesce(p_mesa, ''), 20),
    left(coalesce(p_notas, ''), 500), p_metodo_pago, true,
    case when p_mostrador then 'mostrador' else 'web' end
  ) returning * into v_ped;

  -- Se recorren los productos en orden fijo para evitar bloqueos entre pedidos simultáneos
  for v_item in
    select value from jsonb_array_elements(p_items) order by value->>'producto_id'
  loop
    v_cant := coalesce((v_item->>'cantidad')::int, 0);
    if v_cant < 1 or v_cant > 50 then raise exception 'DATOS_INVALIDOS:cantidad'; end if;

    select * into v_prod
      from public.productos
     where id = (v_item->>'producto_id')::uuid and visible
       for update;
    if not found then raise exception 'PRODUCTO_NO_DISPONIBLE'; end if;

    if v_prod.controla_stock and v_prod.stock < v_cant then
      raise exception 'SIN_STOCK:%', v_prod.nombre;
    end if;

    v_unit := v_prod.precio;
    v_extras := '[]'::jsonb;
    v_quitar := '[]'::jsonb;

    for v_txt in select jsonb_array_elements_text(coalesce(v_item->'extras', '[]'::jsonb)) loop
      v_def := null;
      select e into v_def
        from jsonb_array_elements(v_prod.extras) e
       where e->>'nombre' = v_txt
       limit 1;
      if v_def is null then raise exception 'EXTRA_INVALIDO:%', v_txt; end if;
      v_unit := v_unit + coalesce((v_def->>'precio')::numeric, 0);
      v_extras := v_extras || jsonb_build_array(
        jsonb_build_object('nombre', v_txt, 'precio', coalesce((v_def->>'precio')::numeric, 0)));
    end loop;

    for v_txt in select jsonb_array_elements_text(coalesce(v_item->'quitar', '[]'::jsonb)) loop
      if not exists (select 1 from jsonb_array_elements_text(v_prod.quitables) q where q = v_txt) then
        raise exception 'QUITAR_INVALIDO:%', v_txt;
      end if;
      v_quitar := v_quitar || to_jsonb(v_txt);
    end loop;

    insert into public.pedido_items (pedido_id, producto_id, nombre, precio_unitario, cantidad, extras, quitar, nota)
    values (v_ped.id, v_prod.id, v_prod.nombre, v_unit, v_cant, v_extras, v_quitar,
            left(coalesce(v_item->>'nota', ''), 200));

    v_subtotal := v_subtotal + v_unit * v_cant;

    if v_prod.controla_stock then
      update public.productos set stock = stock - v_cant where id = v_prod.id;
      insert into public.movimientos_stock (producto_id, delta, motivo, pedido_id)
      values (v_prod.id, -v_cant, 'venta', v_ped.id);
    end if;
  end loop;

  if p_tipo_entrega = 'envio' then
    if n.envio_minimo > 0 and v_subtotal < n.envio_minimo then
      raise exception 'MINIMO_NO_ALCANZADO:%', n.envio_minimo;
    end if;
    if n.envio_costo > 0 and not (n.envio_gratis_desde > 0 and v_subtotal >= n.envio_gratis_desde) then
      v_envio := n.envio_costo;
    end if;
  end if;

  update public.pedidos
     set subtotal = v_subtotal, envio = v_envio, total = v_subtotal + v_envio
   where id = v_ped.id
   returning * into v_ped;

  return v_ped;
end;
$$;

-- Cancela un pedido y devuelve el stock (uso interno del servidor)
create or replace function public.cancelar_pedido_interno(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ped public.pedidos%rowtype;
  v_it record;
begin
  select * into v_ped from public.pedidos where id = p_id for update;
  if not found then raise exception 'PEDIDO_NO_ENCONTRADO'; end if;
  if v_ped.estado = 'cancelado' then return; end if;

  if v_ped.stock_descontado then
    for v_it in
      select it.producto_id, it.cantidad
        from public.pedido_items it
        join public.productos p on p.id = it.producto_id
       where it.pedido_id = p_id and p.controla_stock
    loop
      update public.productos set stock = stock + v_it.cantidad where id = v_it.producto_id;
      insert into public.movimientos_stock (producto_id, delta, motivo, pedido_id)
      values (v_it.producto_id, v_it.cantidad, 'cancelacion', p_id);
    end loop;
  end if;

  update public.pedidos set estado = 'cancelado', stock_descontado = false where id = p_id;
end;
$$;

-- Cancela los pedidos de Mercado Pago que nadie pagó (libera el stock reservado)
create or replace function public.liberar_vencidos_interno(p_minutos int default 30)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_n int := 0;
begin
  for v_id in
    select id from public.pedidos
     where metodo_pago = 'mercadopago'
       and pago_estado = 'pendiente'
       and estado <> 'cancelado'
       and creado_at < now() - make_interval(mins => p_minutos)
  loop
    perform public.cancelar_pedido_interno(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Registra el resultado de un pago de Mercado Pago (lo llama el webhook)
create or replace function public.actualizar_pago_mp(
  p_pedido uuid, p_payment_id text, p_status text, p_monto numeric
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ped public.pedidos%rowtype;
begin
  select * into v_ped from public.pedidos where id = p_pedido for update;
  if not found then raise exception 'PEDIDO_NO_ENCONTRADO'; end if;

  if p_status = 'approved' then
    if p_monto + 0.01 >= v_ped.total then
      update public.pedidos
         set pago_estado = 'pagado',
             pagado_at = coalesce(pagado_at, now()),
             metodo_pago = 'mercadopago',
             mp_payment_id = p_payment_id,
             mp_estado = p_status,
             estado = case when estado = 'pendiente' then 'confirmado' else estado end
       where id = p_pedido;
    else
      update public.pedidos
         set mp_payment_id = p_payment_id, mp_estado = 'monto_incorrecto'
       where id = p_pedido;
    end if;
  elsif p_status in ('refunded', 'charged_back') then
    update public.pedidos
       set pago_estado = 'reembolsado', mp_payment_id = p_payment_id, mp_estado = p_status
     where id = p_pedido;
  else
    update public.pedidos
       set mp_payment_id = p_payment_id, mp_estado = p_status
     where id = p_pedido;
  end if;
end;
$$;

-- Solo el servidor puede ejecutar estas funciones
revoke all on function public.crear_pedido(text,text,text,text,text,text,text,jsonb,boolean) from public, anon, authenticated;
revoke all on function public.cancelar_pedido_interno(uuid)                          from public, anon, authenticated;
revoke all on function public.liberar_vencidos_interno(int)                          from public, anon, authenticated;
revoke all on function public.actualizar_pago_mp(uuid,text,text,numeric)             from public, anon, authenticated;
grant execute on function public.crear_pedido(text,text,text,text,text,text,text,jsonb,boolean) to service_role;
grant execute on function public.cancelar_pedido_interno(uuid)                          to service_role;
grant execute on function public.liberar_vencidos_interno(int)                          to service_role;
grant execute on function public.actualizar_pago_mp(uuid,text,text,numeric)             to service_role;


-- ---------------------------------------------------------------------
-- 4. FUNCIONES DEL PANEL DE ADMINISTRACIÓN (verifican que seas admin)
-- ---------------------------------------------------------------------

create or replace function public.admin_cancelar_pedido(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.es_admin() then raise exception 'NO_AUTORIZADO'; end if;
  perform public.cancelar_pedido_interno(p_id);
end;
$$;

create or replace function public.admin_liberar_vencidos(p_minutos int default 30)
returns int
language plpgsql security definer set search_path = public
as $$
begin
  if not public.es_admin() then raise exception 'NO_AUTORIZADO'; end if;
  return public.liberar_vencidos_interno(p_minutos);
end;
$$;

create or replace function public.admin_ajustar_stock(
  p_producto uuid, p_delta int, p_motivo text default 'ajuste', p_nota text default ''
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_stock int;
begin
  if not public.es_admin() then raise exception 'NO_AUTORIZADO'; end if;

  update public.productos
     set stock = stock + p_delta
   where id = p_producto and stock + p_delta >= 0
   returning stock into v_stock;
  if not found then raise exception 'STOCK_NEGATIVO'; end if;

  insert into public.movimientos_stock (producto_id, delta, motivo, nota)
  values (p_producto, p_delta, coalesce(nullif(p_motivo, ''), 'ajuste'), coalesce(p_nota, ''));

  return v_stock;
end;
$$;

-- Resumen de una caja (abierta o cerrada): ventas cobradas por método y efectivo esperado
create or replace function public.admin_resumen_caja(p_turno uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  t public.caja_turnos%rowtype;
  v_hasta timestamptz;
  v_ef numeric; v_tr numeric; v_mp numeric; v_cant int;
  v_ing numeric; v_egr numeric;
begin
  if not public.es_admin() then raise exception 'NO_AUTORIZADO'; end if;

  select * into t from public.caja_turnos where id = p_turno;
  if not found then raise exception 'CAJA_NO_ENCONTRADA'; end if;
  v_hasta := coalesce(t.cerrado_at, now());

  select coalesce(sum(total) filter (where metodo_pago = 'efectivo'), 0),
         coalesce(sum(total) filter (where metodo_pago = 'transferencia'), 0),
         coalesce(sum(total) filter (where metodo_pago = 'mercadopago'), 0),
         count(*)
    into v_ef, v_tr, v_mp, v_cant
    from public.pedidos
   where pago_estado = 'pagado' and estado <> 'cancelado'
     and pagado_at >= t.abierto_at and pagado_at <= v_hasta;

  select coalesce(sum(monto) filter (where tipo = 'ingreso'), 0),
         coalesce(sum(monto) filter (where tipo = 'egreso'), 0)
    into v_ing, v_egr
    from public.caja_movimientos where turno_id = p_turno;

  return jsonb_build_object(
    'inicial', t.monto_inicial,
    'efectivo', v_ef, 'transferencia', v_tr, 'mercadopago', v_mp,
    'total', v_ef + v_tr + v_mp, 'cantidad', v_cant,
    'ingresos', v_ing, 'egresos', v_egr,
    'esperado_efectivo', t.monto_inicial + v_ef + v_ing - v_egr
  );
end;
$$;

create or replace function public.admin_cerrar_caja(p_turno uuid, p_contado numeric, p_notas text default '')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_res jsonb;
  v_esperado numeric;
begin
  if not public.es_admin() then raise exception 'NO_AUTORIZADO'; end if;

  update public.caja_turnos
     set cerrado_at = now(), estado = 'cerrada'
   where id = p_turno and estado = 'abierta';
  if not found then raise exception 'CAJA_NO_ABIERTA'; end if;

  v_res := public.admin_resumen_caja(p_turno);
  v_esperado := (v_res->>'esperado_efectivo')::numeric;

  update public.caja_turnos
     set resumen = v_res,
         monto_contado = p_contado,
         esperado_efectivo = v_esperado,
         diferencia = p_contado - v_esperado,
         notas = coalesce(p_notas, '')
   where id = p_turno;

  return v_res || jsonb_build_object('contado', p_contado, 'diferencia', p_contado - v_esperado);
end;
$$;

-- Venta cargada en el mostrador: descuenta stock, queda cobrada y entregada
create or replace function public.admin_venta_mostrador(
  p_items jsonb, p_metodo text, p_nombre text default ''
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ped public.pedidos%rowtype;
begin
  if not public.es_admin() then raise exception 'NO_AUTORIZADO'; end if;
  if p_metodo not in ('efectivo','transferencia','mercadopago') then
    raise exception 'DATOS_INVALIDOS:metodo_pago';
  end if;

  v_ped := public.crear_pedido(
    coalesce(nullif(trim(p_nombre), ''), 'Mostrador'), '', 'retiro', '', '', '',
    p_metodo, p_items, true
  );

  update public.pedidos
     set estado = 'entregado', pago_estado = 'pagado', pagado_at = now()
   where id = v_ped.id
   returning * into v_ped;

  return jsonb_build_object('id', v_ped.id, 'numero', v_ped.numero, 'total', v_ped.total);
end;
$$;

revoke all on function public.admin_cancelar_pedido(uuid)                      from public, anon;
revoke all on function public.admin_liberar_vencidos(int)                      from public, anon;
revoke all on function public.admin_ajustar_stock(uuid,int,text,text)          from public, anon;
revoke all on function public.admin_resumen_caja(uuid)                         from public, anon;
revoke all on function public.admin_cerrar_caja(uuid,numeric,text)             from public, anon;
revoke all on function public.admin_venta_mostrador(jsonb,text,text)           from public, anon;
grant execute on function public.admin_venta_mostrador(jsonb,text,text)        to authenticated;
grant execute on function public.admin_cancelar_pedido(uuid)                   to authenticated;
grant execute on function public.admin_liberar_vencidos(int)                   to authenticated;
grant execute on function public.admin_ajustar_stock(uuid,int,text,text)       to authenticated;
grant execute on function public.admin_resumen_caja(uuid)                      to authenticated;
grant execute on function public.admin_cerrar_caja(uuid,numeric,text)          to authenticated;


-- ---------------------------------------------------------------------
-- 5. SEGUIMIENTO PÚBLICO DEL PEDIDO (el cliente solo ve el suyo,
--    con el código largo e imposible de adivinar que recibe al pedir)
-- ---------------------------------------------------------------------

create or replace function public.seguimiento_pedido(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'numero', p.numero,
    'estado', p.estado,
    'pago_estado', p.pago_estado,
    'metodo_pago', p.metodo_pago,
    'tipo_entrega', p.tipo_entrega,
    'subtotal', p.subtotal,
    'envio', p.envio,
    'total', p.total,
    'creado_at', p.creado_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('nombre', i.nombre, 'cantidad', i.cantidad))
        from public.pedido_items i where i.pedido_id = p.id
    ), '[]'::jsonb)
  )
  from public.pedidos p
  where p.id = p_id;
$$;

grant execute on function public.seguimiento_pedido(uuid) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. (OPCIONAL) LIBERAR AUTOMÁTICAMENTE LOS PEDIDOS DE MERCADO PAGO SIN PAGAR
--    Requiere activar la extensión pg_cron (Database > Extensions).
--    Descomentá y ejecutá estas líneas solo si la activaste:
--
--    select cron.schedule('liberar-pedidos-vencidos', '*/10 * * * *',
--                         $$ select public.liberar_vencidos_interno(30) $$);
-- ---------------------------------------------------------------------
