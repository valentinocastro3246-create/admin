// =====================================================================
// TIENDA PÚBLICA — lee productos y stock de Supabase y envía pedidos
// a la función "crear-pedido". No contiene datos de ningún negocio.
// =====================================================================
(function () {
    "use strict";

    const CFG = window.PRO_CONFIG || {};
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s === undefined || s === null ? "" : s)
        .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const money = (n) => "$" + Number(n || 0).toLocaleString("es-AR");
    const CLAVE_CARRITO = "pro_carrito_v1";
    const CLAVE_CLIENTE = "pro_cliente_v1";

    let sb = null;
    let N = {};            // negocio
    let categorias = [];
    let productos = [];
    let carrito = [];      // { key, producto_id, nombre, precio, cantidad, extras:[{nombre,precio}], quitar:[], nota }
    let enviando = false;

    // ---------- utilidades ----------
    function leer(clave, defecto) {
        try { const v = localStorage.getItem(clave); return v ? JSON.parse(v) : defecto; } catch (e) { return defecto; }
    }
    function guardar(clave, valor) { try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* sin almacenamiento */ } }

    let toastTimer;
    function toast(msg) {
        const t = $("toast");
        t.textContent = msg; t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
    }

    function estadoLocal() {
        if (N.cierre_activo) return { abierto: false, texto: "Cerrado temporalmente" };
        const dias = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
        const h = (N.horarios || {})[dias[new Date().getDay()]];
        if (!h || /cerrado/i.test(h)) return { abierto: false, texto: "Cerrado hoy" };
        const m = String(h).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (!m) return { abierto: true, texto: "Hoy: " + h };
        const ahora = new Date().getHours() * 60 + new Date().getMinutes();
        const ini = +m[1] * 60 + +m[2];
        const fin = +m[3] * 60 + +m[4];
        const abierto = fin > ini ? (ahora >= ini && ahora < fin) : (ahora >= ini || ahora < fin);
        return { abierto, texto: (abierto ? "Abierto ahora · " : "Cerrado · hoy ") + h };
    }

    const agotado = (p) => p.controla_stock && p.stock <= 0;
    const ultimas = (p) => p.controla_stock && p.stock > 0 && p.stock <= Math.max(Number(p.stock_minimo) || 0, 3);
    const porId = (id) => productos.find((p) => p.id === id);

    function enCarrito(productoId) {
        return carrito.filter((l) => l.producto_id === productoId).reduce((a, l) => a + l.cantidad, 0);
    }

    // ---------- tema ----------
    function aplicarTema() {
        const t = N.tema || {};
        const r = document.documentElement.style;
        const mapa = { colorPrincipal: "--c-principal", colorTextoBoton: "--c-texto-boton", colorFondo: "--c-fondo",
            colorSuperficie: "--c-superficie", colorTexto: "--c-texto", colorTextoSuave: "--c-texto-suave" };
        Object.keys(mapa).forEach((k) => { if (t[k]) r.setProperty(mapa[k], t[k]); });
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta && t.colorFondo) meta.setAttribute("content", t.colorFondo);
    }

    // ---------- carga de datos ----------
    async function cargarProductos() {
        const [c, p] = await Promise.all([
            sb.from("categorias").select("*").order("orden", { ascending: true }).order("nombre", { ascending: true }),
            sb.from("productos").select("*").order("orden", { ascending: true }).order("nombre", { ascending: true })
        ]);
        if (c.error) throw c.error;
        if (p.error) throw p.error;
        categorias = c.data || [];
        productos = p.data || [];
    }

    async function cargar() {
        const n = await sb.from("negocio").select("*").eq("id", 1).single();
        if (n.error) throw n.error;
        N = n.data || {};
        await cargarProductos();
    }

    // ---------- carrito ----------
    function validarCarrito() {
        carrito = carrito.filter((l) => {
            const p = porId(l.producto_id);
            return p && !agotado(p);
        });
        carrito.forEach((l) => {
            const p = porId(l.producto_id);
            l.nombre = p.nombre;
            if (p.controla_stock) {
                const otros = carrito.filter((x) => x.producto_id === l.producto_id && x !== l).reduce((a, x) => a + x.cantidad, 0);
                l.cantidad = Math.max(1, Math.min(l.cantidad, p.stock - otros));
            }
            const extras = (p.extras || []);
            l.extras = l.extras.filter((e) => extras.some((x) => x.nombre === e.nombre));
            l.extras.forEach((e) => { e.precio = Number(extras.find((x) => x.nombre === e.nombre).precio) || 0; });
            l.precio = Number(p.precio) + l.extras.reduce((a, e) => a + e.precio, 0);
        });
        guardar(CLAVE_CARRITO, carrito);
    }

    const subtotal = () => carrito.reduce((a, l) => a + l.precio * l.cantidad, 0);
    const unidades = () => carrito.reduce((a, l) => a + l.cantidad, 0);

    function envioEstimado(sub, tipo) {
        if (tipo !== "envio") return 0;
        const costo = Number(N.envio_costo) || 0;
        const gratis = Number(N.envio_gratis_desde) || 0;
        if (costo > 0 && !(gratis > 0 && sub >= gratis)) return costo;
        return 0;
    }

    function agregar(producto, cantidad, extras, quitar, nota) {
        const key = [producto.id, extras.map((e) => e.nombre).sort().join(","), quitar.slice().sort().join(","), nota].join("|");
        const ya = enCarrito(producto.id);
        if (producto.controla_stock && ya + cantidad > producto.stock) {
            toast("Solo quedan " + producto.stock + " unidades de " + producto.nombre);
            return false;
        }
        const linea = carrito.find((l) => l.key === key);
        const precio = Number(producto.precio) + extras.reduce((a, e) => a + e.precio, 0);
        if (linea) linea.cantidad += cantidad;
        else carrito.push({ key, producto_id: producto.id, nombre: producto.nombre, precio, cantidad, extras, quitar, nota });
        guardar(CLAVE_CARRITO, carrito);
        pintarBarra();
        toast("Agregado: " + producto.nombre);
        return true;
    }

    // ---------- pintar menú ----------
    function pintarCabecera() {
        document.title = N.nombre || "Tienda";
        $("nombre").textContent = N.nombre || "";
        $("eslogan").textContent = N.eslogan || "";
        const logo = $("logo");
        if (N.logo_url) { logo.src = N.logo_url; logo.alt = N.nombre; logo.hidden = false; } else { logo.hidden = true; }

        const e = estadoLocal();
        const el = $("estado");
        el.hidden = false;
        el.className = "estado " + (e.abierto ? "abierto" : "cerrado");
        el.textContent = (e.abierto ? "🟢 " : "🔴 ") + e.texto;

        const aviso = $("aviso-cierre");
        if (N.cierre_activo) { aviso.textContent = N.cierre_mensaje || "Estamos cerrados temporalmente."; aviso.hidden = false; } else { aviso.hidden = true; }

        // Vista previa y descripción para buscadores
        const desc = N.eslogan || "Pedí online.";
        [['meta[name="description"]', desc], ['meta[property="og:title"]', N.nombre], ['meta[property="og:description"]', desc]].forEach((x) => {
            const m = document.querySelector(x[0]);
            if (m && x[1]) m.setAttribute("content", x[1]);
        });

        // Botones flotantes
        const fl = [];
        const wsp = String(N.whatsapp || "").replace(/\D/g, "");
        if (wsp) fl.push('<a class="wsp" href="https://wa.me/' + wsp + '" target="_blank" rel="noopener">💬 WhatsApp</a>');
        if (N.instagram) {
            const ig = /^https?:/i.test(N.instagram) ? N.instagram : "https://instagram.com/" + String(N.instagram).replace(/^@/, "");
            fl.push('<a class="ig" href="' + esc(ig) + '" target="_blank" rel="noopener">📷 Instagram</a>');
        }
        $("flotantes").innerHTML = fl.join("");

        // Información
        const dias = [["lunes", "Lunes"], ["martes", "Martes"], ["miercoles", "Miércoles"], ["jueves", "Jueves"], ["viernes", "Viernes"], ["sabado", "Sábado"], ["domingo", "Domingo"]];
        const hs = N.horarios || {};
        let info = '<div class="caja"><h3>🕒 Horarios</h3><ul>' +
            dias.map((d) => "<li><span>" + d[1] + "</span><strong>" + esc(hs[d[0]] || "—") + "</strong></li>").join("") + "</ul></div>";
        if (N.direccion) info += '<div class="caja"><h3>📍 Ubicación</h3><p>' + esc(N.direccion) + (N.ciudad ? "<br>" + esc(N.ciudad) : "") + "</p></div>";
        const envios = [];
        if (N.permite_envio) envios.push("Envío a domicilio" + (Number(N.envio_costo) > 0 ? " (" + money(N.envio_costo) + ")" : ""));
        if (Number(N.envio_gratis_desde) > 0 && N.permite_envio) envios.push("Envío gratis desde " + money(N.envio_gratis_desde));
        if (Number(N.envio_minimo) > 0 && N.permite_envio) envios.push("Pedido mínimo para envío: " + money(N.envio_minimo));
        if (N.permite_retiro) envios.push("Retiro en el local");
        if (envios.length) info += '<div class="caja"><h3>🛵 Entrega</h3><p>' + envios.map(esc).join("<br>") + "</p></div>";
        $("info").innerHTML = info;
        $("pie").textContent = "© " + new Date().getFullYear() + " " + (N.nombre || "") + (N.ciudad ? " — " + N.ciudad : "");
    }

    function tarjeta(p) {
        const ag = agotado(p);
        const opciones = (p.extras && p.extras.length) || (p.quitables && p.quitables.length);
        const etiqueta = ag ? '<span class="etiqueta">Agotado</span>'
            : ultimas(p) ? '<span class="etiqueta alerta">¡Últimas unidades!</span>'
            : p.etiqueta ? '<span class="etiqueta">' + esc(p.etiqueta) + "</span>" : "";
        return '<div class="tarjeta' + (ag ? " agotado" : "") + (p.imagen_url ? "" : " sin-img") + '">' + etiqueta +
            (p.imagen_url ? '<img loading="lazy" src="' + esc(p.imagen_url) + '" alt="' + esc(p.nombre) + '">' : "") +
            '<div class="cuerpo"><h3>' + esc(p.nombre) + "</h3><p>" + esc(p.descripcion) + "</p>" +
            '<span class="precio">' + money(p.precio) + "</span>" +
            '<button class="btn" data-prod="' + p.id + '"' + (ag || N.cierre_activo ? " disabled" : "") + ">" +
            (ag ? "Agotado" : N.cierre_activo ? "Cerrado" : opciones ? "Elegir" : "Agregar") + "</button></div></div>";
    }

    function pintarMenu() {
        const grupos = categorias.map((c) => ({ c, lista: productos.filter((p) => p.categoria_id === c.id) })).filter((g) => g.lista.length);
        const sueltos = productos.filter((p) => !categorias.some((c) => c.id === p.categoria_id));
        if (sueltos.length) grupos.push({ c: { id: "otros", nombre: "Otros", emoji: "🍽️" }, lista: sueltos });

        $("chips").innerHTML = grupos.map((g) => '<a href="#cat-' + g.c.id + '">' + esc(g.c.nombre) + "</a>").join("");
        $("chips").hidden = grupos.length < 2;
        $("menu").innerHTML = grupos.length
            ? grupos.map((g) => '<section class="categoria"><h2 id="cat-' + g.c.id + '">' + esc((g.c.emoji ? g.c.emoji + " " : "") + g.c.nombre) + '</h2><div class="grilla">' + g.lista.map(tarjeta).join("") + "</div></section>").join("")
            : '<p style="text-align:center;color:var(--c-texto-suave);padding:40px 0">Todavía no hay productos cargados.</p>';
    }

    function pintarBarra() {
        const b = $("barra-carrito");
        const u = unidades();
        if (!u) { b.hidden = true; return; }
        b.hidden = false;
        b.innerHTML = "<span>🛒 Ver mi pedido (" + u + ")</span><span>" + money(subtotal()) + "</span>";
    }

    // ---------- modal de producto ----------
    function abrirProducto(p) {
        const extras = p.extras || [];
        const quitables = p.quitables || [];
        let cant = 1;
        const m = $("modal-prod");

        function total() {
            const sel = [...m.querySelectorAll("input[data-extra]:checked")].map((i) => Number(i.dataset.precio));
            return (Number(p.precio) + sel.reduce((a, b) => a + b, 0)) * cant;
        }
        function actualizar() {
            m.querySelector("#cant-prod").textContent = cant;
            m.querySelector("#btn-agregar").textContent = "Agregar · " + money(total());
        }

        m.innerHTML = '<div class="hoja"><button class="cerrar" data-cerrar>✕</button><h2>' + esc(p.nombre) + '</h2><p class="sub">' + esc(p.descripcion) + "</p>" +
            (quitables.length ? '<div class="grupo-titulo">¿Querés sacar algo?</div>' + quitables.map((q) =>
                '<label class="opcion"><input type="checkbox" data-quitar="' + esc(q) + '"><span>Sin ' + esc(q) + "</span></label>").join("") : "") +
            (extras.length ? '<div class="grupo-titulo">Extras</div>' + extras.map((e) =>
                '<label class="opcion"><input type="checkbox" data-extra="' + esc(e.nombre) + '" data-precio="' + Number(e.precio) + '"><span>' + esc(e.nombre) +
                "</span><strong>+" + money(e.precio) + "</strong></label>").join("") : "") +
            '<div class="campo" style="margin-top:14px"><label>Aclaración (opcional)</label><input id="nota-prod" maxlength="200" placeholder="Ej: bien cocida"></div>' +
            '<div class="cantidad" style="margin:14px 0"><button data-menos>−</button><span id="cant-prod">1</span><button data-mas>+</button></div>' +
            '<button class="btn bloque" id="btn-agregar"></button></div>';
        m.hidden = false;
        actualizar();

        m.onclick = (ev) => {
            const t = ev.target;
            if (t === m || t.hasAttribute("data-cerrar")) { m.hidden = true; return; }
            if (t.hasAttribute("data-menos")) { cant = Math.max(1, cant - 1); actualizar(); }
            if (t.hasAttribute("data-mas")) {
                const tope = p.controla_stock ? p.stock - enCarrito(p.id) : 50;
                if (cant < Math.min(50, tope)) cant += 1; else toast("No hay más stock disponible");
                actualizar();
            }
            if (t.id === "btn-agregar") {
                const ex = [...m.querySelectorAll("input[data-extra]:checked")].map((i) => ({ nombre: i.dataset.extra, precio: Number(i.dataset.precio) }));
                const qu = [...m.querySelectorAll("input[data-quitar]:checked")].map((i) => i.dataset.quitar);
                if (agregar(p, cant, ex, qu, $("nota-prod").value.trim())) m.hidden = true;
            }
        };
        m.onchange = actualizar;
    }

    // ---------- carrito / checkout ----------
    function opcionesEntrega() {
        const o = [];
        if (N.permite_retiro) o.push(["retiro", "🏪 Retiro en el local"]);
        if (N.permite_envio) o.push(["envio", "🛵 Envío a domicilio"]);
        if (N.permite_mesa) o.push(["mesa", "🪑 Comer en el local"]);
        return o;
    }
    function opcionesPago() {
        const o = [];
        if (N.acepta_efectivo) o.push(["efectivo", "💵 Efectivo"]);
        if (N.acepta_transferencia) o.push(["transferencia", "🏦 Transferencia"]);
        if (N.acepta_mercadopago) o.push(["mercadopago", "💙 Mercado Pago (tarjeta, dinero en cuenta)"]);
        return o;
    }

    function abrirCarrito() {
        const m = $("modal-carrito");
        const cli = leer(CLAVE_CLIENTE, {});
        const ent = opcionesEntrega();
        const pag = opcionesPago();
        let tipo = ent.length ? ent[0][0] : "";
        let metodo = pag.length ? pag[0][0] : "";

        function pintar(mensajeError) {
            const sub = subtotal();
            const env = envioEstimado(sub, tipo);
            const falta = tipo === "envio" && Number(N.envio_minimo) > sub ? Number(N.envio_minimo) - sub : 0;

            m.innerHTML = '<div class="hoja"><button class="cerrar" data-cerrar>✕</button><h2>Tu pedido</h2>' +
                (carrito.length ? carrito.map((l, i) =>
                    '<div class="linea"><div><strong>' + esc(l.nombre) + "</strong>" +
                    (l.quitar.length ? "<small>Sin: " + esc(l.quitar.join(", ")) + "</small>" : "") +
                    (l.extras.length ? "<small>Extras: " + esc(l.extras.map((e) => e.nombre).join(", ")) + "</small>" : "") +
                    (l.nota ? "<small>“" + esc(l.nota) + "”</small>" : "") +
                    "<small>" + money(l.precio) + ' c/u</small></div><div class="cantidad"><button data-menos="' + i + '">−</button><span>' + l.cantidad + '</span><button data-mas="' + i + '">+</button></div></div>').join("")
                    : '<p class="sub">Tu pedido está vacío.</p>') +
                (carrito.length ? '<div class="totales" style="margin:12px 0"><div class="linea"><span>Subtotal</span><span>' + money(sub) + "</span></div>" +
                    (tipo === "envio" ? '<div class="linea"><span>Envío</span><span>' + (env ? money(env) : "Gratis") + "</span></div>" : "") +
                    '<div class="linea total"><span>Total</span><span>' + money(sub + env) + "</span></div></div>" +
                    '<div class="campo"><label>Tu nombre *</label><input id="f-nombre" maxlength="80" value="' + esc(cli.nombre || "") + '"></div>' +
                    '<div class="campo"><label>Teléfono / WhatsApp *</label><input id="f-tel" type="tel" maxlength="30" value="' + esc(cli.telefono || "") + '"></div>' +
                    '<div class="campo"><label>¿Cómo querés recibir tu pedido?</label>' + ent.map((o) =>
                        '<label class="opcion"><input type="radio" name="tipo" value="' + o[0] + '"' + (o[0] === tipo ? " checked" : "") + "><span>" + o[1] + "</span></label>").join("") + "</div>" +
                    (tipo === "envio" ? '<div class="campo"><label>Dirección de entrega *</label><input id="f-dir" maxlength="200" value="' + esc(cli.direccion || "") + '"></div>' : "") +
                    (tipo === "mesa" ? '<div class="campo"><label>Número de mesa *</label><input id="f-mesa" maxlength="20"></div>' : "") +
                    '<div class="campo"><label>Forma de pago</label>' + pag.map((o) =>
                        '<label class="opcion"><input type="radio" name="metodo" value="' + o[0] + '"' + (o[0] === metodo ? " checked" : "") + "><span>" + o[1] + "</span></label>").join("") + "</div>" +
                    '<div class="campo"><label>Observaciones (opcional)</label><textarea id="f-notas" rows="2" maxlength="500"></textarea></div>' +
                    (falta ? '<div class="error">Pedido mínimo para envío: ' + money(N.envio_minimo) + " (te faltan " + money(falta) + ").</div>" : "") +
                    (N.cierre_activo ? '<div class="error">' + esc(N.cierre_mensaje || "Estamos cerrados.") + "</div>" : "") +
                    (!ent.length || !pag.length ? '<div class="error">El negocio todavía no habilitó formas de entrega o de pago.</div>' : "") +
                    (mensajeError ? '<div class="error">' + esc(mensajeError) + "</div>" : "") +
                    '<button class="btn bloque" id="btn-confirmar"' + (falta || N.cierre_activo || !ent.length || !pag.length ? " disabled" : "") + ">" +
                    (metodo === "mercadopago" ? "Pagar con Mercado Pago · " : "Confirmar pedido · ") + money(sub + env) + "</button>" : "") +
                "</div>";
            m.hidden = false;
        }

        function recordarCampos() {
            const g = (id) => { const e = m.querySelector(id); return e ? e.value : ""; };
            const c = leer(CLAVE_CLIENTE, {});
            const n = g("#f-nombre"), t = g("#f-tel"), d = g("#f-dir");
            m.__borrador = { nombre: n, telefono: t, direccion: d, mesa: g("#f-mesa"), notas: g("#f-notas") };
            cli.nombre = n || c.nombre; cli.telefono = t || c.telefono; cli.direccion = d || c.direccion;
        }
        function restaurarCampos() {
            const b = m.__borrador || {};
            [["#f-nombre", b.nombre], ["#f-tel", b.telefono], ["#f-dir", b.direccion], ["#f-mesa", b.mesa], ["#f-notas", b.notas]].forEach((x) => {
                const e = m.querySelector(x[0]); if (e && x[1] !== undefined) e.value = x[1];
            });
        }

        pintar();

        m.onclick = async (ev) => {
            const t = ev.target;
            if (t === m || t.hasAttribute("data-cerrar")) { m.hidden = true; return; }
            if (t.dataset.menos !== undefined || t.dataset.mas !== undefined) {
                recordarCampos();
                const i = Number(t.dataset.menos !== undefined ? t.dataset.menos : t.dataset.mas);
                const l = carrito[i];
                if (t.dataset.menos !== undefined) { l.cantidad -= 1; if (l.cantidad < 1) carrito.splice(i, 1); }
                else {
                    const p = porId(l.producto_id);
                    if (p && p.controla_stock && enCarrito(p.id) + 1 > p.stock) toast("No hay más stock disponible"); else l.cantidad = Math.min(50, l.cantidad + 1);
                }
                guardar(CLAVE_CARRITO, carrito); pintarBarra(); pintar(); restaurarCampos();
                return;
            }
            if (t.id === "btn-confirmar") await confirmar();
        };
        m.onchange = (ev) => {
            if (ev.target.name === "tipo" || ev.target.name === "metodo") {
                recordarCampos();
                if (ev.target.name === "tipo") tipo = ev.target.value; else metodo = ev.target.value;
                pintar(); restaurarCampos();
            }
        };

        async function confirmar() {
            if (enviando) return;
            const g = (id) => { const e = m.querySelector(id); return e ? e.value.trim() : ""; };
            const datos = { nombre: g("#f-nombre"), telefono: g("#f-tel"), tipo_entrega: tipo, direccion: g("#f-dir"), mesa: g("#f-mesa"), notas: g("#f-notas"), metodo_pago: metodo };
            if (!datos.nombre) return aviso("Ingresá tu nombre.");
            if (datos.telefono.replace(/\D/g, "").length < 6) return aviso("Ingresá un teléfono de contacto.");
            if (tipo === "envio" && !datos.direccion) return aviso("Ingresá la dirección de entrega.");
            if (tipo === "mesa" && !datos.mesa) return aviso("Ingresá el número de mesa.");

            function aviso(msg) { recordarCampos(); pintar(msg); restaurarCampos(); }

            enviando = true;
            const btn = m.querySelector("#btn-confirmar");
            btn.disabled = true; btn.textContent = "Enviando...";
            guardar(CLAVE_CLIENTE, { nombre: datos.nombre, telefono: datos.telefono, direccion: datos.direccion });

            try {
                const r = await fetch(CFG.SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/crear-pedido", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_CLAVE_PUBLICA },
                    body: JSON.stringify({
                        ...datos,
                        items: carrito.map((l) => ({ producto_id: l.producto_id, cantidad: l.cantidad, extras: l.extras.map((e) => e.nombre), quitar: l.quitar, nota: l.nota }))
                    })
                });
                let j = {};
                try { j = await r.json(); } catch (e) { /* respuesta sin cuerpo */ }

                if (!r.ok) {
                    if (j.error === "SIN_STOCK" || j.error === "PRODUCTO_NO_DISPONIBLE") {
                        await cargarProductos(); validarCarrito(); pintarMenu(); pintarBarra();
                    }
                    enviando = false;
                    aviso(j.mensaje || "No pudimos registrar tu pedido. Probá de nuevo.");
                    return;
                }

                carrito = []; guardar(CLAVE_CARRITO, carrito); pintarBarra();
                if (j.init_point) { window.location.href = j.init_point; return; }
                enviando = false;
                m.hidden = true;
                confirmado(j, datos);
            } catch (e) {
                enviando = false;
                aviso("No hay conexión. Revisá tu internet e intentá de nuevo.");
            }
        }
    }

    function confirmado(j, datos) {
        const m = $("modal-ok");
        const wsp = String(N.whatsapp || "").replace(/\D/g, "");
        const seg = "seguimiento.html?id=" + j.pedido_id;
        let extra = "";
        if (j.metodo_pago === "transferencia") {
            extra = '<div class="nota-pago"><strong>Transferí ' + money(j.total) + "</strong>" +
                (N.alias_transferencia ? " al alias <strong>" + esc(N.alias_transferencia) + "</strong>" : "") +
                " y enviá el comprobante por WhatsApp para que confirmemos tu pedido.</div>";
        } else if (j.metodo_pago === "efectivo") {
            extra = '<div class="nota-pago">Pagás en efectivo al ' + (datos.tipo_entrega === "envio" ? "recibir" : "retirar") + ": <strong>" + money(j.total) + "</strong>.</div>";
        }
        const texto = encodeURIComponent("Hola! Hice el pedido #" + j.numero + " a nombre de " + datos.nombre + "." + (j.metodo_pago === "transferencia" ? " Te envío el comprobante." : ""));
        m.innerHTML = '<div class="hoja" style="text-align:center"><div class="ok-icono">✅</div><h2>¡Pedido recibido!</h2>' +
            '<p class="sub">Tu número de pedido es <strong>#' + esc(j.numero) + "</strong></p>" + extra +
            '<a class="btn bloque" href="' + seg + '">Seguir mi pedido</a>' +
            (wsp ? '<a class="btn sec bloque" style="margin-top:8px" target="_blank" rel="noopener" href="https://wa.me/' + wsp + "?text=" + texto + '">💬 Escribir por WhatsApp</a>' : "") +
            '<button class="btn sec bloque" style="margin-top:8px" data-cerrar>Cerrar</button></div>';
        m.hidden = false;
        m.onclick = (ev) => { if (ev.target === m || ev.target.hasAttribute("data-cerrar")) m.hidden = true; };
    }

    // ---------- arranque ----------
    function mostrarProblema(titulo, detalle) {
        $("nombre").textContent = titulo;
        $("eslogan").textContent = detalle;
        $("menu").innerHTML = "";
    }

    let iniciado = false;
    async function iniciar() {
        if (iniciado) return;      // evita arrancar dos veces (duplicaría los botones)
        iniciado = true;
        if (!CFG.SUPABASE_URL || /TU-PROYECTO/i.test(CFG.SUPABASE_URL)) {
            return mostrarProblema("Falta configurar", "Completá SUPABASE_URL y SUPABASE_CLAVE_PUBLICA en web/config.js.");
        }
        if (!window.supabase) {
            return mostrarProblema("No se pudo cargar", "Revisá tu conexión a internet y recargá la página.");
        }
        sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_CLAVE_PUBLICA);

        try {
            await cargar();
        } catch (e) {
            console.error(e);
            return mostrarProblema("No pudimos cargar el menú", "Probá de nuevo en unos minutos.");
        }

        carrito = leer(CLAVE_CARRITO, []);
        if (!Array.isArray(carrito)) carrito = [];
        validarCarrito();
        aplicarTema();
        pintarCabecera();
        pintarMenu();
        pintarBarra();

        $("menu").addEventListener("click", (ev) => {
            const b = ev.target.closest("[data-prod]");
            if (!b || b.disabled) return;
            const p = porId(b.dataset.prod);
            if (!p) return;
            if ((p.extras && p.extras.length) || (p.quitables && p.quitables.length)) abrirProducto(p);
            else agregar(p, 1, [], [], "");
        });
        $("barra-carrito").addEventListener("click", abrirCarrito);

        // Al volver a la pestaña, se refrescan precios y stock
        document.addEventListener("visibilitychange", async () => {
            if (document.visibilityState !== "visible") return;
            try { await cargar(); validarCarrito(); aplicarTema(); pintarCabecera(); pintarMenu(); pintarBarra(); } catch (e) { /* se mantiene lo mostrado */ }
        });
    }

    document.addEventListener("DOMContentLoaded", iniciar);
    if (document.readyState !== "loading") iniciar();
})();
