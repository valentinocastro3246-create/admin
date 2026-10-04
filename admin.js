// =====================================================================
// PANEL DE ADMINISTRACIÓN — pedidos, productos y stock, caja, reportes y ajustes.
// Todo lo que se lee o escribe pasa por las reglas de seguridad de Supabase:
// solo un usuario registrado como administrador puede usar estos datos.
// =====================================================================
(function () {
    "use strict";

    const CFG = window.PRO_CONFIG || {};
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s === undefined || s === null ? "" : s)
        .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const money = (n) => "$" + Number(n || 0).toLocaleString("es-AR", { maximumFractionDigits: 2 });
    const num = (v) => { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };

    const ETQ = { pendiente: "Nuevo", confirmado: "Confirmado", preparando: "Preparando", listo: "Listo", entregado: "Entregado", cancelado: "Cancelado" };
    const SIGUIENTE = { pendiente: ["confirmado", "✔ Confirmar"], confirmado: ["preparando", "👨‍🍳 Preparar"], preparando: ["listo", "✅ Marcar listo"], listo: ["entregado", "📦 Entregado"] };
    const ENTREGA = { retiro: "🏪 Retiro", envio: "🛵 Envío", mesa: "🪑 Mesa" };
    const METODO = { efectivo: "💵 Efectivo", transferencia: "🏦 Transferencia", mercadopago: "💙 Mercado Pago" };
    const DIAS = [["lunes", "Lunes"], ["martes", "Martes"], ["miercoles", "Miércoles"], ["jueves", "Jueves"], ["viernes", "Viernes"], ["sabado", "Sábado"], ["domingo", "Domingo"]];

    let sb = null;
    const S = { tab: "pedidos", filtro: "activos", sub: "productos", rango: "hoy", negocio: {}, cats: [], prods: [], tok: 0, canal: null, sondeo: null };

    // ---------- utilidades ----------
    function errorLindo(e) {
        const m = String((e && (e.message || e.details)) || e || "");
        if (m.includes("STOCK_NEGATIVO")) return "El stock no puede quedar en negativo.";
        if (m.includes("NO_AUTORIZADO")) return "Tu usuario no tiene permiso de administrador.";
        if (m.includes("CAJA_NO_ABIERTA")) return "La caja ya estaba cerrada.";
        if (m.includes("una_sola_caja_abierta") || m.includes("duplicate key")) return "Ya hay una caja abierta.";
        if (m.includes("JWT") || m.includes("401")) return "Tu sesión venció. Volvé a ingresar.";
        return m || "Ocurrió un error.";
    }
    async function q(promesa) {
        const r = await promesa;
        if (r.error) throw r.error;
        return r.data;
    }
    let toastT;
    function toast(msg, mal) {
        const t = $("toast");
        t.textContent = msg; t.className = "toast" + (mal ? " mal" : ""); t.hidden = false;
        clearTimeout(toastT);
        toastT = setTimeout(() => { t.hidden = true; }, mal ? 4500 : 2500);
    }
    function fecha(d) {
        const x = new Date(d);
        const p = (n) => String(n).padStart(2, "0");
        return p(x.getDate()) + "/" + p(x.getMonth() + 1) + " " + p(x.getHours()) + ":" + p(x.getMinutes());
    }
    const dia0 = (d) => { const x = new Date(d || Date.now()); x.setHours(0, 0, 0, 0); return x; };
    function waTel(t) {
        let d = String(t || "").replace(/\D/g, "").replace(/^0+/, "");
        if (d.length === 10) d = "549" + d;
        return d;
    }

    function abrirModal(html) {
        const m = $("modal");
        m.innerHTML = '<div class="hoja">' + html + "</div>";
        m.hidden = false;
    }
    function cerrarModal() { const m = $("modal"); m.hidden = true; m.innerHTML = ""; }
    const valor = (id) => { const e = $(id); return e ? e.value.trim() : ""; };
    const marcado = (id) => { const e = $(id); return !!(e && e.checked); };

    function beep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const o = ctx.createOscillator(); const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.15;
            o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 350);
        } catch (e) { /* sin audio */ }
    }

    async function reducirImagen(archivo, max) {
        const bmp = await createImageBitmap(archivo);
        const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        return await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    }
    async function subirImagen(archivo, carpeta) {
        let cuerpo = archivo; let ext = (archivo.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        let tipo = archivo.type || "image/jpeg";
        if (/^image\/(jpeg|png|webp)$/.test(tipo)) {
            cuerpo = await reducirImagen(archivo, carpeta === "logo" ? 600 : 1000);
            ext = "jpg"; tipo = "image/jpeg";
        }
        const ruta = carpeta + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
        const r = await sb.storage.from("imagenes").upload(ruta, cuerpo, { contentType: tipo, upsert: false });
        if (r.error) throw r.error;
        return sb.storage.from("imagenes").getPublicUrl(ruta).data.publicUrl;
    }

    // =================================================================
    // ACCESO
    // =================================================================
    async function entrar() {
        const e = $("l-error"); e.hidden = true;
        const r = await sb.auth.signInWithPassword({ email: valor("l-email"), password: $("l-pass").value });
        if (r.error) { e.textContent = "Email o contraseña incorrectos."; e.hidden = false; return; }
        await abrirApp();
    }

    async function abrirApp() {
        const adm = await sb.rpc("es_admin");
        if (adm.error || adm.data !== true) {
            await sb.auth.signOut();
            const e = $("l-error");
            e.textContent = "Ese usuario no está autorizado como administrador."; e.hidden = false;
            $("login").hidden = false; $("app").hidden = true;
            return;
        }
        $("login").hidden = true; $("app").hidden = false;
        S.negocio = await q(sb.from("negocio").select("*").eq("id", 1).single());
        $("top-nombre").textContent = S.negocio.nombre || "Panel";
        document.title = "Panel — " + (S.negocio.nombre || "");
        $("top-tienda").href = location.href.replace(/admin\.html.*$/, "index.html");
        suscribir();
        await irA(S.tab);
    }

    async function salir() {
        if (S.canal) { try { await sb.removeChannel(S.canal); } catch (e) { /* nada */ } S.canal = null; }
        clearInterval(S.sondeo);
        await sb.auth.signOut();
        $("app").hidden = true; $("login").hidden = false; $("l-pass").value = "";
    }

    function suscribir() {
        if (S.canal) return;
        try {
            S.canal = sb.channel("pedidos-panel")
                .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, (p) => {
                    if (p.eventType === "INSERT") { beep(); toast("🔔 Nuevo pedido #" + (p.new && p.new.numero)); }
                    if (S.tab === "pedidos") vistaPedidos(); else actualizarBadge();
                })
                .subscribe();
        } catch (e) { /* sin tiempo real: queda el sondeo */ }
        clearInterval(S.sondeo);
        S.sondeo = setInterval(() => { if (S.tab === "pedidos" && $("modal").hidden) vistaPedidos(); else actualizarBadge(); }, 30000);
    }

    async function actualizarBadge() {
        try {
            const r = await sb.from("pedidos").select("id").eq("estado", "pendiente");
            const n = (r.data || []).length;
            const b = $("badge-pedidos"); b.textContent = n; b.hidden = n === 0;
        } catch (e) { /* nada */ }
    }

    async function irA(tab) {
        S.tab = tab;
        document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("act", b.dataset.tab === tab));
        $("vista").innerHTML = '<p class="vacio">Cargando...</p>';
        try {
            if (tab === "pedidos") await vistaPedidos();
            if (tab === "productos") await vistaProductos();
            if (tab === "caja") await vistaCaja();
            if (tab === "reportes") await vistaReportes();
            if (tab === "ajustes") await vistaAjustes();
        } catch (e) { console.error(e); $("vista").innerHTML = '<p class="vacio">No se pudo cargar: ' + esc(errorLindo(e)) + "</p>"; }
        if (tab !== "pedidos") actualizarBadge();
    }

    // =================================================================
    // PEDIDOS
    // =================================================================
    function tarjetaPedido(p, its) {
        const sig = SIGUIENTE[p.estado];
        const pago = p.pago_estado === "pagado" ? '<span class="chip ok">Pagado</span>'
            : p.pago_estado === "reembolsado" ? '<span class="chip warn">Reembolsado</span>'
            : '<span class="chip pend">Pago pendiente</span>';
        const tel = waTel(p.cliente_telefono);
        return '<div class="tarjeta' + (p.estado === "pendiente" ? " nuevo" : "") + '" data-pedido="' + p.id + '">' +
            '<div class="cab"><div><span class="num">#' + p.numero + "</span> · " + esc(p.cliente_nombre) +
            '<div class="suave">' + fecha(p.creado_at) + " · " + (ENTREGA[p.tipo_entrega] || "") +
            (p.tipo_entrega === "envio" ? " · " + esc(p.direccion) : "") + (p.tipo_entrega === "mesa" ? " " + esc(p.mesa) : "") + "</div></div>" +
            '<div style="text-align:right"><div class="num">' + money(p.total) + '</div><span class="chip est">' + (ETQ[p.estado] || p.estado) + "</span></div></div>" +
            "<div>" + pago + '<span class="chip">' + (METODO[p.metodo_pago] || p.metodo_pago) + "</span>" +
            (p.mp_estado && p.pago_estado !== "pagado" ? '<span class="chip">MP: ' + esc(p.mp_estado) + "</span>" : "") + "</div>" +
            '<div class="items">' + its.map((i) => "<div><strong>" + i.cantidad + "×</strong> " + esc(i.nombre) +
                (i.quitar && i.quitar.length ? "<small>Sin: " + esc(i.quitar.join(", ")) + "</small>" : "") +
                (i.extras && i.extras.length ? "<small>Extras: " + esc(i.extras.map((e) => e.nombre).join(", ")) + "</small>" : "") +
                (i.nota ? "<small>“" + esc(i.nota) + "”</small>" : "") + "</div>").join("") +
            (Number(p.envio) > 0 ? '<div class="suave">Envío: ' + money(p.envio) + "</div>" : "") + "</div>" +
            (p.notas ? '<div class="suave">📝 ' + esc(p.notas) + "</div>" : "") +
            (p.estado === "cancelado" && p.pago_estado === "pagado" ? '<div class="alerta">⚠️ Pedido cancelado pero PAGADO: corresponde devolver el dinero.</div>' : "") +
            '<div class="acciones">' +
            (sig && p.estado !== "cancelado" ? '<button class="btn chico" data-acc="avanzar" data-id="' + p.id + '">' + sig[1] + "</button>" : "") +
            (p.pago_estado === "pendiente" && p.estado !== "cancelado" ? '<button class="btn chico ok" data-acc="cobrar" data-id="' + p.id + '">💲 Registrar cobro</button>' : "") +
            '<button class="btn chico sec" data-acc="imprimir" data-id="' + p.id + '">🖨 Ticket</button>' +
            (tel ? '<a class="btn chico sec" target="_blank" rel="noopener" href="https://wa.me/' + tel + '">💬 WhatsApp</a>' : "") +
            (p.estado !== "cancelado" && p.estado !== "entregado" ? '<button class="btn chico mal" data-acc="cancelar" data-id="' + p.id + '">Cancelar</button>' : "") +
            "</div></div>";
    }

    async function vistaPedidos() {
        const t = ++S.tok;
        const datos = await q(sb.from("pedidos").select("*").order("creado_at", { ascending: false }).limit(150));
        if (t !== S.tok) return;
        S.pedidos = datos;
        const h0 = dia0();
        const filtros = {
            activos: (p) => ["pendiente", "confirmado", "preparando", "listo"].includes(p.estado),
            hoy: (p) => new Date(p.creado_at) >= h0,
            entregados: (p) => p.estado === "entregado",
            cancelados: (p) => p.estado === "cancelado",
            todos: () => true
        };
        const lista = datos.filter(filtros[S.filtro]).slice(0, 60);
        const ids = lista.map((p) => p.id);
        const items = ids.length ? await q(sb.from("pedido_items").select("*").in("pedido_id", ids)) : [];
        if (t !== S.tok) return;

        const nuevos = datos.filter((p) => p.estado === "pendiente").length;
        const b = $("badge-pedidos"); b.textContent = nuevos; b.hidden = nuevos === 0;

        const chips = [["activos", "En curso"], ["hoy", "Hoy"], ["entregados", "Entregados"], ["cancelados", "Cancelados"], ["todos", "Todos"]];
        $("vista").innerHTML = '<div class="barra"><div class="chips">' +
            chips.map((c) => '<button class="chip-f' + (S.filtro === c[0] ? " act" : "") + '" data-acc="filtro" data-f="' + c[0] + '">' + c[1] + "</button>").join("") +
            '</div><span class="espacio"></span><button class="btn chico" data-acc="mostrador">+ Venta mostrador</button><button class="btn chico sec" data-acc="refrescar">↻ Actualizar</button></div>' +
            (lista.length ? lista.map((p) => tarjetaPedido(p, items.filter((i) => i.pedido_id === p.id))).join("") : '<p class="vacio">No hay pedidos en esta lista.</p>');
    }

    function pedidoPorId(id) { return (S.pedidos || []).find((p) => p.id === id); }

    async function avanzar(id) {
        const p = pedidoPorId(id); const sig = p && SIGUIENTE[p.estado];
        if (!sig) return;
        await q(sb.from("pedidos").update({ estado: sig[0] }).eq("id", id));
        await vistaPedidos();
        if (sig[0] === "entregado" && p.pago_estado === "pendiente") abrirCobro(id, true);
    }

    function abrirCobro(id, tras) {
        const p = pedidoPorId(id);
        if (!p) return;
        abrirModal("<h2>Registrar cobro · #" + p.numero + "</h2>" +
            (tras ? '<div class="ayuda">El pedido ya se entregó y figura sin cobrar.</div>' : "") +
            '<p style="margin-bottom:12px">Total a cobrar: <strong>' + money(p.total) + "</strong></p>" +
            '<div class="campo"><label>¿Cómo pagó?</label><select id="cb-metodo">' +
            Object.keys(METODO).map((k) => '<option value="' + k + '"' + (k === p.metodo_pago ? " selected" : "") + ">" + METODO[k] + "</option>").join("") + "</select></div>" +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Ahora no</button><button class="btn ok" data-acc="cobrar-ok" data-id="' + id + '">Confirmar cobro</button></div>');
    }

    async function cobrarOk(id) {
        await q(sb.from("pedidos").update({ pago_estado: "pagado", pagado_at: new Date().toISOString(), metodo_pago: valor("cb-metodo") }).eq("id", id));
        cerrarModal(); toast("Cobro registrado"); await vistaPedidos();
    }

    function abrirCancelar(id) {
        const p = pedidoPorId(id);
        abrirModal("<h2>Cancelar pedido #" + (p ? p.numero : "") + "</h2>" +
            "<p>Se devuelve el stock de los productos.</p>" +
            (p && p.pago_estado === "pagado" ? '<div class="alerta">Este pedido ya está PAGADO: acordate de devolver el dinero al cliente.</div>' : "") +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Volver</button><button class="btn mal" data-acc="cancelar-ok" data-id="' + id + '">Sí, cancelar</button></div>');
    }

    async function cancelarOk(id) {
        await q(sb.rpc("admin_cancelar_pedido", { p_id: id }));
        cerrarModal(); toast("Pedido cancelado"); await vistaPedidos();
    }

    async function imprimir(id) {
        const p = pedidoPorId(id);
        const its = await q(sb.from("pedido_items").select("*").eq("pedido_id", id));
        const l = [];
        l.push("<h2 style='text-align:center'>" + esc(S.negocio.nombre) + "</h2>");
        l.push("<p>Pedido <b>#" + p.numero + "</b><br>" + fecha(p.creado_at) + "</p><hr>");
        l.push("<p><b>" + esc(p.cliente_nombre) + "</b><br>" + esc(p.cliente_telefono) + "<br>" + (ENTREGA[p.tipo_entrega] || "") +
            (p.tipo_entrega === "envio" ? ": " + esc(p.direccion) : "") + (p.tipo_entrega === "mesa" ? ": " + esc(p.mesa) : "") + "</p><hr>");
        its.forEach((i) => {
            l.push("<p>" + i.cantidad + " x " + esc(i.nombre) + " — " + money(i.precio_unitario * i.cantidad) +
                (i.quitar && i.quitar.length ? "<br>&nbsp;&nbsp;Sin: " + esc(i.quitar.join(", ")) : "") +
                (i.extras && i.extras.length ? "<br>&nbsp;&nbsp;Extras: " + esc(i.extras.map((e) => e.nombre).join(", ")) : "") +
                (i.nota ? "<br>&nbsp;&nbsp;“" + esc(i.nota) + "”" : "") + "</p>");
        });
        l.push("<hr>");
        if (Number(p.envio) > 0) l.push("<p>Envío: " + money(p.envio) + "</p>");
        l.push("<h3>TOTAL: " + money(p.total) + "</h3><p>" + (METODO[p.metodo_pago] || "") + " · " + (p.pago_estado === "pagado" ? "PAGADO" : "A COBRAR") + "</p>");
        if (p.notas) l.push("<p>Obs: " + esc(p.notas) + "</p>");
        const w = window.open("", "_blank", "width=380,height=640");
        if (!w) { toast("El navegador bloqueó la ventana del ticket.", true); return; }
        w.document.write("<html><head><title>Ticket #" + p.numero + "</title><style>body{font-family:monospace;font-size:13px;width:280px;margin:8px}p{margin:6px 0}hr{border:0;border-top:1px dashed #000}</style></head><body>" + l.join("") + "</body></html>");
        w.document.close(); w.focus(); w.print();
    }

    // =================================================================
    // PRODUCTOS · CATEGORÍAS · STOCK
    // =================================================================
    async function cargarCatalogo() {
        S.cats = await q(sb.from("categorias").select("*").order("orden", { ascending: true }).order("nombre", { ascending: true }));
        S.prods = await q(sb.from("productos").select("*").order("orden", { ascending: true }).order("nombre", { ascending: true }));
    }
    const nombreCat = (id) => { const c = S.cats.find((x) => x.id === id); return c ? c.nombre : "—"; };

    async function vistaProductos() {
        await cargarCatalogo();
        const subs = [["productos", "Productos"], ["categorias", "Categorías"], ["movimientos", "Movimientos de stock"]];
        let cuerpo = "";

        if (S.sub === "productos") {
            const busca = (S.busca || "").toLowerCase();
            const lista = S.prods.filter((p) => !busca || p.nombre.toLowerCase().includes(busca));
            const bajos = S.prods.filter((p) => p.controla_stock && p.stock <= p.stock_minimo).length;
            cuerpo = '<div class="barra"><input id="busca" placeholder="Buscar producto..." value="' + esc(S.busca || "") + '" style="padding:9px 12px;border:1px solid #d1d5db;border-radius:10px;min-width:200px">' +
                '<span class="espacio"></span><button class="btn" data-acc="prod-editar" data-id="">+ Nuevo producto</button></div>' +
                (bajos ? '<div class="alerta" style="margin-bottom:12px">⚠️ ' + bajos + " producto(s) con stock bajo o agotado.</div>" : "") +
                '<div class="tabla-scroll"><table><thead><tr><th></th><th>Producto</th><th>Categoría</th><th>Precio</th><th>Stock</th><th>Visible</th><th></th></tr></thead><tbody>' +
                (lista.length ? lista.map((p) => {
                    const clase = p.controla_stock ? (p.stock <= 0 ? "sin" : p.stock <= p.stock_minimo ? "bajo" : "") : "";
                    return '<tr class="' + clase + '"><td>' + (p.imagen_url ? '<img src="' + esc(p.imagen_url) + '" alt="">' : "") + "</td>" +
                        "<td><strong>" + esc(p.nombre) + '</strong><div class="suave">' + esc(p.etiqueta) + "</div></td><td>" + esc(nombreCat(p.categoria_id)) + "</td><td>" + money(p.precio) + "</td>" +
                        "<td>" + (p.controla_stock
                            ? '<div class="stock-ctl"><button data-acc="stock-mas-menos" data-id="' + p.id + '" data-d="-1">−</button><strong>' + p.stock + '</strong><button data-acc="stock-mas-menos" data-id="' + p.id + '" data-d="1">+</button><button class="btn chico sec" data-acc="stock-reponer" data-id="' + p.id + '">Reponer</button></div>'
                            : '<span class="suave">Sin control</span>') + "</td>" +
                        '<td><label class="check"><input type="checkbox" data-acc="prod-visible" data-id="' + p.id + '"' + (p.visible ? " checked" : "") + "></label></td>" +
                        '<td><button class="btn chico sec" data-acc="prod-editar" data-id="' + p.id + '">Editar</button></td></tr>';
                }).join("") : '<tr><td colspan="7" class="vacio">Todavía no hay productos.</td></tr>') +
                "</tbody></table></div>";
        }

        if (S.sub === "categorias") {
            cuerpo = '<div class="barra"><span class="espacio"></span><button class="btn" data-acc="cat-editar" data-id="">+ Nueva categoría</button></div>' +
                '<div class="tabla-scroll"><table><thead><tr><th>Orden</th><th>Categoría</th><th>Productos</th><th>Visible</th><th></th></tr></thead><tbody>' +
                (S.cats.length ? S.cats.map((c) => "<tr><td>" + c.orden + "</td><td>" + esc((c.emoji ? c.emoji + " " : "") + c.nombre) + "</td><td>" +
                    S.prods.filter((p) => p.categoria_id === c.id).length + "</td><td>" + (c.visible ? "Sí" : "No") +
                    '</td><td><button class="btn chico sec" data-acc="cat-editar" data-id="' + c.id + '">Editar</button></td></tr>').join("")
                    : '<tr><td colspan="5" class="vacio">Todavía no hay categorías.</td></tr>') + "</tbody></table></div>";
        }

        if (S.sub === "movimientos") {
            const mov = await q(sb.from("movimientos_stock").select("*").order("creado_at", { ascending: false }).limit(100));
            const MOT = { venta: "Venta", cancelacion: "Cancelación (devuelve)", reposicion: "Reposición", ajuste: "Ajuste" };
            cuerpo = '<div class="tabla-scroll"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Cambio</th><th>Motivo</th><th>Nota</th></tr></thead><tbody>' +
                (mov.length ? mov.map((m) => { const p = S.prods.find((x) => x.id === m.producto_id);
                    return "<tr><td>" + fecha(m.creado_at) + "</td><td>" + esc(p ? p.nombre : "(borrado)") + '</td><td><strong style="color:' + (m.delta < 0 ? "#dc2626" : "#16a34a") + '">' + (m.delta > 0 ? "+" : "") + m.delta + "</strong></td><td>" + esc(MOT[m.motivo] || m.motivo) + "</td><td>" + esc(m.nota) + "</td></tr>"; }).join("")
                    : '<tr><td colspan="5" class="vacio">Sin movimientos todavía.</td></tr>') + "</tbody></table></div>";
        }

        $("vista").innerHTML = '<div class="barra"><div class="chips">' +
            subs.map((s) => '<button class="chip-f' + (S.sub === s[0] ? " act" : "") + '" data-acc="sub" data-s="' + s[0] + '">' + s[1] + "</button>").join("") + "</div></div>" + cuerpo;
    }

    function formProducto(p) {
        p = p || { nombre: "", descripcion: "", precio: "", etiqueta: "", visible: true, controla_stock: false, stock: 0, stock_minimo: 0, extras: [], quitables: [], orden: 0, imagen_url: "", categoria_id: S.cats[0] ? S.cats[0].id : "" };
        const nuevo = !p.id;
        abrirModal("<h2>" + (nuevo ? "Nuevo producto" : "Editar producto") + "</h2>" +
            '<div class="campo"><label>Nombre *</label><input id="p-nombre" value="' + esc(p.nombre) + '"></div>' +
            '<div class="cols"><div class="campo"><label>Categoría</label><select id="p-cat"><option value="">Sin categoría</option>' +
            S.cats.map((c) => '<option value="' + c.id + '"' + (c.id === p.categoria_id ? " selected" : "") + ">" + esc(c.nombre) + "</option>").join("") + "</select></div>" +
            '<div class="campo"><label>Precio *</label><input id="p-precio" inputmode="decimal" value="' + esc(p.precio) + '"></div></div>' +
            '<div class="campo"><label>Descripción</label><textarea id="p-desc" rows="2">' + esc(p.descripcion) + "</textarea></div>" +
            '<div class="campo"><label>Foto</label>' + '<img class="preview" id="p-prev" src="' + esc(p.imagen_url) + '" alt=""' + (p.imagen_url ? "" : " hidden") + ">" +
            '<input type="file" id="p-file" accept="image/*"><input type="hidden" id="p-img" value="' + esc(p.imagen_url) + '"><small>Se achica sola para que la página cargue rápido.</small></div>' +
            '<div class="cols"><div class="campo"><label>Etiqueta (opcional)</label><input id="p-etq" value="' + esc(p.etiqueta) + '" placeholder="Ej: Nuevo"></div>' +
            '<div class="campo"><label>Orden</label><input id="p-orden" inputmode="numeric" value="' + esc(p.orden) + '"></div></div>' +
            '<label class="check"><input type="checkbox" id="p-vis"' + (p.visible ? " checked" : "") + "> Visible en la tienda</label>" +
            '<label class="check"><input type="checkbox" id="p-ctl"' + (p.controla_stock ? " checked" : "") + "> Controlar stock (se descuenta solo con cada pedido)</label>" +
            '<div class="cols"><div class="campo"><label>' + (nuevo ? "Stock inicial" : "Stock actual (se cambia con +, − o Reponer)") + '</label><input id="p-stock" inputmode="numeric" value="' + esc(p.stock) + '"' + (nuevo ? "" : " disabled") + "></div>" +
            '<div class="campo"><label>Avisar con stock bajo desde</label><input id="p-min" inputmode="numeric" value="' + esc(p.stock_minimo) + '"></div></div>' +
            '<div class="campo"><label>Extras con precio (uno por línea: Nombre | precio)</label><textarea id="p-extras" rows="3" placeholder="Bacon | 1500">' +
            esc((p.extras || []).map((e) => e.nombre + " | " + e.precio).join("\n")) + "</textarea></div>" +
            '<div class="campo"><label>Ingredientes que el cliente puede sacar (uno por línea)</label><textarea id="p-quit" rows="3" placeholder="Lechuga">' + esc((p.quitables || []).join("\n")) + "</textarea></div>" +
            '<div class="pie">' + (nuevo ? "" : '<button class="btn mal" data-acc="prod-borrar" data-id="' + p.id + '" style="margin-right:auto">Borrar</button>') +
            '<button class="btn sec" data-acc="cerrar">Cancelar</button><button class="btn" data-acc="prod-guardar" data-id="' + (p.id || "") + '">Guardar</button></div>');
    }

    async function guardarProducto(id) {
        const nombre = valor("p-nombre");
        const precio = num(valor("p-precio"));
        if (!nombre) { toast("Falta el nombre.", true); return; }
        if (!(precio >= 0) || valor("p-precio") === "") { toast("Revisá el precio.", true); return; }

        const extras = []; 
        for (const linea of valor("p-extras").split("\n").map((x) => x.trim()).filter(Boolean)) {
            const [n, pr] = linea.split("|").map((x) => x.trim());
            if (!n) continue;
            extras.push({ nombre: n, precio: num(pr) });
        }
        const quitables = valor("p-quit").split("\n").map((x) => x.trim()).filter(Boolean);

        const datos = {
            nombre, descripcion: valor("p-desc"), precio, categoria_id: valor("p-cat") || null, imagen_url: valor("p-img"),
            etiqueta: valor("p-etq"), orden: Math.round(num(valor("p-orden"))), visible: marcado("p-vis"),
            controla_stock: marcado("p-ctl"), stock_minimo: Math.max(0, Math.round(num(valor("p-min")))), extras, quitables
        };
        if (id) {
            await q(sb.from("productos").update(datos).eq("id", id));
        } else {
            datos.stock = Math.max(0, Math.round(num(valor("p-stock"))));
            const fila = await q(sb.from("productos").insert(datos).select().single());
            if (datos.controla_stock && datos.stock > 0) {
                await q(sb.from("movimientos_stock").insert({ producto_id: fila.id, delta: datos.stock, motivo: "ajuste", nota: "Stock inicial" }));
            }
        }
        cerrarModal(); toast("Producto guardado"); await vistaProductos();
    }

    async function borrarProducto(id) {
        const p = S.prods.find((x) => x.id === id);
        abrirModal("<h2>Borrar producto</h2><p>¿Borrar <strong>" + esc(p ? p.nombre : "") + "</strong>? Los pedidos anteriores se conservan. Si solo querés dejar de venderlo, es mejor ocultarlo.</p>" +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Volver</button><button class="btn mal" data-acc="prod-borrar-ok" data-id="' + id + '">Sí, borrar</button></div>');
    }

    function abrirReponer(id) {
        const p = S.prods.find((x) => x.id === id);
        abrirModal("<h2>Reponer stock · " + esc(p.nombre) + "</h2><p style='margin-bottom:12px'>Stock actual: <strong>" + p.stock + "</strong></p>" +
            '<div class="campo"><label>Cantidad que ingresa</label><input id="r-cant" inputmode="numeric" placeholder="Ej: 20"></div>' +
            '<div class="campo"><label>Nota (opcional)</label><input id="r-nota" placeholder="Ej: compra a proveedor"></div>' +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Cancelar</button><button class="btn ok" data-acc="stock-reponer-ok" data-id="' + id + '">Reponer</button></div>');
    }

    function formCategoria(c) {
        c = c || { nombre: "", emoji: "", orden: S.cats.length + 1, visible: true };
        abrirModal("<h2>" + (c.id ? "Editar categoría" : "Nueva categoría") + "</h2>" +
            '<div class="campo"><label>Nombre *</label><input id="c-nombre" value="' + esc(c.nombre) + '"></div>' +
            '<div class="cols"><div class="campo"><label>Emoji (opcional)</label><input id="c-emoji" value="' + esc(c.emoji) + '" maxlength="4"></div>' +
            '<div class="campo"><label>Orden</label><input id="c-orden" inputmode="numeric" value="' + esc(c.orden) + '"></div></div>' +
            '<label class="check"><input type="checkbox" id="c-vis"' + (c.visible ? " checked" : "") + "> Visible en la tienda</label>" +
            '<div class="pie">' + (c.id ? '<button class="btn mal" data-acc="cat-borrar" data-id="' + c.id + '" style="margin-right:auto">Borrar</button>' : "") +
            '<button class="btn sec" data-acc="cerrar">Cancelar</button><button class="btn" data-acc="cat-guardar" data-id="' + (c.id || "") + '">Guardar</button></div>');
    }

    // =================================================================
    // CAJA
    // =================================================================
    function filasResumen(r) {
        return '<div class="fila"><span>Efectivo inicial</span><strong>' + money(r.inicial) + "</strong></div>" +
            '<div class="fila"><span>Ventas en efectivo</span><strong>' + money(r.efectivo) + "</strong></div>" +
            '<div class="fila"><span>Ingresos manuales</span><strong>' + money(r.ingresos) + "</strong></div>" +
            '<div class="fila"><span>Egresos (gastos, retiros)</span><strong>−' + money(r.egresos) + "</strong></div>" +
            '<div class="fila"><span><b>Efectivo esperado en caja</b></span><strong>' + money(r.esperado_efectivo) + "</strong></div>";
    }
    function bloqueVentas(r) {
        return '<div class="grid">' +
            '<div class="kpi"><span>Ventas cobradas</span><b>' + money(r.total) + "</b><span>" + r.cantidad + " pedidos</span></div>" +
            '<div class="kpi"><span>💵 Efectivo</span><b>' + money(r.efectivo) + "</b></div>" +
            '<div class="kpi"><span>🏦 Transferencia</span><b>' + money(r.transferencia) + "</b></div>" +
            '<div class="kpi"><span>💙 Mercado Pago</span><b>' + money(r.mercadopago) + "</b></div></div>";
    }

    async function vistaCaja() {
        const abierta = await q(sb.from("caja_turnos").select("*").eq("estado", "abierta").maybeSingle());
        const cerradas = await q(sb.from("caja_turnos").select("*").eq("estado", "cerrada").order("cerrado_at", { ascending: false }).limit(15));
        S.turno = abierta;
        let html = "";

        if (!abierta) {
            html += '<div class="caja" style="margin-bottom:16px"><h2>Caja cerrada</h2><p class="suave" style="margin-bottom:12px">Abrí la caja al empezar el día: registrá cuánto efectivo hay para dar vuelto.</p>' +
                '<div class="campo" style="max-width:260px"><label>Efectivo inicial en caja</label><input id="ca-inicial" inputmode="decimal" value="0"></div>' +
                '<button class="btn" data-acc="caja-abrir">Abrir caja</button></div>';
        } else {
            const r = await q(sb.rpc("admin_resumen_caja", { p_turno: abierta.id }));
            const movs = await q(sb.from("caja_movimientos").select("*").eq("turno_id", abierta.id).order("creado_at", { ascending: false }));
            S.resumen = r;
            html += '<div class="barra"><h2 style="margin:0">Caja abierta <span class="suave">desde ' + fecha(abierta.abierto_at) + "</span></h2><span class=\"espacio\"></span>" +
                '<button class="btn sec" data-acc="caja-mov">+ Ingreso / egreso</button><button class="btn mal" data-acc="caja-cerrar">Cerrar caja</button></div>' +
                bloqueVentas(r) +
                '<div class="dos"><div class="caja"><h3>Efectivo en caja</h3>' + filasResumen(r) + "</div>" +
                '<div class="caja"><h3>Movimientos manuales</h3>' + (movs.length ? movs.map((m) =>
                    '<div class="fila"><span>' + fecha(m.creado_at) + " · " + esc(m.concepto) + "</span><strong style=\"color:" + (m.tipo === "egreso" ? "#dc2626" : "#16a34a") + '">' + (m.tipo === "egreso" ? "−" : "+") + money(m.monto) + "</strong></div>").join("")
                    : '<p class="suave">Sin movimientos. Usá "Ingreso / egreso" para anotar gastos o retiros.</p>') + "</div></div>";
        }

        html += '<h3 style="margin:8px 0">Cajas anteriores</h3><div class="tabla-scroll"><table><thead><tr><th>Apertura</th><th>Cierre</th><th>Ventas</th><th>Esperado</th><th>Contado</th><th>Diferencia</th><th></th></tr></thead><tbody>' +
            (cerradas.length ? cerradas.map((c) => { const d = Number(c.diferencia || 0);
                return "<tr><td>" + fecha(c.abierto_at) + "</td><td>" + fecha(c.cerrado_at) + "</td><td>" + money(c.resumen && c.resumen.total) + "</td><td>" + money(c.esperado_efectivo) + "</td><td>" + money(c.monto_contado) +
                    '</td><td><strong style="color:' + (d === 0 ? "#16a34a" : "#dc2626") + '">' + (d > 0 ? "+" : "") + money(d) + '</strong></td><td><button class="btn chico sec" data-acc="caja-ver" data-id="' + c.id + '">Ver</button></td></tr>'; }).join("")
                : '<tr><td colspan="7" class="vacio">Todavía no hay cierres.</td></tr>') + "</tbody></table></div>";
        S.cerradas = cerradas;
        $("vista").innerHTML = html;
    }

    function abrirMovimientoCaja() {
        abrirModal("<h2>Ingreso / egreso de efectivo</h2>" +
            '<div class="campo"><label>Tipo</label><select id="m-tipo"><option value="egreso">Egreso (gasto, retiro, pago a proveedor)</option><option value="ingreso">Ingreso (aporte de efectivo)</option></select></div>' +
            '<div class="campo"><label>Concepto *</label><input id="m-concepto" placeholder="Ej: compra de hielo"></div>' +
            '<div class="campo"><label>Monto *</label><input id="m-monto" inputmode="decimal"></div>' +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Cancelar</button><button class="btn" data-acc="caja-mov-ok">Guardar</button></div>');
    }

    function abrirCierreCaja() {
        const r = S.resumen;
        abrirModal("<h2>Cerrar caja</h2>" + bloqueVentas(r) + '<div class="caja" style="margin-bottom:12px">' + filasResumen(r) + "</div>" +
            '<div class="campo"><label>Efectivo contado en la caja *</label><input id="cc-contado" inputmode="decimal" placeholder="Contá los billetes y monedas"></div>' +
            '<div id="cc-dif" class="ayuda" hidden></div>' +
            '<div class="campo"><label>Notas (opcional)</label><input id="cc-notas"></div>' +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Cancelar</button><button class="btn mal" data-acc="caja-cerrar-ok">Cerrar caja</button></div>');
    }

    function verCierre(c) {
        const r = c.resumen || {};
        abrirModal("<h2>Cierre de caja</h2><p class='suave' style='margin-bottom:10px'>" + fecha(c.abierto_at) + " → " + fecha(c.cerrado_at) + "</p>" + bloqueVentas(Object.assign({ total: 0, cantidad: 0, efectivo: 0, transferencia: 0, mercadopago: 0 }, r)) +
            '<div class="caja" style="margin-bottom:12px">' + filasResumen(Object.assign({ inicial: 0, efectivo: 0, ingresos: 0, egresos: 0, esperado_efectivo: 0 }, r)) +
            '<div class="fila"><span>Efectivo contado</span><strong>' + money(c.monto_contado) + '</strong></div><div class="fila"><span><b>Diferencia</b></span><strong>' + money(c.diferencia) + "</strong></div></div>" +
            (c.notas ? "<p>📝 " + esc(c.notas) + "</p>" : "") +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Cerrar</button><button class="btn" data-acc="caja-imprimir" data-id="' + c.id + '">🖨 Imprimir</button></div>');
    }

    function imprimirCierre(c) {
        const r = c.resumen || {};
        const w = window.open("", "_blank", "width=420,height=640");
        if (!w) { toast("El navegador bloqueó la ventana.", true); return; }
        w.document.write("<html><head><title>Cierre de caja</title><style>body{font-family:Arial;font-size:14px;margin:20px}td{padding:4px 12px 4px 0}</style></head><body><h2>" + esc(S.negocio.nombre) + " — Cierre de caja</h2><p>" + fecha(c.abierto_at) + " → " + fecha(c.cerrado_at) + "</p><table>" +
            [["Efectivo inicial", r.inicial], ["Ventas efectivo", r.efectivo], ["Ventas transferencia", r.transferencia], ["Ventas Mercado Pago", r.mercadopago], ["TOTAL VENTAS", r.total], ["Ingresos manuales", r.ingresos], ["Egresos", r.egresos], ["Efectivo esperado", c.esperado_efectivo], ["Efectivo contado", c.monto_contado], ["DIFERENCIA", c.diferencia]]
                .map((x) => "<tr><td>" + x[0] + "</td><td><b>" + money(x[1]) + "</b></td></tr>").join("") + "</table>" + (c.notas ? "<p>Notas: " + esc(c.notas) + "</p>" : "") + "</body></html>");
        w.document.close(); w.focus(); w.print();
    }

    // =================================================================
    // CAJA · ACCIONES
    // =================================================================
    async function cajaAbrir() {
        await q(sb.from("caja_turnos").insert({ monto_inicial: Math.max(0, num(valor("ca-inicial"))) }));
        toast("Caja abierta"); await vistaCaja();
    }

    async function cajaMovOk() {
        const concepto = valor("m-concepto"); const monto = num(valor("m-monto"));
        if (!concepto) { toast("Escribí el concepto.", true); return; }
        if (!(monto > 0)) { toast("El monto tiene que ser mayor a 0.", true); return; }
        await q(sb.from("caja_movimientos").insert({ turno_id: S.turno.id, tipo: valor("m-tipo"), concepto, monto }));
        cerrarModal(); toast("Movimiento guardado"); await vistaCaja();
    }

    async function cajaCerrar() {
        S.resumen = await q(sb.rpc("admin_resumen_caja", { p_turno: S.turno.id }));   // datos al día
        abrirCierreCaja();
    }

    async function cajaCerrarOk() {
        if (valor("cc-contado") === "") { toast("Ingresá el efectivo contado.", true); return; }
        const r = await q(sb.rpc("admin_cerrar_caja", { p_turno: S.turno.id, p_contado: num(valor("cc-contado")), p_notas: valor("cc-notas") }));
        cerrarModal();
        const d = Number(r && r.diferencia || 0);
        toast(d === 0 ? "Caja cerrada: sin diferencias ✅" : "Caja cerrada. Diferencia: " + money(d), d !== 0);
        await vistaCaja();
    }

    // =================================================================
    // VENTA DE MOSTRADOR
    // =================================================================
    async function abrirMostrador() {
        await cargarCatalogo();
        S.most = {};
        pintarMostrador(false);
    }

    function pintarMostrador(mantener) {
        const prev = mantener ? { metodo: valor("mo-metodo"), nombre: valor("mo-nombre") } : { metodo: "efectivo", nombre: "" };
        const lista = S.prods.filter((p) => p.visible && !(p.controla_stock && p.stock <= 0));
        const total = lista.reduce((a, p) => a + (S.most[p.id] || 0) * Number(p.precio), 0);
        const unid = Object.values(S.most).reduce((a, b) => a + b, 0);
        abrirModal("<h2>Venta de mostrador</h2><p class='suave' style='margin-bottom:10px'>Cargá lo que se vendió en el local. Queda cobrada y descuenta el stock.</p>" +
            '<div class="tabla-scroll" style="max-height:44vh"><table><tbody>' +
            (lista.length ? lista.map((p) => "<tr><td><strong>" + esc(p.nombre) + '</strong><div class="suave">' + money(p.precio) +
                (p.controla_stock ? " · stock " + p.stock : "") + '</div></td><td style="text-align:right"><div class="stock-ctl" style="justify-content:flex-end">' +
                '<button data-acc="most-menos" data-id="' + p.id + '">−</button><strong>' + (S.most[p.id] || 0) +
                '</strong><button data-acc="most-mas" data-id="' + p.id + '">+</button></div></td></tr>').join("")
                : '<tr><td class="vacio">No hay productos para vender.</td></tr>') + "</tbody></table></div>" +
            '<div class="cols" style="margin-top:12px"><div class="campo"><label>Forma de pago</label><select id="mo-metodo">' +
            Object.keys(METODO).map((k) => '<option value="' + k + '"' + (k === prev.metodo ? " selected" : "") + ">" + METODO[k] + "</option>").join("") + "</select></div>" +
            '<div class="campo"><label>Cliente (opcional)</label><input id="mo-nombre" maxlength="80" value="' + esc(prev.nombre) + '"></div></div>' +
            '<div class="fila"><span><b>Total (' + unid + " unidades)</b></span><strong>" + money(total) + "</strong></div>" +
            '<div class="pie"><button class="btn sec" data-acc="cerrar">Cancelar</button><button class="btn ok" data-acc="most-ok"' + (unid ? "" : " disabled") + ">Cobrar " + (unid ? money(total) : "") + "</button></div>");
    }

    async function mostradorOk() {
        const items = Object.keys(S.most).filter((id) => S.most[id] > 0).map((id) => ({ producto_id: id, cantidad: S.most[id] }));
        if (!items.length) { toast("Elegí al menos un producto.", true); return; }
        const r = await q(sb.rpc("admin_venta_mostrador", { p_items: items, p_metodo: valor("mo-metodo"), p_nombre: valor("mo-nombre") }));
        cerrarModal();
        toast("Venta #" + (r && r.numero) + " cobrada: " + money(r && r.total));
        if (S.tab === "pedidos") await vistaPedidos();
    }

    // =================================================================
    // REPORTES
    // =================================================================
    async function enLotes(ids, consulta, n) {
        const salida = [];
        for (let i = 0; i < ids.length; i += (n || 40)) {
            const parte = await consulta(ids.slice(i, i + (n || 40)));
            salida.push(...parte);
        }
        return salida;
    }

    async function vistaReportes() {
        const h0 = dia0();
        const R = [["hoy", "Hoy", h0], ["7d", "7 días", new Date(h0.getTime() - 6 * 864e5)], ["30d", "30 días", new Date(h0.getTime() - 29 * 864e5)], ["mes", "Este mes", new Date(h0.getFullYear(), h0.getMonth(), 1)]];
        const sel = R.find((r) => r[0] === S.rango) || R[0];
        const peds = await q(sb.from("pedidos").select("*").gte("creado_at", sel[2].toISOString()).order("creado_at", { ascending: false }).limit(2000));
        S.exportar = { peds, etiqueta: sel[1] };
        const ventas = peds.filter((p) => p.estado !== "cancelado" && p.pago_estado === "pagado");
        const cancelados = peds.filter((p) => p.estado === "cancelado").length;
        const sinCobrar = peds.filter((p) => p.estado !== "cancelado" && p.pago_estado === "pendiente");
        const suma = (arr) => arr.reduce((a, p) => a + Number(p.total), 0);
        const total = suma(ventas);
        const por = (k, v) => suma(ventas.filter((p) => p[k] === v));

        const dias = {};
        ventas.forEach((p) => { const d = new Date(p.creado_at); const k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); dias[k] = (dias[k] || 0) + Number(p.total); });
        const claves = Object.keys(dias).sort();
        const maxDia = Math.max(1, ...claves.map((k) => dias[k]));

        const items = await enLotes(ventas.map((p) => p.id), async (ids) => await q(sb.from("pedido_items").select("*").in("pedido_id", ids)));
        const prods = {};
        items.forEach((i) => { const x = prods[i.nombre] || (prods[i.nombre] = { cant: 0, monto: 0 }); x.cant += i.cantidad; x.monto += i.cantidad * Number(i.precio_unitario); });
        const top = Object.keys(prods).map((n) => [n, prods[n]]).sort((a, b) => b[1].cant - a[1].cant).slice(0, 10);

        $("vista").innerHTML = '<div class="barra"><div class="chips">' +
            R.map((r) => '<button class="chip-f' + (S.rango === r[0] ? " act" : "") + '" data-acc="rango" data-r="' + r[0] + '">' + r[1] + "</button>").join("") + '</div><span class="espacio"></span><button class="btn chico sec" data-acc="exportar-csv">⬇ Descargar para Excel</button></div>' +
            '<div class="grid">' +
            '<div class="kpi"><span>Ventas cobradas</span><b>' + money(total) + "</b><span>" + ventas.length + " pedidos</span></div>" +
            '<div class="kpi"><span>Ticket promedio</span><b>' + money(ventas.length ? total / ventas.length : 0) + "</b></div>" +
            '<div class="kpi"><span>Sin cobrar</span><b>' + money(suma(sinCobrar)) + "</b><span>" + sinCobrar.length + " pedidos</span></div>" +
            '<div class="kpi"><span>Cancelados</span><b>' + cancelados + "</b></div></div>" +
            '<div class="dos"><div class="caja"><h3>Por forma de pago</h3>' +
            Object.keys(METODO).map((k) => '<div class="fila"><span>' + METODO[k] + "</span><strong>" + money(por("metodo_pago", k)) + "</strong></div>").join("") +
            '<h3 style="margin-top:14px">Por canal</h3><div class="fila"><span>🌐 Tienda online</span><strong>' + money(por("origen", "web")) + '</strong></div><div class="fila"><span>🏪 Mostrador</span><strong>' + money(por("origen", "mostrador")) + "</strong></div></div>" +
            '<div class="caja"><h3>Más vendidos</h3>' + (top.length ? top.map((t, i) => '<div class="fila"><span>' + (i + 1) + ". " + esc(t[0]) + '</span><strong>' + t[1].cant + " u. · " + money(t[1].monto) + "</strong></div>").join("") : '<p class="suave">Sin ventas en este período.</p>') + "</div></div>" +
            (claves.length > 1 ? '<div class="caja" style="margin-top:12px"><h3>Ventas por día</h3>' + claves.map((k) => '<div class="graf"><span>' + k.slice(8) + "/" + k.slice(5, 7) + '</span><div class="graf-barra"><i style="width:' + Math.round(dias[k] / maxDia * 100) + '%"></i></div><strong>' + money(dias[k]) + "</strong></div>").join("") + "</div>" : "");
    }

    // Exporta todos los pedidos del período a un archivo que abre Excel (CSV con ";" y acentos)
    function celdaCsv(v) {
        let t = String(v === undefined || v === null ? "" : v).replace(/\r?\n/g, " ");
        if (/^[=+\-@\t]/.test(t)) t = "'" + t;               // evita que Excel ejecute fórmulas
        return /[";]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    }

    async function exportarCsv() {
        const ex = S.exportar;
        if (!ex || !ex.peds.length) { toast("No hay pedidos en este período.", true); return; }
        const items = await enLotes(ex.peds.map((p) => p.id), async (ids) => await q(sb.from("pedido_items").select("*").in("pedido_id", ids)));
        const detalle = {};
        items.forEach((i) => {
            const extras = (i.extras || []).map((e) => e.nombre).join(", ");
            const quitar = (i.quitar || []).join(", ");
            (detalle[i.pedido_id] = detalle[i.pedido_id] || []).push(
                i.cantidad + "x " + i.nombre + (extras ? " (+" + extras + ")" : "") + (quitar ? " (sin " + quitar + ")" : ""));
        });
        const num = (n) => String(Number(n) || 0).replace(".", ",");
        const filas = [["Número", "Fecha", "Hora", "Cliente", "Teléfono", "Entrega", "Dirección / Mesa", "Forma de pago", "Estado", "Pago",
                        "Subtotal", "Envío", "Total", "Canal", "Detalle"]];
        ex.peds.slice().reverse().forEach((p) => {
            const d = new Date(p.creado_at);
            const dos = (n) => String(n).padStart(2, "0");
            filas.push([p.numero, dos(d.getDate()) + "/" + dos(d.getMonth() + 1) + "/" + d.getFullYear(), dos(d.getHours()) + ":" + dos(d.getMinutes()),
                p.cliente_nombre, p.cliente_telefono, p.tipo_entrega, p.direccion || p.mesa || "", p.metodo_pago, p.estado, p.pago_estado,
                num(p.subtotal), num(p.envio), num(p.total), p.origen === "mostrador" ? "Mostrador" : "Tienda online", (detalle[p.id] || []).join(" | ")]);
        });
        const csv = "\uFEFF" + filas.map((f) => f.map(celdaCsv).join(";")).join("\r\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "ventas-" + new Date().toISOString().slice(0, 10) + ".csv";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast("Archivo descargado ✅");
    }

    // =================================================================
    // AJUSTES
    // =================================================================
    const TEMAS = {
        oscuro: { colorPrincipal: "#ff7a00", colorTextoBoton: "#ffffff", colorFondo: "#0f0f0f", colorSuperficie: "#151515", colorTexto: "#ffffff", colorTextoSuave: "#aaaaaa" },
        claro: { colorPrincipal: "#e63946", colorTextoBoton: "#ffffff", colorFondo: "#faf7f2", colorSuperficie: "#ffffff", colorTexto: "#222222", colorTextoSuave: "#666666" }
    };
    const CAMPOS_TEMA = [["colorPrincipal", "Color principal (botones)"], ["colorTextoBoton", "Texto de los botones"], ["colorFondo", "Fondo de la página"], ["colorSuperficie", "Tarjetas"], ["colorTexto", "Texto"], ["colorTextoSuave", "Texto suave"]];

    async function vistaAjustes() {
        S.negocio = await q(sb.from("negocio").select("*").eq("id", 1).single());
        const n = S.negocio; const t = Object.assign({}, TEMAS.oscuro, n.tema || {}); const h = n.horarios || {};
        const ck = (id, v, txt) => '<label class="check"><input type="checkbox" id="' + id + '"' + (v ? " checked" : "") + "> " + txt + "</label>";
        const tx = (id, etq, v, extra) => '<div class="campo"><label>' + etq + '</label><input id="' + id + '" value="' + esc(v) + '" ' + (extra || "") + "></div>";
        $("vista").innerHTML = '<div class="dos">' +
            '<div class="caja"><h3>Datos del negocio</h3>' + tx("a-nombre", "Nombre", n.nombre) + tx("a-eslogan", "Frase corta", n.eslogan) +
            '<div class="cols">' + tx("a-ciudad", "Ciudad", n.ciudad) + tx("a-emoji", "Emoji", n.emoji, 'maxlength="4"') + "</div>" +
            tx("a-wsp", "WhatsApp (solo números, con 54...)", n.whatsapp, 'inputmode="tel"') + tx("a-alias", "Alias para transferencias", n.alias_transferencia) +
            tx("a-ig", "Instagram (usuario o link)", n.instagram) + tx("a-dir", "Dirección del local", n.direccion) +
            '<div class="campo"><label>Logo</label><img class="preview" id="a-logo-prev" src="' + esc(n.logo_url) + '" alt=""' + (n.logo_url ? "" : " hidden") + '><input type="file" id="a-logo-file" accept="image/*"><input type="hidden" id="a-logo" value="' + esc(n.logo_url) + '"></div></div>' +

            '<div class="caja"><h3>Colores</h3><div style="margin-bottom:10px"><button class="btn chico sec" data-acc="tema" data-t="oscuro">Oscuro</button> <button class="btn chico sec" data-acc="tema" data-t="claro">Claro</button></div>' +
            CAMPOS_TEMA.map((c) => '<div class="color-fila"><label for="a-' + c[0] + '">' + c[1] + '</label><input type="color" id="a-' + c[0] + '" value="' + esc(t[c[0]]) + '"></div>').join("") + "</div></div>" +

            '<div class="dos"><div class="caja"><h3>Horarios</h3>' + DIAS.map((d) => tx("a-h-" + d[0], d[1], h[d[0]] || "", 'placeholder="09:00 - 18:00 o CERRADO"')).join("") + "</div>" +
            '<div class="caja"><h3>Cierre temporal</h3>' + ck("a-cierre", n.cierre_activo, "<b>Cerrar la tienda ahora</b> (nadie puede pedir)") + tx("a-cierre-msg", "Mensaje", n.cierre_mensaje) +
            '<h3 style="margin-top:14px">Entrega</h3>' + ck("a-retiro", n.permite_retiro, "Retiro en el local") + ck("a-envio", n.permite_envio, "Envío a domicilio") + ck("a-mesa", n.permite_mesa, "Comer en el local (mesa)") +
            '<div class="cols">' + tx("a-env-costo", "Costo de envío ($)", n.envio_costo, 'inputmode="decimal"') + tx("a-env-gratis", "Gratis desde ($, 0 = nunca)", n.envio_gratis_desde, 'inputmode="decimal"') + "</div>" +
            tx("a-env-min", "Pedido mínimo para envío ($, 0 = sin mínimo)", n.envio_minimo, 'inputmode="decimal"') +
            '<h3 style="margin-top:14px">Formas de pago</h3>' + ck("a-ef", n.acepta_efectivo, "💵 Efectivo") + ck("a-tr", n.acepta_transferencia, "🏦 Transferencia") +
            ck("a-mp", n.acepta_mercadopago, "💙 Mercado Pago") + '<div class="ayuda">Mercado Pago solo funciona si cargaste el Access Token en Supabase (ver guía de instalación). Si lo activás sin cargarlo, el cliente verá un error al pagar.</div></div></div>' +

            '<div class="barra" style="margin-top:12px"><span class="espacio"></span><button class="btn" data-acc="ajustes-guardar">Guardar cambios</button></div>' +

            '<div class="caja" style="margin-top:16px"><h3>Cambiar mi contraseña</h3><div class="cols">' + '<div class="campo"><label>Nueva contraseña</label><input id="a-pass1" type="password" autocomplete="new-password"></div>' +
            '<div class="campo"><label>Repetirla</label><input id="a-pass2" type="password" autocomplete="new-password"></div></div><button class="btn sec" data-acc="pass-guardar">Cambiar contraseña</button></div>';
    }

    async function guardarAjustes() {
        const wsp = valor("a-wsp").replace(/\D/g, "");
        if (!valor("a-nombre")) { toast("Falta el nombre del negocio.", true); return; }
        const tema = {}; CAMPOS_TEMA.forEach((c) => { tema[c[0]] = valor("a-" + c[0]); });
        const horarios = {}; DIAS.forEach((d) => { horarios[d[0]] = valor("a-h-" + d[0]) || "CERRADO"; });
        const plata = (id) => Math.max(0, num(valor(id)));
        const datos = {
            nombre: valor("a-nombre"), eslogan: valor("a-eslogan"), ciudad: valor("a-ciudad"), emoji: valor("a-emoji") || "🛍️",
            whatsapp: wsp, alias_transferencia: valor("a-alias"), instagram: valor("a-ig"), direccion: valor("a-dir"), logo_url: valor("a-logo"),
            tema, horarios, cierre_activo: marcado("a-cierre"), cierre_mensaje: valor("a-cierre-msg") || "Estamos cerrados temporalmente.",
            permite_retiro: marcado("a-retiro"), permite_envio: marcado("a-envio"), permite_mesa: marcado("a-mesa"),
            envio_costo: plata("a-env-costo"), envio_gratis_desde: plata("a-env-gratis"), envio_minimo: plata("a-env-min"),
            acepta_efectivo: marcado("a-ef"), acepta_transferencia: marcado("a-tr"), acepta_mercadopago: marcado("a-mp"),
            actualizado_at: new Date().toISOString()
        };
        if (!datos.permite_retiro && !datos.permite_envio && !datos.permite_mesa) { toast("Tiene que haber al menos una forma de entrega.", true); return; }
        if (!datos.acepta_efectivo && !datos.acepta_transferencia && !datos.acepta_mercadopago) { toast("Tiene que haber al menos una forma de pago.", true); return; }
        await q(sb.from("negocio").update(datos).eq("id", 1));
        S.negocio = Object.assign(S.negocio, datos);
        $("top-nombre").textContent = datos.nombre;
        toast("Cambios guardados ✅");
    }

    async function cambiarClave() {
        const a = $("a-pass1").value, b = $("a-pass2").value;
        if (a.length < 8) { toast("Usá al menos 8 caracteres.", true); return; }
        if (a !== b) { toast("Las contraseñas no coinciden.", true); return; }
        const r = await sb.auth.updateUser({ password: a });
        if (r.error) throw r.error;
        $("a-pass1").value = ""; $("a-pass2").value = "";
        toast("Contraseña actualizada ✅");
    }

    // =================================================================
    // ACCIONES (un solo manejador para todos los botones)
    // =================================================================
    const ACCIONES = {
        entrar,
        salir,
        tab: (b) => irA(b.dataset.tab),
        filtro: (b) => { S.filtro = b.dataset.f; return vistaPedidos(); },
        refrescar: () => vistaPedidos(),
        avanzar: (b) => avanzar(b.dataset.id),
        cobrar: (b) => abrirCobro(b.dataset.id, false),
        "cobrar-ok": (b) => cobrarOk(b.dataset.id),
        imprimir: (b) => imprimir(b.dataset.id),
        cancelar: (b) => abrirCancelar(b.dataset.id),
        "cancelar-ok": (b) => cancelarOk(b.dataset.id),
        cerrar: () => cerrarModal(),
        mostrador: () => abrirMostrador(),
        "most-mas": (b) => {
            const p = S.prods.find((x) => x.id === b.dataset.id); const c = S.most[p.id] || 0;
            if (p.controla_stock && c + 1 > p.stock) { toast("No hay más stock de " + p.nombre, true); return; }
            S.most[p.id] = Math.min(50, c + 1); pintarMostrador(true);
        },
        "most-menos": (b) => { S.most[b.dataset.id] = Math.max(0, (S.most[b.dataset.id] || 0) - 1); pintarMostrador(true); },
        "most-ok": () => mostradorOk(),
        sub: (b) => { S.sub = b.dataset.s; return vistaProductos(); },
        "prod-editar": (b) => formProducto(S.prods.find((x) => x.id === b.dataset.id)),
        "prod-guardar": (b) => guardarProducto(b.dataset.id || null),
        "prod-borrar": (b) => borrarProducto(b.dataset.id),
        "prod-borrar-ok": async (b) => { await q(sb.from("productos").delete().eq("id", b.dataset.id)); cerrarModal(); toast("Producto borrado"); await vistaProductos(); },
        "stock-mas-menos": async (b) => { await q(sb.rpc("admin_ajustar_stock", { p_producto: b.dataset.id, p_delta: Number(b.dataset.d), p_motivo: "ajuste", p_nota: "" })); await vistaProductos(); },
        "stock-reponer": (b) => abrirReponer(b.dataset.id),
        "stock-reponer-ok": async (b) => {
            const c = Math.round(num(valor("r-cant")));
            if (!(c > 0)) { toast("Ingresá una cantidad mayor a 0.", true); return; }
            await q(sb.rpc("admin_ajustar_stock", { p_producto: b.dataset.id, p_delta: c, p_motivo: "reposicion", p_nota: valor("r-nota") }));
            cerrarModal(); toast("Stock repuesto"); await vistaProductos();
        },
        "cat-editar": (b) => formCategoria(S.cats.find((x) => x.id === b.dataset.id)),
        "cat-guardar": async (b) => {
            const nombre = valor("c-nombre");
            if (!nombre) { toast("Falta el nombre.", true); return; }
            const datos = { nombre, emoji: valor("c-emoji"), orden: Math.round(num(valor("c-orden"))), visible: marcado("c-vis") };
            if (b.dataset.id) await q(sb.from("categorias").update(datos).eq("id", b.dataset.id));
            else await q(sb.from("categorias").insert(datos));
            cerrarModal(); toast("Categoría guardada"); await vistaProductos();
        },
        "cat-borrar": async (b) => {
            if (!window.confirm("¿Borrar la categoría? Sus productos quedan sin categoría.")) return;
            await q(sb.from("categorias").delete().eq("id", b.dataset.id));
            cerrarModal(); toast("Categoría borrada"); await vistaProductos();
        },
        "caja-abrir": () => cajaAbrir(),
        "caja-mov": () => abrirMovimientoCaja(),
        "caja-mov-ok": () => cajaMovOk(),
        "caja-cerrar": () => cajaCerrar(),
        "caja-cerrar-ok": () => cajaCerrarOk(),
        "caja-ver": (b) => { const c = (S.cerradas || []).find((x) => x.id === b.dataset.id); if (c) verCierre(c); },
        "caja-imprimir": (b) => { const c = (S.cerradas || []).find((x) => x.id === b.dataset.id); if (c) imprimirCierre(c); },
        rango: (b) => { S.rango = b.dataset.r; return vistaReportes(); },
        "exportar-csv": () => exportarCsv(),
        tema: (b) => { const t = TEMAS[b.dataset.t]; CAMPOS_TEMA.forEach((c) => { $("a-" + c[0]).value = t[c[0]]; }); },
        "ajustes-guardar": () => guardarAjustes(),
        "pass-guardar": () => cambiarClave()
    };

    document.addEventListener("click", async (ev) => {
        const m = $("modal");
        if (ev.target === m) { cerrarModal(); return; }
        const b = ev.target.closest("[data-acc]");
        if (!b || b.tagName === "INPUT") return;
        const f = ACCIONES[b.dataset.acc];
        if (!f || b.__ocupado) return;
        b.__ocupado = true;
        try { await f(b); } catch (e) { console.error(e); toast(errorLindo(e), true); } finally { b.__ocupado = false; }
    });

    document.addEventListener("change", async (ev) => {
        const t = ev.target;
        try {
            if (t.dataset && t.dataset.acc === "prod-visible") {
                await q(sb.from("productos").update({ visible: t.checked }).eq("id", t.dataset.id));
                toast(t.checked ? "Visible en la tienda" : "Oculto de la tienda");
            }
            if ((t.id === "p-file" || t.id === "a-logo-file") && t.files && t.files[0]) {
                toast("Subiendo imagen...");
                const url = await subirImagen(t.files[0], t.id === "p-file" ? "productos" : "logo");
                const dest = t.id === "p-file" ? ["p-img", "p-prev"] : ["a-logo", "a-logo-prev"];
                $(dest[0]).value = url; const pv = $(dest[1]); pv.src = url; pv.hidden = false;
                toast("Imagen lista ✅ (guardá para aplicarla)");
            }
        } catch (e) { console.error(e); toast(errorLindo(e), true); }
    });

    document.addEventListener("input", (ev) => {
        const t = ev.target;
        if (t.id === "busca") {
            S.busca = t.value;
            const b = t.value.toLowerCase();
            document.querySelectorAll("#vista tbody tr").forEach((tr) => { tr.hidden = !!b && !tr.textContent.toLowerCase().includes(b); });
        }
        if (t.id === "cc-contado" && S.resumen) {
            const d = num(t.value) - Number(S.resumen.esperado_efectivo || 0);
            const el = $("cc-dif");
            el.hidden = t.value === "";
            el.textContent = d === 0 ? "✅ Coincide con lo esperado." : (d > 0 ? "Sobran " : "Faltan ") + money(Math.abs(d)) + " respecto de lo esperado.";
        }
    });

    document.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.target.id === "l-pass" || ev.target.id === "l-email")) ACCIONES.entrar();
        if (ev.key === "Escape" && !$("modal").hidden) cerrarModal();
    });

    // =================================================================
    // ARRANQUE
    // =================================================================
    let iniciado = false;
    async function iniciar() {
        if (iniciado) return;
        iniciado = true;
        const e = $("l-error");
        if (!CFG.SUPABASE_URL || /TU-PROYECTO/i.test(CFG.SUPABASE_URL)) {
            e.textContent = "Falta configurar la conexión: completá config.js (SUPABASE_URL y SUPABASE_CLAVE_PUBLICA)."; e.hidden = false; return;
        }
        if (!window.supabase) { e.textContent = "No se pudo cargar. Revisá tu conexión a internet y recargá."; e.hidden = false; return; }
        sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_CLAVE_PUBLICA);
        try {
            const ses = await sb.auth.getSession();
            if (ses.data && ses.data.session) await abrirApp();
        } catch (err) { console.error(err); }
    }
    document.addEventListener("DOMContentLoaded", iniciar);
    if (document.readyState !== "loading") iniciar();
})();
