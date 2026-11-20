"use strict";
// Vinilo (web): escanea el QR de una carta y hace sonar el tema por Spotify, sin mostrar título/artista/año
// hasta que se toque «Mostrar info». Requiere Spotify Premium con sesión iniciada en este navegador.

const $ = (id) => document.getElementById(id);
const QR_RE = /(?:open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/;

let DATOS = { cartas: {}, redir: {} };
let actual = null;           // track_id que suena
let pausado = true;
let ultimoLeido = "";
let ultimoCambio = 0;
let escaneando = false;
let detector = null;

// ---------- Surcos del disco ----------
(function surcos() {
  const g = $("surcos"); let k = 0;
  for (let r = 40; r < 91; r += 1.7, k++) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("r", r);
    c.setAttribute("stroke", k % 7 === 0 ? "#050505" : "#1b1b1b");
    c.setAttribute("stroke-width", k % 7 === 0 ? 0.6 : 0.25);
    g.appendChild(c);
  }
})();

// ---------- Datos ----------
async function cargarDatos() {
  try { DATOS = await (await fetch("cartas.json")).json(); } catch (e) { /* sin datos: igual suena */ }
}

// ---------- Spotify: la web manda la orden a la app de Spotify del celular (Web API, login PKCE) ----------
// Cada persona usa su PROPIA app de Spotify (su propio Client ID), así no comparten el cupo de 5 usuarios.
function clientId() { try { return localStorage.getItem("sp_client_id") || window.VINILO_CLIENT_ID || ""; } catch (e) { return window.VINILO_CLIENT_ID || ""; } }
const ID_VALIDO = /^[0-9a-f]{32}$/i;
const SCOPES = "user-modify-playback-state user-read-playback-state user-read-private";
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, "");
let ultimaOrden = 0;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function guardarTokens(t) { try { if (t) localStorage.setItem("sp_tokens", JSON.stringify(t)); } catch (e) { /* sin almacenamiento */ } }
function leerTokens() { try { return JSON.parse(localStorage.getItem("sp_tokens") || "null"); } catch (e) { return null; } }

async function iniciarSesionSpotify() {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  const verificador = b64url(bytes);
  const desafio = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verificador)));
  try { localStorage.setItem("sp_verificador", verificador); } catch (e) { /* sin almacenamiento */ }
  const p = new URLSearchParams({ client_id: clientId(), response_type: "code", redirect_uri: REDIRECT, scope: SCOPES, code_challenge_method: "S256", code_challenge: desafio });
  location.href = "https://accounts.spotify.com/authorize?" + p;
}

async function pedirToken(cuerpo) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId(), ...cuerpo }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const prev = leerTokens() || {};
  const t = { access: j.access_token, refresh: j.refresh_token || prev.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
  guardarTokens(t);
  return t;
}

/** Si volvemos de Spotify con ?code=..., lo cambia por el token. */
async function terminarLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  if (q.get("error")) { history.replaceState({}, "", REDIRECT); return "Spotify no autorizó la app: " + q.get("error"); }
  if (!code) return "";
  const verificador = localStorage.getItem("sp_verificador") || "";
  history.replaceState({}, "", REDIRECT);
  const t = await pedirToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verificador });
  return t ? "" : "No se pudo completar el inicio de sesión con Spotify";
}

async function tokenValido() {
  let t = leerTokens();
  if (!t) return null;
  if (Date.now() < t.exp) return t.access;
  if (!t.refresh) return null;
  t = await pedirToken({ grant_type: "refresh_token", refresh_token: t.refresh });
  return t ? t.access : null;
}

