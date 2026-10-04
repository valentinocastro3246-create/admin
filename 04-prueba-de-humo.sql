-- =====================================================================
-- PRUEBA DE HUMO (opcional, pero recomendada en cada instalación nueva)
-- =====================================================================
-- Comprueba, en TU base de datos real, que todo funciona: precios,
-- stock, envío, mínimo, cancelaciones, pagos de Mercado Pago y seguridad.
--
-- CÓMO USARLA:  Supabase > SQL Editor > New query > pegá TODO > Run.
--
-- RESULTADO:
--   * Si todo está bien, vas a ver un mensaje que empieza con
--       "PRUEBA OK"
--     Aparece como error A PROPÓSITO: es la forma de deshacer todos los
--     datos de prueba para que no quede nada en tu negocio.
--   * Si algo falla, el mensaje dice qué fue ("FALLÓ: ...").
--
-- No modifica nada de forma permanente.
-- =====================================================================

do $$
declare
  v_cat uuid;  v_a uuid;  v_b uuid;
  v_p public.pedidos%rowtype;
  v_p2 public.pedidos%rowtype;
  v_stock int;
  v_n int;
  v_ok boolean;
  v_seg jsonb;
begin
  -- ---------- preparación ----------
  update public.negocio set
    cierre_activo = false, permite_retiro = true, permite_envio = true,
    acepta_efectivo = true, acepta_mercadopago = true,
    envio_costo = 1500, envio_gratis_desde = 20000, envio_minimo = 5000
  where id = 1;

  insert into public.categorias (nombre) values ('__PRUEBA__') returning id into v_cat;

  insert into public.productos (categoria_id, nombre, precio, controla_stock, stock, extras, quitables)
  values (v_cat, '__Prueba A__', 5000, true, 3, '[{"nombre":"Extra","precio":1000}]', '["Sal"]')
  returning id into v_a;

  insert into public.productos (categoria_id, nombre, precio, controla_stock, stock)
  values (v_cat, '__Prueba B__', 2000, false, 0)
  returning id into v_b;

  -- ---------- 1) precio calculado en el servidor (con extra) ----------
  v_p := public.crear_pedido('Tester', '', 'retiro', '', '', '', 'efectivo',
    jsonb_build_array(jsonb_build_object('producto_id', v_a, 'cantidad', 2, 'extras', jsonb_build_array('Extra'),
                                         'precio', 1)));   -- el "precio: 1" se ignora a propósito
  if v_p.total <> 12000 then raise exception 'FALLÓ: total esperado 12000, fue %', v_p.total; end if;

  -- ---------- 2) el stock bajó ----------
  select stock into v_stock from public.productos where id = v_a;
  if v_stock <> 1 then raise exception 'FALLÓ: stock esperado 1, fue %', v_stock; end if;

  -- ---------- 3) no deja vender lo que no hay ----------
  begin
    perform public.crear_pedido('Tester', '', 'retiro', '', '', '', 'efectivo',
      jsonb_build_array(jsonb_build_object('producto_id', v_a, 'cantidad', 2)));
    raise exception 'FALLÓ: dejó vender sin stock';
  exception when others then
    if sqlerrm not like 'SIN_STOCK%' then raise exception 'FALLÓ: esperaba SIN_STOCK y fue: %', sqlerrm; end if;
  end;
  select stock into v_stock from public.productos where id = v_a;
  if v_stock <> 1 then raise exception 'FALLÓ: un pedido rechazado cambió el stock (%).', v_stock; end if;

  -- ---------- 4) extra inexistente ----------
  begin
    perform public.crear_pedido('Tester', '', 'retiro', '', '', '', 'efectivo',
      jsonb_build_array(jsonb_build_object('producto_id', v_a, 'cantidad', 1, 'extras', jsonb_build_array('Inventado'))));
    raise exception 'FALLÓ: aceptó un extra que no existe';
  exception when others then
    if sqlerrm not like 'EXTRA_INVALIDO%' then raise exception 'FALLÓ: esperaba EXTRA_INVALIDO y fue: %', sqlerrm; end if;
  end;

  -- ---------- 5) envío: cobra costo, respeta mínimo y envío gratis ----------
  v_p2 := public.crear_pedido('Tester', '', 'envio', 'Calle 1', '', '', 'efectivo',
    jsonb_build_array(jsonb_build_object('producto_id', v_b, 'cantidad', 3)));   -- 6000 + 1500
  if v_p2.total <> 7500 or v_p2.envio <> 1500 then
    raise exception 'FALLÓ: envío esperado 1500 / total 7500, fue % / %', v_p2.envio, v_p2.total;
  end if;

  begin
    perform public.crear_pedido('Tester', '', 'envio', 'Calle 1', '', '', 'efectivo',
      jsonb_build_array(jsonb_build_object('producto_id', v_b, 'cantidad', 1)));   -- 2000 < mínimo 5000
    raise exception 'FALLÓ: ignoró el pedido mínimo';
  exception when others then
    if sqlerrm not like 'MINIMO_NO_ALCANZADO%' then raise exception 'FALLÓ: esperaba MINIMO_NO_ALCANZADO y fue: %', sqlerrm; end if;
  end;

  v_p2 := public.crear_pedido('Tester', '', 'envio', 'Calle 1', '', '', 'efectivo',
    jsonb_build_array(jsonb_build_object('producto_id', v_b, 'cantidad', 11)));    -- 22000 >= gratis desde 20000
  if v_p2.envio <> 0 or v_p2.total <> 22000 then
    raise exception 'FALLÓ: envío gratis esperado (0 / 22000), fue % / %', v_p2.envio, v_p2.total;
  end if;

  -- ---------- 6) cancelar devuelve el stock, y no lo devuelve dos veces ----------
  perform public.cancelar_pedido_interno(v_p.id);
  select stock into v_stock from public.productos where id = v_a;
  if v_stock <> 3 then raise exception 'FALLÓ: al cancelar el stock esperado era 3, fue %', v_stock; end if;
  perform public.cancelar_pedido_interno(v_p.id);
  select stock into v_stock from public.productos where id = v_a;
  if v_stock <> 3 then raise exception 'FALLÓ: cancelar dos veces devolvió stock de más (%)', v_stock; end if;

  -- ---------- 7) Mercado Pago: pago incompleto NO confirma; pago completo SÍ ----------
  v_p := public.crear_pedido('Tester MP', '', 'retiro', '', '', '', 'mercadopago',
    jsonb_build_array(jsonb_build_object('producto_id', v_a, 'cantidad', 1)));       -- 5000, reserva stock
  select stock into v_stock from public.productos where id = v_a;
  if v_stock <> 2 then raise exception 'FALLÓ: el pedido de MP no reservó stock (%)', v_stock; end if;

  perform public.actualizar_pago_mp(v_p.id, '111', 'approved', 100);                  -- monto menor al total
  select (pago_estado = 'pagado') into v_ok from public.pedidos where id = v_p.id;
  if v_ok then raise exception 'FALLÓ: marcó como pagado un pago por menos del total'; end if;

  perform public.actualizar_pago_mp(v_p.id, '112', 'approved', 5000);
  select (pago_estado = 'pagado' and estado = 'confirmado') into v_ok from public.pedidos where id = v_p.id;
  if not v_ok then raise exception 'FALLÓ: un pago aprobado por el total no confirmó el pedido'; end if;

  -- ---------- 8) pedidos de MP sin pagar se liberan a los 30 minutos ----------
  v_p := public.crear_pedido('Tester MP 2', '', 'retiro', '', '', '', 'mercadopago',
    jsonb_build_array(jsonb_build_object('producto_id', v_a, 'cantidad', 1)));
  select stock into v_stock from public.productos where id = v_a;       -- 3 - 1 (pagado) - 1 = 1
  if v_stock <> 1 then raise exception 'FALLÓ: stock esperado 1 antes de liberar, fue %', v_stock; end if;
  v_n := public.liberar_vencidos_interno(30);
  select stock into v_stock from public.productos where id = v_a;
  if v_stock <> 1 then raise exception 'FALLÓ: liberó un pedido que todavía no venció'; end if;
  update public.pedidos set creado_at = now() - interval '45 minutes' where id = v_p.id;
  v_n := public.liberar_vencidos_interno(30);
  select stock into v_stock from public.productos where id = v_a;
  if v_n < 1 or v_stock <> 2 then raise exception 'FALLÓ: no liberó el pedido vencido (liberados %, stock %)', v_n, v_stock; end if;

  -- ---------- 9) seguimiento público ----------
  v_seg := public.seguimiento_pedido(v_p.id);
  if v_seg is null or (v_seg->>'numero') is null then raise exception 'FALLÓ: el seguimiento no devolvió el pedido'; end if;
  if v_seg ? 'cliente_nombre' or v_seg ? 'direccion' then raise exception 'FALLÓ: el seguimiento público muestra datos personales'; end if;

  -- ---------- 10) cierre temporal ----------
  update public.negocio set cierre_activo = true where id = 1;
  begin
    perform public.crear_pedido('Tester', '', 'retiro', '', '', '', 'efectivo',
      jsonb_build_array(jsonb_build_object('producto_id', v_b, 'cantidad', 1)));
    raise exception 'FALLÓ: aceptó un pedido con el negocio cerrado';
  exception when others then
    if sqlerrm not like 'NEGOCIO_CERRADO%' then raise exception 'FALLÓ: esperaba NEGOCIO_CERRADO y fue: %', sqlerrm; end if;
  end;
  update public.negocio set cierre_activo = false where id = 1;

  -- ---------- 11) seguridad: un visitante anónimo no puede ver ni crear pedidos ----------
  if public.es_admin() then raise exception 'FALLÓ: es_admin() dio verdadero sin sesión'; end if;

  set local role anon;
  begin
    perform public.crear_pedido('Hacker', '', 'retiro', '', '', '', 'efectivo',
      jsonb_build_array(jsonb_build_object('producto_id', v_b, 'cantidad', 1)));
    reset role;
    raise exception 'FALLÓ: un visitante pudo ejecutar crear_pedido directamente';
  exception when insufficient_privilege then
    reset role;
  end;

  -- Un visitante no debe poder leer pedidos: o recibe "permiso denegado" o ve 0 filas (ambas son correctas)
  set local role anon;
  begin
    select count(*) into v_n from public.pedidos;
    reset role;
    if v_n <> 0 then raise exception 'FALLÓ: un visitante puede leer % pedido(s)', v_n; end if;
  exception when insufficient_privilege then
    reset role;
  end;

  -- ...pero sí debe poder ver el negocio y los productos (si falla acá, faltan los permisos de la sección 2b)
  set local role anon;
  begin
    select count(*) into v_n from public.negocio;
    if v_n <> 1 then raise exception 'FALLÓ: un visitante no ve los datos del negocio'; end if;
    select count(*) into v_n from public.productos where nombre = '__Prueba A__';
    reset role;
    if v_n <> 1 then raise exception 'FALLÓ: un visitante no puede ver los productos públicos'; end if;
  exception when insufficient_privilege then
    reset role;
    raise exception 'FALLÓ: la tienda no tiene permiso para leer productos. Volvé a ejecutar 01-esquema.sql completo (sección 2b, permisos).';
  end;

  -- Un visitante no puede leer la lista de administradores
  set local role anon;
  begin
    select count(*) into v_n from public.admins;
    reset role;
    if v_n <> 0 then raise exception 'FALLÓ: un visitante puede ver administradores'; end if;
  exception when insufficient_privilege then
    reset role;
  end;

  -- ---------- fin: se deshace todo a propósito ----------
  raise exception 'PRUEBA OK ✅ — todo funciona. (Se muestra como error a propósito para deshacer los datos de prueba; no quedó nada guardado.)';
end;
$$;
