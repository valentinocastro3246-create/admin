// @ts-nocheck
// =====================================================================
// FUNCIÓN: crear-pedido
// Recibe el pedido del cliente, lo guarda (con precios y stock verificados
// en la base de datos) y, si paga con Mercado Pago, crea el link de pago.
//
// Variables (Supabase > Edge Functions > Secrets):
//   MP_ACCESS_TOKEN  Access Token de Mercado Pago del negocio (solo si cobra con MP)
//   SITIO_URL        Dirección pública de la tienda, ej: https://mitienda.com.ar
//   MP_DESCRIPTOR    (opcional) nombre en el resumen de la tarjeta, máx. 22 letras
// SUPABASE_URL y las claves del servidor las agrega Supabase automáticamente.
// =====================================================================

const METODOS = ["efectivo", "transferencia", "mercadopago"];
const ENTREGAS = ["retiro", "envio", "mesa"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- Lógica pura (se prueba sin servidor) ----------

function texto(v, max) {
  return String(v === undefined || v === null ? "" : v).trim().slice(0, max);
}

export function esUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
}

export function validarPedido(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "DATOS_INVALIDOS" };

  const nombre = texto(body.nombre, 80);
  if (!nombre) return { ok: false, error: "DATOS_INVALIDOS:nombre" };
  if (!ENTREGAS.includes(body.tipo_entrega)) return { ok: false, error: "DATOS_INVALIDOS:tipo_entrega" };
  if (!METODOS.includes(body.metodo_pago)) return { ok: false, error: "DATOS_INVALIDOS:metodo_pago" };

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 40) {
    return { ok: false, error: "DATOS_INVALIDOS:items" };
  }

  const items = [];
  for (const it of body.items) {
    const cantidad = Number(it && it.cantidad);
    if (!it || !esUuid(it.producto_id) || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {
      return { ok: false, error: "DATOS_INVALIDOS:items" };
    }
    const lista = (x) => (Array.isArray(x) ? x.slice(0, 30).map((s) => texto(s, 80)).filter(Boolean) : []);
    items.push({
      producto_id: it.producto_id,
      cantidad,
      extras: lista(it.extras),
      quitar: lista(it.quitar),
      nota: texto(it.nota, 200),
    });
  }

  return {
    ok: true,
    datos: {
      p_nombre: nombre,
      p_telefono: texto(body.telefono, 30),
      p_tipo_entrega: body.tipo_entrega,
      p_direccion: texto(body.direccion, 200),
      p_mesa: texto(body.mesa, 20),
      p_notas: texto(body.notas, 500),
      p_metodo_pago: body.metodo_pago,
      p_items: items,
    },
  };
}

// Traduce los errores de la base de datos a mensajes para el cliente
export function traducirError(mensaje) {
  const m = String(mensaje || "");
  const [codigo, dato] = m.split(/:(.+)/);
  const c = (codigo || "").trim();
  const mapa = {
    NEGOCIO_CERRADO: [409, "El local está cerrado en este momento."],
    SIN_STOCK: [409, `Ya no queda stock de «${dato || "un producto"}». Actualizá tu pedido.`],
    PRODUCTO_NO_DISPONIBLE: [409, "Un producto de tu pedido ya no está disponible."],
    MINIMO_NO_ALCANZADO: [409, `El pedido mínimo para envío es $${Number(dato || 0).toLocaleString("es-AR")}.`],
    ENTREGA_NO_DISPONIBLE: [409, "Ese tipo de entrega no está disponible."],
    PAGO_NO_DISPONIBLE: [409, "Ese método de pago no está disponible."],
    EXTRA_INVALIDO: [400, "Un extra del pedido ya no existe."],
    QUITAR_INVALIDO: [400, "Una opción del pedido ya no existe."],
    DATOS_INVALIDOS: [400, "Revisá los datos del pedido."],
  };
  if (mapa[c]) return { status: mapa[c][0], codigo: c, mensaje: mapa[c][1] };
  return { status: 500, codigo: "ERROR", mensaje: "No pudimos registrar tu pedido. Probá de nuevo en unos minutos." };
}

export function armarPreferencia(pedido, items, sitioUrl, notificationUrl, descriptor) {
  const lineas = items.map((it) => {
    const extras = (it.extras || []).map((e) => e.nombre).join(", ");
    return {
      title: (extras ? `${it.nombre} (+${extras})` : it.nombre).slice(0, 250),
      quantity: Number(it.cantidad),
      unit_price: Number(it.precio_unitario),
      currency_id: "ARS",
    };
  });
  if (Number(pedido.envio) > 0) {
    lineas.push({ title: "Envío", quantity: 1, unit_price: Number(pedido.envio), currency_id: "ARS" });
  }

  const base = String(sitioUrl || "").replace(/\/+$/, "");
  const volver = `${base}/seguimiento.html?id=${pedido.id}`;
  const pref = {
    items: lineas,
    external_reference: pedido.id,
    notification_url: notificationUrl,
    back_urls: { success: volver, pending: volver, failure: volver },
    statement_descriptor: String(descriptor || "").slice(0, 22) || undefined,
  };
  // Mercado Pago solo permite volver automáticamente a direcciones https
  if (base.startsWith("https://")) pref.auto_return = "approved";
  return pref;
}