async function api(metodo, ruta, cuerpo) {
  const tk = await tokenValido();
  if (!tk) return { status: 401 };
  const r = await fetch("https://api.spotify.com/v1" + ruta, {
    method: metodo, headers: { Authorization: "Bearer " + tk, ...(cuerpo ? { "Content-Type": "application/json" } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let json = null;
  if (r.status === 200) { try { json = await r.json(); } catch (e) { /* sin cuerpo */ } }
  return { status: r.status, json };
}

async function reproducir(id) {
  actual = id;
  ultimaOrden = Date.now();
  marcarPausa(false);
  const cuerpo = { uris: ["spotify:track:" + id] };
  let r = await api("PUT", "/me/player/play", cuerpo);
  if (r.status === 404) {
    // Sin dispositivo activo: se usa el celular si la app de Spotify está abierta o en segundo plano.
    const d = await api("GET", "/me/player/devices");
    const lista = (d.json && d.json.devices) || [];
    const dev = lista.find((x) => x.is_active) || lista.find((x) => /smartphone|tablet/i.test(x.type)) || lista[0];
    if (!dev) { marcarPausa(true); estado("Abrí la app de Spotify, poné cualquier tema un segundo y volvé a escanear"); return; }
    r = await api("PUT", "/me/player/play?device_id=" + encodeURIComponent(dev.id), cuerpo);
  }
  if (r.status === 204 || r.status === 200) { estado(DATOS.cartas[id] ? "" : "Esta carta no es de tu mazo"); return; }
  marcarPausa(true);
  if (r.status === 401) estado("Se venció la sesión de Spotify: cerrá y abrí la app");
  else if (r.status === 403) estado("Spotify respondió que hace falta Premium o que esta cuenta no está autorizada");
  else estado("Spotify respondió con error " + r.status);
}

async function alternarPausa() {
  ultimaOrden = Date.now();
  if (pausado) { marcarPausa(false); await api("PUT", "/me/player/play"); }
  else { marcarPausa(true); await api("PUT", "/me/player/pause"); }
}

// Sincroniza el icono si se pausa desde la propia app de Spotify.
setInterval(async () => {
  if ($("principal").hidden || Date.now() - ultimaOrden < 3000) return;
  const r = await api("GET", "/me/player");
  if (r.status === 200 && r.json) marcarPausa(!r.json.is_playing);
}, 3000);

function marcarPausa(p) {
  pausado = p;
  $("disco").classList.toggle("suena", !p);
  $("icoPausa").hidden = p;
  $("icoPlay").hidden = !p;
  $("btnPlay").setAttribute("aria-label", p ? "Reanudar" : "Pausar");
}

$("btnPlay").addEventListener("click", alternarPausa);

function estado(t) { $("estado").textContent = t || ""; }

// ---------- Cámara + lectura de QR (sin salir de la pantalla del disco) ----------
async function iniciarCamara() {
  const video = $("video");
  const flujo = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false,
  });
  video.srcObject = flujo;
  await video.play();
  if ("BarcodeDetector" in window) {
    try { detector = new BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { detector = null; }
  }
  escaneando = true;
  bucleEscaneo();
}

const lienzo = document.createElement("canvas");
const ctx = lienzo.getContext("2d", { willReadFrequently: true });

async function bucleEscaneo() {
  const video = $("video");
  while (escaneando) {
    await new Promise((r) => setTimeout(r, 220));
    if (video.readyState < 2 || $("reglas").hidden === false) continue;
    let texto = null;
    try {
      if (detector) {
        const r = await detector.detect(video);
        if (r.length) texto = r[0].rawValue;
      } else if (window.jsQR) {
        const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth) || 480;
        lienzo.width = w; lienzo.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
        if (r) texto = r.data;
      }
    } catch (e) { /* frame fallido: se reintenta */ }
    if (texto) leido(texto);
  }
}

function leido(texto) {
  const m = QR_RE.exec(texto);
  if (!m) return;
  const impreso = m[1];
  const ahora = Date.now();
  // Misma carta delante de la cámara: no reinicia. Cambio de carta: mínimo 1,5 s entre una y otra.
  if (impreso === ultimoLeido) return;
  if (ahora - ultimoCambio < 1500) return;
  ultimoLeido = impreso;
  ultimoCambio = ahora;
  const destino = DATOS.redir[impreso] || impreso;   // QR impresos con error → tema correcto
  mostrarCarta(destino);
}

function mostrarCarta(id) {
  $("info").hidden = true;
  $("btnInfo").textContent = "Mostrar info";
  estado("");
  reproducir(id);
  if (navigator.vibrate) navigator.vibrate(40);
}

// ---------- Info y reportes ----------
$("btnInfo").addEventListener("click", () => {
  const info = $("info");
  if (!info.hidden) { info.hidden = true; $("btnInfo").textContent = "Mostrar info"; return; }
  const c = actual && DATOS.cartas[actual];
  info.textContent = c ? `${c[0]}\n${c[1]}\n${c[2]}` : "Todavía no escaneaste ninguna carta";
  info.hidden = false;
  $("btnInfo").textContent = "Ocultar info";
});

function reportes() { try { return JSON.parse(localStorage.getItem("reportes") || "[]"); } catch (e) { return []; } }
function actualizarCompartir() { $("btnCompartir").hidden = reportes().length === 0; }

$("btnReportar").addEventListener("click", () => {
  if (!actual) { estado("Escaneá una carta para poder reportarla"); return; }
  $("dlgReporte").showModal();
});
$("dlgReporte").addEventListener("click", (e) => {
  const motivo = e.target.dataset && e.target.dataset.motivo;
  if (motivo === undefined) return;
  $("dlgReporte").close();
  if (!motivo) return;
  const c = DATOS.cartas[actual] || ["?", "?", "?"];
  const lista = reportes();
  lista.push({ fecha: new Date().toISOString().slice(0, 16).replace("T", " "), motivo, track_id: actual, artista: c[0], cancion: c[1] });
  try { localStorage.setItem("reportes", JSON.stringify(lista)); } catch (err) { /* sin almacenamiento */ }
  actualizarCompartir();
  estado("Reporte guardado");
  setTimeout(() => estado(""), 2000);
});
$("btnCompartir").addEventListener("click", async () => {
  const txt = "fecha;motivo;track_id;artista;cancion\n" + reportes().map((r) => [r.fecha, r.motivo, r.track_id, r.artista, r.cancion].join(";")).join("\n");
  try {
    if (navigator.share) await navigator.share({ title: "Reportes Vinilo", text: txt });
    else { await navigator.clipboard.writeText(txt); estado("Reportes copiados al portapapeles"); }
  } catch (e) { /* cancelado */ }
});

// ---------- Instrucciones (render de reglas.txt) ----------
async function cargarReglas() {
  let txt = "";
  try { txt = await (await fetch("reglas.txt")).text(); } catch (e) { return; }
  const raiz = $("reglasLista");
  raiz.textContent = "";
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const neg = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  let destino = raiz, ul = null;
  const add = (html, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = html; destino.appendChild(d); return d; };
  const li = (html, cls, n) => {
    if (!ul) { ul = document.createElement("ul"); destino.appendChild(ul); }
    const l = document.createElement("li"); l.innerHTML = html; if (cls) l.className = cls; if (n) l.dataset.n = n + "."; ul.appendChild(l);
  };
  for (const bruta of txt.split(/\r?\n/)) {
    const l = bruta.trimEnd();
    if (!l.trim() || l.startsWith("# ")) continue;
    const marca = l.split(" ")[0];
    const resto = l.slice(marca.length + 1);
    if (!/^(-|--|\d+\.)$/.test(marca)) ul = null;
    if (marca === "T") add(`<h1>${esc(resto)}</h1>`);
    else if (marca === "S") add(`<p class="s">${neg(resto)}</p>`);
    else if (marca === "##") {
      const [n, nombre] = resto.split("|");
      const sec = document.createElement("div"); sec.className = "sec";
      sec.innerHTML = `<div class="cab"><span class="num">${esc(n)}</span><span>${esc(nombre || "")}</span><span class="fl">▾</span></div><div class="cont"></div>`;
      sec.querySelector(".cab").addEventListener("click", () => {
        const abrir = !sec.classList.contains("abierta");
        raiz.querySelectorAll(".sec").forEach((s) => s.classList.remove("abierta"));
        if (abrir) sec.classList.add("abierta");
      });
      raiz.appendChild(sec); destino = sec.querySelector(".cont");
    }
    else if (marca === "###") add(`<h3>${neg(resto)}</h3>`);
    else if (marca === "P") add(`<p>${neg(resto)}</p>`);
    else if (marca === "K") add(resto.split(";").map((c) => { const [n, e] = c.split("|"); return `<div class="kpi"><b>${esc(n)}</b>${esc(e || "")}</div>`; }).join(""), "kpis");
    else if (marca === "-") li(neg(resto));
    else if (marca === "--") li(neg(resto), "sub");
    else if (/^\d+\.$/.test(marca)) li(neg(resto), "paso", marca.slice(0, -1));
    else if (marca === "F") {
      const p = resto.split("|"); const dest = /^[45]/.test((p[1] || "").trim());
      add(`<div class="t"><span>${esc(p[0])}</span><span>${esc(p[1] || "")}</span></div><p>${neg(p[2] || "")}</p>`, "ficha" + (dest ? " dest" : ""));
    }
    else if (marca === "B") add(neg(resto), "caja");
    else if (marca === "C") {
      const p = resto.split("|");
      const chips = p.slice(1).map((c) => { const k = c.startsWith("Carta para") ? "ok" : (c.startsWith("Se descarta") || c.startsWith("Ficha gastada")) ? "neu" : ""; return `<span class="chip ${k}">${esc(c)}</span>`; }).join("");
      add(`<span>${esc(p[0])}</span><div class="chips">${chips}</div>`, "caso");
    }
    else if (marca === "Q") add(esc(resto), "q");
    else if (marca === "A") add(`<p>${neg(resto)}</p>`);
    else if (marca === "N") add(esc(resto), "nota");
  }
}

function abrirReglas() { $("reglas").hidden = false; }
function cerrarReglas() { $("reglas").hidden = true; }
$("btnReglas").addEventListener("click", abrirReglas);
$("btnReglas0").addEventListener("click", abrirReglas);
$("btnCerrarReglas").addEventListener("click", cerrarReglas);

// ---------- Inicio ----------
/** Paso 1: vincular la cuenta. Muestra quién está vinculado y si sirve (Premium y habilitada). */
async function actualizarCuenta() {
  const lbl = $("cuenta");
  // Paso 1: app propia de Spotify (Client ID)
  const tieneId = ID_VALIDO.test(clientId());
  $("estadoApp").textContent = tieneId ? "App lista ✓ (…" + clientId().slice(-4) + ")" : "Una sola vez, en 2 minutos";
  $("estadoApp").className = tieneId ? "ok" : "";
  $("entradaId").hidden = tieneId;
  $("btnComoCrear").textContent = tieneId ? "Cambiar" : "Cómo";
  $("btnVincular").disabled = !tieneId;
  if (!tieneId) { lbl.textContent = "Primero completá el paso 1"; lbl.className = ""; $("btnEmpezar").disabled = true; $("btnDesvincular").hidden = true; return; }
  const vinculada = !!leerTokens();
  $("btnVincular").textContent = vinculada ? "Cambiar" : "Vincular";
  $("btnDesvincular").hidden = !vinculada;
  if (!vinculada) { lbl.textContent = "Sin vincular"; lbl.className = ""; $("btnEmpezar").disabled = true; return; }
  lbl.textContent = "Comprobando cuenta…"; lbl.className = "";
  const r = await api("GET", "/me");
  if (r.status === 200 && r.json) {
    if (r.json.product && r.json.product !== "premium") {
      lbl.textContent = "Esta cuenta no es Premium: no puede reproducir"; $("btnEmpezar").disabled = true; return;
    }
    lbl.textContent = "Vinculada: " + (r.json.display_name || r.json.id) + " ✓"; lbl.className = "ok";
    $("btnEmpezar").disabled = false;
  } else if (r.status === 403) {
    lbl.textContent = "Spotify no autorizó esta cuenta. Iniciá sesión con la misma cuenta Premium con la que creaste tu app.";
    $("btnEmpezar").disabled = true;
  } else if (r.status === 401) {
    guardarTokens(null); try { localStorage.removeItem("sp_tokens"); } catch (e) { /* nada */ }
    lbl.textContent = "La sesión venció: volvé a vincular"; $("btnEmpezar").disabled = true; $("btnVincular").textContent = "Vincular"; $("btnDesvincular").hidden = true;
  } else {
    lbl.textContent = "No pude comprobar la cuenta (error " + r.status + ")"; $("btnEmpezar").disabled = false;
  }
}

$("uriRedirect").textContent = REDIRECT;
$("btnComoCrear").addEventListener("click", () => {
  if (ID_VALIDO.test(clientId())) {   // «Cambiar»: borra el Client ID y la sesión para empezar de nuevo
    try { localStorage.removeItem("sp_client_id"); localStorage.removeItem("sp_tokens"); } catch (e) { /* nada */ }
    $("guiaApp").hidden = false; actualizarCuenta(); return;
  }
  $("guiaApp").hidden = !$("guiaApp").hidden;
});
$("btnCopiar").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(REDIRECT); $("btnCopiar").textContent = "Copiado ✓"; }
  catch (e) { $("btnCopiar").textContent = "Copialo a mano"; }
  setTimeout(() => { $("btnCopiar").textContent = "Copiar"; }, 2000);
});
$("btnGuardarId").addEventListener("click", () => {
  const v = $("inputClientId").value.trim();
  if (!ID_VALIDO.test(v)) { $("errorInicio").textContent = "El Client ID son 32 letras y números. Copialo de Settings en el panel de Spotify."; return; }
  $("errorInicio").textContent = "";
  try { localStorage.setItem("sp_client_id", v); localStorage.removeItem("sp_tokens"); } catch (e) { $("errorInicio").textContent = "No pude guardar el dato en este navegador."; return; }
  $("guiaApp").hidden = true;
  actualizarCuenta();
});
$("btnVincular").addEventListener("click", async () => {
  $("errorInicio").textContent = "";
  if (!ID_VALIDO.test(clientId())) { $("errorInicio").textContent = "Primero guardá tu Client ID (paso 1)."; return; }
  await iniciarSesionSpotify();   // va a Spotify y vuelve a esta página
});
$("btnDesvincular").addEventListener("click", () => {
  try { localStorage.removeItem("sp_tokens"); } catch (e) { /* nada */ }
  actualizarCuenta();
});

$("btnEmpezar").addEventListener("click", async () => {
  $("errorInicio").textContent = "";
  if (!leerTokens()) { $("errorInicio").textContent = "Primero vinculá tu cuenta de Spotify."; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("errorInicio").textContent = "Este navegador no permite usar la cámara. Abrí la web con Chrome o Safari.";
    return;
  }
  try {
    await iniciarCamara();
  } catch (e) {
    $("errorInicio").textContent = "Necesito permiso de cámara para leer las cartas.";
    return;
  }
  $("inicio").hidden = true;
  $("principal").hidden = false;
  actualizarCompartir();
  marcarPausa(true);
});

terminarLogin().then((err) => { if (err) $("errorInicio").textContent = err; actualizarCuenta(); });
cargarDatos();
cargarReglas();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
