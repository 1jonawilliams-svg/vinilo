"use strict";
// Vinilo (web): escanea el QR de una carta y hace sonar el tema por Spotify, sin mostrar título/artista/año
// hasta que se toque «Mostrar info». Requiere Spotify Premium con sesión iniciada en este navegador.

const $ = (id) => document.getElementById(id);
const QR_RE = /(?:open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/;

let DATOS = { cartas: {}, redir: {} };
let controlador = null;      // controlador de la iFrame API de Spotify
let apiSpotify = null;
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

// ---------- Spotify (iFrame API, fuera de vista) ----------
window.onSpotifyIframeApiReady = (api) => { apiSpotify = api; };
(function () {
  const s = document.createElement("script");
  s.src = "https://open.spotify.com/embed/iframe-api/v1";
  s.async = true;
  document.head.appendChild(s);
})();

function reproducir(id) {
  actual = id;
  const uri = "spotify:track:" + id;
  if (controlador) {
    controlador.loadUri(uri);
    setTimeout(() => controlador.play(), 400);
    return;
  }
  if (!apiSpotify) { estado("Conectando con Spotify…"); setTimeout(() => reproducir(id), 500); return; }
  apiSpotify.createController($("spotifyEmbed"), { uri, width: 300, height: 80 }, (ctrl) => {
    controlador = ctrl;
    ctrl.addListener("playback_update", (e) => marcarPausa(!!e.data.isPaused));
    ctrl.addListener("ready", () => ctrl.play());
    setTimeout(() => ctrl.play(), 600);
  });
}

function marcarPausa(p) {
  pausado = p;
  $("disco").classList.toggle("suena", !p);
  $("icoPausa").hidden = p;
  $("icoPlay").hidden = !p;
  $("btnPlay").setAttribute("aria-label", p ? "Reanudar" : "Pausar");
}

$("btnPlay").addEventListener("click", () => { if (controlador) controlador.togglePlay(); });

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
  estado(DATOS.cartas[id] ? "" : "Esta carta no es de tu mazo");
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
$("btnEmpezar").addEventListener("click", async () => {
  $("errorInicio").textContent = "";
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

cargarDatos();
cargarReglas();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