// ---------- Manejo de la solicitud (con dependencias inyectables) ----------

function responder(status, cuerpo) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export async function manejar(req, deps) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return responder(405, { error: "METODO", mensaje: "Método no permitido." });

  let body;
  try {
    body = await req.json();
  } catch {
    return responder(400, { error: "DATOS_INVALIDOS", mensaje: "Solicitud inválida." });
  }

  const v = validarPedido(body);
  if (!v.ok) {
    const t = traducirError(v.error);
    return responder(t.status, { error: t.codigo, mensaje: t.mensaje });
  }

  // 0) Libera el stock de pedidos de Mercado Pago que nadie pagó (mejor esfuerzo)
  if (deps.liberarVencidos) {
    try { await deps.liberarVencidos(); } catch (e) { /* no frena el pedido */ }
  }

  // 1) Guardar el pedido (valida precios, stock, horario y descuenta stock)
  const { data: pedido, error } = await deps.crearPedido(v.datos);
  if (error || !pedido) {
    const t = traducirError(error && error.message);
    if (t.status === 500) console.error("crear_pedido:", error && error.message);
    return responder(t.status, { error: t.codigo, mensaje: t.mensaje });
  }

  const respuesta = { pedido_id: pedido.id, numero: pedido.numero, total: Number(pedido.total), metodo_pago: pedido.metodo_pago };

  // 2) Mercado Pago: crear el link de pago
  if (pedido.metodo_pago === "mercadopago") {
    try {
      if (!deps.mpToken) throw new Error("MP_NO_CONFIGURADO");
      const items = await deps.itemsDelPedido(pedido.id);
      const pref = armarPreferencia(pedido, items, deps.sitioUrl, deps.notificationUrl, deps.descriptor);
      const mp = await deps.crearPreferencia(pref);
      if (!mp || !mp.init_point) throw new Error("MP_SIN_LINK");
      await deps.guardarPreferencia(pedido.id, mp.id);
      respuesta.init_point = mp.init_point;
    } catch (e) {
      console.error("Mercado Pago:", e && e.message);
      // No dejamos stock reservado por un pedido que no se puede cobrar
      await deps.cancelarPedido(pedido.id);
      return responder(502, {
        error: "MP_ERROR",
        mensaje: "No pudimos iniciar el pago con Mercado Pago. Probá con otro método o intentá de nuevo.",
      });
    }
  }

  return responder(200, respuesta);
}

// ---------- Conexión real (solo corre dentro de Supabase) ----------

async function crearClienteServidor() {
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  let clave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); // clave heredada
  const secretas = Deno.env.get("SUPABASE_SECRET_KEYS");  // claves nuevas (sb_secret_...)
  if (secretas) {
    try {
      const o = JSON.parse(secretas);
      clave = o.default || Object.values(o)[0] || clave;
    } catch { /* se usa la heredada */ }
  }
  return createClient(Deno.env.get("SUPABASE_URL"), clave, { auth: { persistSession: false } });
}

async function dependenciasReales() {
  const sb = await crearClienteServidor();
  const mpToken = Deno.env.get("MP_ACCESS_TOKEN") || "";
  return {
    mpToken,
    sitioUrl: Deno.env.get("SITIO_URL") || "",
    descriptor: Deno.env.get("MP_DESCRIPTOR") || "",
    notificationUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/webhook-mp`,
    crearPedido: (datos) => sb.rpc("crear_pedido", datos),
    liberarVencidos: async () => { await sb.rpc("liberar_vencidos_interno", { p_minutos: 30 }); },
    itemsDelPedido: async (id) => {
      const { data, error } = await sb.from("pedido_items").select("*").eq("pedido_id", id);
      if (error) throw error;
      return data;
    },
    guardarPreferencia: async (id, prefId) => {
      await sb.from("pedidos").update({ mp_preference_id: prefId }).eq("id", id);
    },
    cancelarPedido: async (id) => {
      await sb.rpc("cancelar_pedido_interno", { p_id: id });
    },
    crearPreferencia: async (pref) => {
      const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mpToken}` },
        body: JSON.stringify(pref),
      });
      if (!r.ok) throw new Error(`MP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return await r.json();
    },
  };
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(async (req) => {
    try {
      return await manejar(req, await dependenciasReales());
    } catch (e) {
      console.error("crear-pedido:", e && e.message);
      return responder(500, { error: "ERROR", mensaje: "No pudimos registrar tu pedido. Probá de nuevo." });
    }
  });
}
