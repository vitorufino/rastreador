(function () {
  const CFG = window.RASTREADOR_CONFIG;
  const TZ = CFG.TIMEZONE || "America/Fortaleza";
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  const $ = (id) => document.getElementById(id);
  const fmtHora = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const fmtDiaHora = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const hojeLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // AAAA-MM-DD

  let map, camada, marcadores = [];
  let pontos = [];          // pontos do dia selecionado (ordenados)
  let ultimoPontoGeral = null;
  let ultimaConsulta = null;
  let canal = null;

  // ---------- Autenticação ----------
  async function iniciar() {
    $("nome-rastreador").textContent = CFG.NOME_RASTREADOR || "";
    const { data } = await sb.auth.getSession();
    mostrar(!!data.session);
    sb.auth.onAuthStateChange((_ev, session) => mostrar(!!session));
  }

  let appIniciado = false;
  function mostrar(logado) {
    $("login").hidden = logado;
    $("app").hidden = !logado;
    if (logado && !appIniciado) { appIniciado = true; iniciarApp(); }
    if (!logado && appIniciado) { appIniciado = false; if (canal) sb.removeChannel(canal); canal = null; }
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-erro").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    if (error) $("login-erro").textContent = error.message.includes("Invalid") ? "E-mail ou senha incorretos." : error.message;
  });
  $("sair").addEventListener("click", () => sb.auth.signOut());

  // ---------- App ----------
  async function iniciarApp() {
    if (!map) {
      map = L.map("map").setView([-5.09, -42.80], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      camada = L.layerGroup().addTo(map);
    }
    await carregarDias();
    await carregarDia(true);
    await carregarStatus();
    assinarAoVivo();
    setInterval(atualizarStatusTexto, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { carregarDia(false); carregarStatus(); } });
    setTimeout(() => map.invalidateSize(), 200);
  }

  async function carregarDias() {
    const { data, error } = await sb.from("days_summary").select("day,n").order("day", { ascending: false });
    if (error) return erro(error);
    const hoje = hojeLocal();
    const dias = data || [];
    if (!dias.some((d) => d.day === hoje)) dias.unshift({ day: hoje, n: 0 });
    const sel = $("dia"), atual = sel.value;
    sel.innerHTML = dias.map((d) => `<option value="${d.day}">${d.day.split("-").reverse().join("/")}${d.day === hoje ? " (hoje)" : ""} · ${d.n} pts</option>`).join("");
    sel.value = atual && dias.some((d) => d.day === atual) ? atual : hoje;
  }

  async function buscarPontos(dia) {
    const todos = [];
    for (let de = 0; ; de += 1000) { // o Supabase entrega no máximo 1000 linhas por vez
      const { data, error } = await sb.from("points").select("seen_at,lat,lon,accuracy_m").eq("day", dia).order("seen_at").range(de, de + 999);
      if (error) { erro(error); break; }
      todos.push(...data);
      if (data.length < 1000) break;
    }
    return todos;
  }

  function numerar(lista) {
    lista.sort((a, b) => a.seen_at.localeCompare(b.seen_at));
    return lista.map((p, i) => ({ ...p, seq: i + 1, hora: fmtHora.format(new Date(p.seen_at)) }));
  }

  async function carregarDia(ajustarZoom) {
    pontos = numerar(await buscarPontos($("dia").value));
    desenhar(ajustarZoom);
  }

  function desenhar(ajustarZoom) {
    camada.clearLayers(); marcadores = [];
    if (pontos.length > 1) L.polyline(pontos.map((p) => [p.lat, p.lon]), { color: "#0b6fb3", weight: 4, opacity: 0.7 }).addTo(camada);
    pontos.forEach((p, i) => {
      const cls = i === 0 ? "first" : i === pontos.length - 1 ? "last" : "";
      const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: `<div class="num-icon ${cls}">${p.seq}</div>`, iconSize: [22, 22] }) })
        .bindPopup(`<b>Ponto ${p.seq}</b> — ${p.hora}${p.accuracy_m ? `<br>precisão ~${Math.round(p.accuracy_m)} m` : ""}`)
        .addTo(camada);
      marcadores.push(m);
    });
    if (ajustarZoom && pontos.length) map.fitBounds(L.latLngBounds(pontos.map((p) => [p.lat, p.lon])).pad(0.15));

    $("contagem").textContent = `(${pontos.length})`;
    $("lista").innerHTML = pontos.slice().reverse().map((p) =>
      `<div class="item" data-i="${p.seq - 1}"><span class="seq">${p.seq}</span><span>${p.hora}</span><span class="muted small">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span></div>`
    ).join("") || '<p class="muted small">Nenhum ponto neste dia.</p>';

    const url = Exportar.googleMapsUrl(pontos);
    const g = $("gmaps");
    if (url) { g.href = url; g.removeAttribute("aria-disabled"); } else { g.removeAttribute("href"); g.setAttribute("aria-disabled", "true"); }
    document.querySelectorAll("[data-fmt]").forEach((b) => (b.disabled = !pontos.length));
    $("nota-url").textContent = pontos.length > Exportar.MAX_URL_PONTOS
      ? `O link do Google Maps aceita até ${Exportar.MAX_URL_PONTOS} pontos (usa ${Exportar.MAX_URL_PONTOS} de ${pontos.length}). Para ver todos, importe o KML no Google My Maps.`
      : "";
  }

  $("lista").addEventListener("click", (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const m = marcadores[+it.dataset.i]; map.setView(m.getLatLng(), 17); m.openPopup();
    if (window.innerWidth <= 860) $("map").scrollIntoView({ behavior: "smooth" });
  });
  document.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => Exportar.baixar(b.dataset.fmt, $("dia").value, pontos)));
  $("dia").addEventListener("change", () => carregarDia(true));
  $("dia-ant").addEventListener("click", () => mudarDia(+1));
  $("dia-prox").addEventListener("click", () => mudarDia(-1));
  function mudarDia(delta) { // lista está do mais novo para o mais antigo
    const sel = $("dia"), i = sel.selectedIndex + delta;
    if (i >= 0 && i < sel.options.length) { sel.selectedIndex = i; carregarDia(true); }
  }

  // ---------- Status (último ponto / última consulta) ----------
  async function carregarStatus() {
    const [p, c] = await Promise.all([
      sb.from("points").select("seen_at").order("seen_at", { ascending: false }).limit(1),
      sb.from("poll_log").select("polled_at,status,detail").order("polled_at", { ascending: false }).limit(15),
    ]);
    ultimoPontoGeral = p.data?.[0]?.seen_at || null;
    const consultas = c.data || [];
    ultimaConsulta = consultas[0] || null;
    const rot = { ok: "ponto novo", duplicate: "sem mudança", no_location: "sem localização", error: "erro" };
    $("consultas").innerHTML = consultas.map((x) =>
      `<div class="item"><span>${fmtDiaHora.format(new Date(x.polled_at))}</span><span class="st-${x.status}">${rot[x.status] || x.status}</span></div>`
    ).join("") || '<p class="muted small">Nenhuma consulta registrada.</p>';
    atualizarStatusTexto();
  }

  function haQuanto(iso) {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return "agora";
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return h < 24 ? `há ${h}h${String(m).padStart(2, "0")}` : `há ${Math.floor(h / 24)} dia(s)`;
  }

  function atualizarStatusTexto() {
    const sp = $("st-ponto"), sc = $("st-consulta");
    sp.innerHTML = ultimoPontoGeral ? `Último ponto: <b>${fmtDiaHora.format(new Date(ultimoPontoGeral))}</b> (${haQuanto(ultimoPontoGeral)})` : "Sem pontos ainda";
    if (ultimaConsulta) {
      const atrasado = Date.now() - new Date(ultimaConsulta.polled_at) > 15 * 60000; // coletor parado?
      sc.innerHTML = `Última consulta: <b>${fmtDiaHora.format(new Date(ultimaConsulta.polled_at))}</b> (${haQuanto(ultimaConsulta.polled_at)})` + (atrasado ? " ⚠ coletor pode estar parado" : "");
      sc.classList.toggle("alerta", atrasado);
    } else sc.textContent = "Coletor ainda não consultou";
  }

  // ---------- Ao vivo ----------
  function assinarAoVivo() {
    if (canal) sb.removeChannel(canal);
    canal = sb.channel("rastreador")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "points" }, (msg) => {
        const p = msg.new;
        if (!ultimoPontoGeral || p.seen_at > ultimoPontoGeral) ultimoPontoGeral = p.seen_at;
        if (p.day === $("dia").value && !pontos.some((x) => x.seen_at === p.seen_at && x.lat === p.lat && x.lon === p.lon)) {
          pontos = numerar([...pontos, p]);
          desenhar(false);
        }
        atualizarStatusTexto();
        agendarRecarregarDias();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "poll_log" }, () => carregarStatus())
      .subscribe((st) => {
        const vivo = st === "SUBSCRIBED";
        $("st-vivo").classList.toggle("off", !vivo);
        $("st-vivo").textContent = vivo ? "● ao vivo" : "○ reconectando…";
      });
  }

  let tDias;
  function agendarRecarregarDias() { clearTimeout(tDias); tDias = setTimeout(carregarDias, 3000); }

  function erro(e) { console.error(e); $("st-ponto").textContent = "Erro ao carregar: " + (e.message || e); }

  iniciar();
})();
