// @ts-nocheck
// =====================================================================
// FUNCIÓN: webhook-mp
// Mercado Pago avisa acá cuando cambia el estado de un pago. NO confiamos
// en lo que llega en el aviso: con el número de pago consultamos a
// Mercado Pago (con el token del negocio) y recién ahí actualizamos.
//
// Variables (Supabase > Edge Functions > Secrets):
//   MP_ACCESS_TOKEN  Access Token de Mercado Pago del negocio
// =====================================================================

export function esUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
}

// Devuelve el id del pago, o null si el aviso no es de un pago
export function extraerPagoId(url, body) {
  const q = url.searchParams;
  const tipo = q.get("type") || q.get("topic") || (body && (body.type || body.topic)) || "";
  if (tipo && tipo !== "payment") return null;

  const id =
    q.get("data.id") ||
    (body && body.data && body.data.id) ||
    (tipo === "payment" ? q.get("id") : null) ||
    (body && body.resource && String(body.resource).split("/").pop());

  return id && /^\d+$/.test(String(id)) ? String(id) : null;
}

function responder(status, cuerpo) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { "Content-Type": "application/json" } });
}

export async function manejar(req, deps) {
  if (req.method !== "POST" && req.method !== "GET") return responder(405, { ok: false });

  const url = new URL(req.url);
  let body = null;
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = null; }
  }

  const pagoId = extraerPagoId(url, body);
  if (!pagoId) return responder(200, { ok: true, ignorado: true }); // otro tipo de aviso

  if (!deps.mpToken) {
    console.error("webhook-mp: falta MP_ACCESS_TOKEN");
    return responder(500, { ok: false });
  }

  // Consultamos el pago directamente a Mercado Pago
  let pago;
  try {
    pago = await deps.obtenerPago(pagoId);
  } catch (e) {
    if (e && e.status === 404) return responder(200, { ok: true, ignorado: true }); // pago de otra cuenta o inexistente
    console.error("webhook-mp: no se pudo consultar el pago", e && e.message);
    return responder(500, { ok: false }); // Mercado Pago reintenta
  }

  const pedidoId = pago && pago.external_reference;
  if (!esUuid(pedidoId)) return responder(200, { ok: true, ignorado: true });

  const { error } = await deps.actualizarPago({
    p_pedido: pedidoId,
    p_payment_id: String(pago.id),
    p_status: String(pago.status || ""),
    p_monto: Number(pago.transaction_amount || 0),
  });

  if (error) {
    if (String(error.message || "").includes("PEDIDO_NO_ENCONTRADO")) return responder(200, { ok: true, ignorado: true });
    console.error("webhook-mp: actualizar_pago_mp", error.message);
    return responder(500, { ok: false });
  }

  return responder(200, { ok: true });
}

// ---------- Conexión real (solo corre dentro de Supabase) ----------

async function crearClienteServidor() {
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  let clave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secretas = Deno.env.get("SUPABASE_SECRET_KEYS");
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
    obtenerPago: async (id) => {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { Authorization: `Bearer ${mpToken}` },
      });
      if (!r.ok) {
        const e = new Error(`MP ${r.status}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    },
    actualizarPago: (datos) => sb.rpc("actualizar_pago_mp", datos),
  };
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(async (req) => {
    try {
      return await manejar(req, await dependenciasReales());
    } catch (e) {
      console.error("webhook-mp:", e && e.message);
      return responder(500, { ok: false });
    }
  });
}
