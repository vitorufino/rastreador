(function () {
  const CFG = window.RASTREADOR_CONFIG;
  const TZ = CFG.TIMEZONE || "America/Fortaleza";
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  // cores para carros sem cor definida na tabela "tags" (bem distintas entre si)
  const PALETA = ["#0b6fb3", "#d9480f", "#2b8a3e", "#ae3ec9", "#e8590c", "#1098ad", "#c2255c", "#5c940d"];

  const $ = (id) => document.getElementById(id);
  const fmtHora = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const fmtDiaHora = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const hojeLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // AAAA-MM-DD
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let map, camada, camadaUltima, marcadores = [];
  let ultimas = {};         // tag_id -> último ponto conhecido (mesmo que seja de outro dia)
  let brutos = [], descartados = [];  // pontos do dia como vieram / os que o filtro descartou
  let tags = {};            // id -> { id, nome, cor }
  let pontos = [];          // pontos do dia/carro selecionados, numerados por carro
  let statusTags = [];      // [{ id, nome, ultima_consulta_ok, ultimo_ponto }]
  let ultimaConsulta = null;
  let canal = null;

  const carroSel = () => $("carro").value;  // "" = todos
  const tagInfo = (id) => tags[id] || { id, nome: id, cor: "#667085" };

  // ---------- Autenticação ----------
  async function iniciar() {
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

  // ---------- Cadastro dos carros (modelo, placa, cor) ----------
  $("btn-carros").addEventListener("click", () => {
    const lista = Object.values(tags);
    $("carros-form").innerHTML = lista.length ? lista.map((t) =>
      `<fieldset class="carro-ed" data-id="${esc(t.id)}"><legend><span class="dot" style="background:${t.cor}"></span> ${esc(t.nomeTag)} <span class="muted small">(${esc(t.id)})</span></legend>` +
      `<label>Modelo<input name="modelo" value="${esc(t.modelo || "")}" placeholder="ex.: Fiat Strada" maxlength="40"></label>` +
      `<label>Placa<input name="placa" value="${esc(t.placa || "")}" placeholder="ex.: ABC1D23" maxlength="8" style="text-transform:uppercase"></label>` +
      `<label>Nome da tag<input name="nome" value="${esc(t.nomeTag || "")}" maxlength="40"></label>` +
      `<label>Cor<input name="cor" type="color" value="${/^#[0-9a-f]{6}$/i.test(t.cor) ? t.cor : "#0b6fb3"}"></label></fieldset>`
    ).join("") : '<p class="muted small">Nenhuma tag cadastrada ainda.</p>';
    $("carros-erro").textContent = "";
    $("dlg-carros").showModal();
  });
  $("carros-cancelar").addEventListener("click", () => $("dlg-carros").close());
  $("carros-salvar").addEventListener("click", async () => {
    const btn = $("carros-salvar");
    btn.disabled = true; $("carros-erro").textContent = "";
    try {
      for (const fs of document.querySelectorAll(".carro-ed")) {
        const v = (n) => fs.querySelector(`[name=${n}]`).value.trim();
        const placa = v("placa").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (placa && !/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) throw new Error(`Placa "${v("placa")}" inválida (use ABC1234 ou ABC1D23).`);
        const { error } = await sb.from("tags").update({ modelo: v("modelo") || null, placa: placa || null, nome: v("nome") || fs.dataset.id, cor: v("cor") })
          .eq("id", fs.dataset.id);
        if (error) throw new Error(/tags_placa_unica|duplicate/i.test(error.message) ? `A placa ${placa} já está em outro carro.` : error.message);
      }
      $("dlg-carros").close();
      await carregarTags(); await carregarUltimas(); await carregarStatus(); await carregarDia(false);
    } catch (e) { $("carros-erro").textContent = e.message; }
    finally { btn.disabled = false; }
  });

  // ---------- App ----------
  async function iniciarApp() {
    if (!map) {
      map = L.map("map").setView([-5.09, -42.80], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      camada = L.layerGroup().addTo(map);
      camadaUltima = L.layerGroup().addTo(map);
    }
    await carregarTags();
    if (window.Rota && !iniciarApp.rotaMontada) {
      iniciarApp.rotaMontada = true;
      Rota.montar({ sb, carro: carroSel, dia: () => $("dia").value, pontos: () => pontos, tags: () => tags,
                    tagInfo, fmtHora, esc, irPara, descartados: () => descartados,
                    focar: (lat, lon) => { map.setView([lat, lon], 16); if (window.innerWidth <= 860) $("map").scrollIntoView({ behavior: "smooth" }); } });
    }
    await carregarDias();
    await carregarUltimas();
    await carregarDia(true);
    await carregarStatus();
    assinarAoVivo();
    setInterval(() => {  // atualiza o "há X min" (sem fechar um balão que esteja aberto)
      atualizarStatusTexto();
      if (!document.querySelector(".leaflet-popup")) desenharUltimas();
    }, 60000);
    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden) { await carregarUltimas(); carregarDia(false); carregarStatus(); }
    });
    setTimeout(() => map.invalidateSize(), 200);
  }

  async function carregarTags() {
    const { data, error } = await sb.from("tags").select("id,nome,modelo,placa,cor,ativo").order("criado_em");
    if (error) return erro(error);
    tags = {};
    // nome exibido: "Modelo · PLACA" quando cadastrados; senão o nome da tag
    (data || []).filter((t) => t.ativo !== false).forEach((t, i) => (tags[t.id] = {
      ...t, nomeTag: t.nome, cor: t.cor || PALETA[i % PALETA.length],
      nome: [t.modelo, t.placa].filter(Boolean).join(" · ") || t.nome,
    }));
    const sel = $("carro"), atual = sel.value;
    const lista = Object.values(tags);
    sel.innerHTML = (lista.length > 1 ? '<option value="">Todos os carros</option>' : "") +
      lista.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join("");
    sel.value = lista.some((t) => t.id === atual) || (atual === "" && lista.length > 1) ? atual : (lista.length > 1 ? "" : lista[0]?.id || "");
  }

  async function carregarDias() {
    let q = sb.from("days_by_tag").select("day,tag_id,n").order("day", { ascending: false });
    if (carroSel()) q = q.eq("tag_id", carroSel());
    const { data, error } = await q;
    if (error) return erro(error);
    const porDia = {};
    for (const r of data || []) if (tags[r.tag_id]) porDia[r.day] = (porDia[r.day] || 0) + r.n;
    const hoje = hojeLocal();
    if (!(hoje in porDia)) porDia[hoje] = 0;
    const dias = Object.keys(porDia).sort().reverse();
    const sel = $("dia"), atual = sel.value;
    sel.innerHTML = dias.map((d) => `<option value="${d}">${d.split("-").reverse().join("/")}${d === hoje ? " (hoje)" : ""} · ${porDia[d]} pts</option>`).join("");
    sel.value = atual && dias.includes(atual) ? atual : hoje;
  }

  async function buscarPontos(dia) {
    const todos = [];
    for (let de = 0; ; de += 1000) { // o Supabase entrega no máximo 1000 linhas por vez
      let q = sb.from("points").select("tag_id,seen_at,polled_at,lat,lon,accuracy_m,bairro,cidade").eq("day", dia);
      if (carroSel()) q = q.eq("tag_id", carroSel());
      const { data, error } = await q.order("seen_at").range(de, de + 999);
      if (error) { erro(error); break; }
      todos.push(...data);
      if (data.length < 1000) break;
    }
    return todos.filter((p) => tags[p.tag_id]);
  }

  // Filtra pontos impossíveis (filtro.js) e numera os válidos em ordem cronológica DENTRO de cada carro.
  // Os descartados ficam em `descartados` (mostrados só com "mostrar descartados") e fora de tudo o mais.
  function numerar(lista) {
    brutos = lista;
    const grupos = {};
    lista.forEach((p) => (grupos[p.tag_id] ||= []).push(p));
    if (window.Filtro) Object.values(grupos).forEach((l) => Filtro.filtrar(l));
    descartados = lista.filter((p) => p.descartado).map((p) => {
      const t = tagInfo(p.tag_id);
      return { ...p, hora: fmtHora.format(new Date(p.seen_at)), tagNome: t.nome, cor: t.cor };
    });
    const validos = lista.filter((p) => !p.descartado).sort((a, b) => a.seen_at.localeCompare(b.seen_at));
    const cont = {};
    return validos.map((p) => {
      cont[p.tag_id] = (cont[p.tag_id] || 0) + 1;
      const t = tagInfo(p.tag_id);
      return { ...p, seq: cont[p.tag_id], hora: fmtHora.format(new Date(p.seen_at)), tagNome: t.nome, cor: t.cor };
    }).map((p, _, arr) => ({ ...p, total: cont[p.tag_id] }));
  }

  async function carregarDia(ajustarZoom) {
    pontos = numerar(await buscarPontos($("dia").value));
    desenhar(ajustarZoom);
    if (window.Rota) Rota.atualizar();
  }

  async function irPara(tag, dia) {  // usado ao salvar uma rota: mostra aquele carro/dia
    $("carro").value = tag;
    await carregarDias();
    if (![...$("dia").options].some((o) => o.value === dia)) $("dia").insertAdjacentHTML("beforeend", `<option value="${dia}">${dia.split("-").reverse().join("/")} · 0 pts</option>`);
    $("dia").value = dia;
    await carregarDia(true);
  }

  // Última posição conhecida de cada carro (independe do dia escolhido)
  async function carregarUltimas() {
    // pega os 8 últimos de cada carro e usa o mais recente que passa no filtro de pontos impossíveis
    const res = await Promise.all(Object.keys(tags).map((id) =>
      sb.from("points").select("tag_id,seen_at,polled_at,lat,lon,accuracy_m").eq("tag_id", id)
        .order("seen_at", { ascending: false }).limit(8)));
    ultimas = {};
    for (const r of res) {
      const l = r.data || [];
      if (window.Filtro && l.length) Filtro.filtrar(l);
      const bom = l.filter((p) => !p.descartado).sort((a, b) => b.seen_at.localeCompare(a.seen_at))[0];
      if (bom) ultimas[bom.tag_id] = bom;
    }
  }

  function desenharUltimas() {
    camadaUltima.clearLayers();
    const visiveis = Object.values(ultimas).filter((u) => !carroSel() || u.tag_id === carroSel());
    for (const u of visiveis) {
      const t = tagInfo(u.tag_id);
      const quando = fmtDiaHora.format(new Date(u.seen_at));
      const gmaps = `https://www.google.com/maps/search/?api=1&query=${u.lat},${u.lon}`;
      const raio = u.accuracy_m && u.accuracy_m < 1000 ? L.circle([u.lat, u.lon], { radius: u.accuracy_m, color: t.cor, weight: 1, fillOpacity: 0.08 }) : null;
      if (raio) raio.addTo(camadaUltima);
      L.marker([u.lat, u.lon], {
        zIndexOffset: 1000,
        icon: L.divIcon({ className: "", iconSize: [0, 0], html:
          `<div class="pin-ultima" style="--cor:${t.cor}"><span class="pulso"></span><span class="ponta"></span>` +
          `<span class="rotulo">${esc(t.nome)} · ${haQuanto(u.seen_at)}</span></div>` }),
      }).bindPopup(`<b>${esc(t.nome)}</b><br>Última posição conhecida<br>${quando} (${haQuanto(u.seen_at)})` +
        (u.accuracy_m ? `<br>precisão ~${Math.round(u.accuracy_m)} m` : "") +
        `<br><a href="${gmaps}" target="_blank" rel="noopener">Abrir no Google Maps</a>`).addTo(camadaUltima);
    }
    return visiveis;
  }

  function focarUltima(id) {
    const u = ultimas[id]; if (!u) return;
    map.setView([u.lat, u.lon], 16);
    camadaUltima.eachLayer((l) => { if (l.getPopup && l.getLatLng && l.getLatLng().equals([u.lat, u.lon])) l.openPopup(); });
  }

  function desenhar(ajustarZoom) {
    camada.clearLayers(); marcadores = [];
    const visiveisUlt = desenharUltimas();
    const porTag = {};
    pontos.forEach((p) => (porTag[p.tag_id] ||= []).push(p));
    for (const lista of Object.values(porTag)) {
      if (lista.length > 1) L.polyline(lista.map((p) => [p.lat, p.lon]), { color: lista[0].cor, weight: 4, opacity: 0.75 }).addTo(camada);
    }
    pontos.forEach((p, i) => {
      const cls = p.seq === 1 ? "first" : p.seq === p.total ? "last" : "";
      const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: `<div class="num-icon ${cls}" style="background:${p.cor}">${p.seq}</div>`, iconSize: [22, 22] }) })
        .bindPopup(`<b>${esc(p.tagNome)}</b><br>Ponto ${p.seq} de ${p.total} — ${p.hora}${p.accuracy_m ? `<br>precisão ~${Math.round(p.accuracy_m)} m` : ""}`)
        .addTo(camada);
      marcadores[i] = m;
    });
    const verDesc = $("mostrar-descartados")?.checked;
    if (verDesc) for (const p of descartados) {
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: '<div class="desc-icon" title="ponto descartado">✕</div>', iconSize: [18, 18] }) })
        .bindPopup(`<b>${esc(p.tagNome)}</b> — ${p.hora}<br><b>Ponto descartado</b>: ${esc(p.motivo)}` +
          `<br><span class="muted small">Posição informada pelo celular de terceiros que ouviu a tag; não entra na rota nem na análise.</span>`)
        .addTo(camada);
    }
    if (ajustarZoom) {
      // com pontos no dia: enquadra a rota; sem pontos: mostra onde os carros estão agora
      const alvo = pontos.length ? pontos : visiveisUlt;
      if (alvo.length === 1) map.setView([alvo[0].lat, alvo[0].lon], 16);
      else if (alvo.length) map.fitBounds(L.latLngBounds(alvo.map((p) => [p.lat, p.lon])).pad(0.15));
    }

    const varios = !carroSel() && Object.keys(porTag).length > 0;
    $("contagem").textContent = `(${pontos.length}${descartados.length ? ` · ${descartados.length} descartado${descartados.length > 1 ? "s" : ""}` : ""})`;
    const linhasDesc = verDesc ? descartados.slice().reverse().map((p) =>
      `<div class="item descartado" title="${esc(p.motivo)}"><span class="seq">✕</span><span>${p.hora}</span>` +
      `<span class="muted small">descartado: ${esc(p.motivo)}${varios ? ` · ${esc(p.tagNome)}` : ""}</span></div>`).join("") : "";
    $("lista").innerHTML = (pontos.map((p, i) => ({ p, i })).reverse().map(({ p, i }) =>
      `<div class="item" data-i="${i}"><span class="seq">${p.seq}</span><span>${p.hora}</span>` +
      (varios ? `<span class="carro"><span class="dot" style="background:${p.cor}"></span>${esc(p.tagNome)}</span>`
              : `<span class="muted small">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>`) + `</div>`
    ).join("") + linhasDesc) || (visiveisUlt.length
      ? '<p class="muted small">Sem movimento neste dia. O marcador grande no mapa mostra a <b>última posição conhecida</b>' +
        (visiveisUlt.length > 1 ? " de cada carro." : ` (${fmtDiaHora.format(new Date(visiveisUlt[0].seen_at))}).`) + "</p>"
      : '<p class="muted small">Nenhum ponto neste dia.</p>');

    // Google Maps: só faz sentido para um carro por vez
    const umCarro = carroSel() || (Object.keys(porTag).length === 1 ? Object.keys(porTag)[0] : "");
    let url = umCarro ? Exportar.googleMapsUrl(porTag[umCarro] || []) : null;
    // sem rota no dia (carro parado): o botão abre a última posição conhecida
    const ultUm = carroSel() ? ultimas[carroSel()] : (visiveisUlt.length === 1 ? visiveisUlt[0] : null);
    if (!url && !pontos.length && ultUm) url = `https://www.google.com/maps/search/?api=1&query=${ultUm.lat},${ultUm.lon}`;
    const g = $("gmaps");
    if (url) { g.href = url; g.removeAttribute("aria-disabled"); } else { g.removeAttribute("href"); g.setAttribute("aria-disabled", "true"); }
    document.querySelectorAll("[data-fmt]").forEach((b) => (b.disabled = !pontos.length));
    const n = umCarro ? (porTag[umCarro] || []).length : 0;
    $("nota-url").textContent = !pontos.length && ultUm
      ? "Sem rota neste dia: o botão abre a última posição conhecida no Google Maps."
      : !pontos.length && visiveisUlt.length > 1
        ? "Para abrir no Google Maps, escolha um carro (ou clique no nome dele na barra de cima)."
      : !umCarro && pontos.length
      ? "Para abrir no Google Maps, escolha um carro. Os arquivos (KML etc.) incluem todos os carros, separados."
      : n > Exportar.MAX_URL_PONTOS
        ? `O link do Google Maps aceita até ${Exportar.MAX_URL_PONTOS} pontos (usa ${Exportar.MAX_URL_PONTOS} de ${n}). Para ver todos, importe o KML no Google My Maps.`
        : "";
  }

  $("lista").addEventListener("click", (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const m = marcadores[+it.dataset.i]; if (!m) return;
    map.setView(m.getLatLng(), 17); m.openPopup();
    if (window.innerWidth <= 860) $("map").scrollIntoView({ behavior: "smooth" });
  });
  document.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => {
    const sufixo = carroSel() ? "_" + carroSel() : "";
    Exportar.baixar(b.dataset.fmt, $("dia").value, pontos, sufixo);
  }));
  $("dia").addEventListener("change", () => carregarDia(true));
  $("mostrar-descartados").addEventListener("change", () => desenhar(false));
  $("carro").addEventListener("change", async () => { await carregarDias(); await carregarDia(true); });
  $("dia-ant").addEventListener("click", () => mudarDia(+1));
  $("dia-prox").addEventListener("click", () => mudarDia(-1));
  function mudarDia(delta) { // lista está do mais novo para o mais antigo
    const sel = $("dia"), i = sel.selectedIndex + delta;
    if (i >= 0 && i < sel.options.length) { sel.selectedIndex = i; carregarDia(true); }
  }

  // ---------- Status (por carro) ----------
  async function carregarStatus() {
    const [s, c] = await Promise.all([
      sb.from("status_por_tag").select("id,ultima_consulta_ok,ultimo_ponto"),
      sb.from("poll_log").select("polled_at,status,tag_id").order("polled_at", { ascending: false }).limit(15),
    ]);
    statusTags = (s.data || []).filter((t) => tags[t.id]);
    const consultas = c.data || [];
    ultimaConsulta = consultas[0] || null;
    const rot = { ok: "ponto novo", duplicate: "sem mudança", no_location: "sem localização", error: "erro" };
    const varios = Object.keys(tags).length > 1;
    $("consultas").innerHTML = consultas.map((x) =>
      `<div class="item"><span>${fmtDiaHora.format(new Date(x.polled_at))}</span><span class="st-${x.status}">${rot[x.status] || x.status}</span>` +
      (varios && tags[x.tag_id] ? `<span class="carro"><span class="dot" style="background:${tagInfo(x.tag_id).cor}"></span>${esc(tagInfo(x.tag_id).nome)}</span>` : "") + `</div>`
    ).join("") || '<p class="muted small">Nenhuma consulta registrada.</p>';
    atualizarStatusTexto();
  }

  $("st-carros").addEventListener("click", (e) => {
    const c = e.target.closest(".chip[data-tag]"); if (!c) return;
    focarUltima(c.dataset.tag);
    if (window.innerWidth <= 860) $("map").scrollIntoView({ behavior: "smooth" });
  });

  function haQuanto(iso) {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return "agora";
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return h < 24 ? `há ${h}h${String(m).padStart(2, "0")}` : `há ${Math.floor(h / 24)} dia(s)`;
  }

  function atualizarStatusTexto() {
    $("st-carros").innerHTML = statusTags.map((t) => {
      const info = tagInfo(t.id);
      const velho = t.ultimo_ponto && Date.now() - new Date(t.ultimo_ponto) > 2 * 3600000;
      return `<span class="chip${velho ? " velho" : ""}" data-tag="${esc(t.id)}" title="Mostrar no mapa"><span class="dot" style="background:${info.cor}"></span>${esc(info.nome)}: ` +
        (t.ultimo_ponto ? `<b>${fmtDiaHora.format(new Date(t.ultimo_ponto))}</b> (${haQuanto(t.ultimo_ponto)})` : "sem pontos ainda") + `</span>`;
    }).join("") || "Sem carros cadastrados";
    const sc = $("st-consulta");
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
        const st = statusTags.find((t) => t.id === p.tag_id);
        if (st && (!st.ultimo_ponto || p.seen_at > st.ultimo_ponto)) st.ultimo_ponto = p.seen_at;
        // a última posição é recalculada com o filtro (um ponto impossível não vira o "alfinete")
        if (tags[p.tag_id] && (!ultimas[p.tag_id] || p.seen_at > ultimas[p.tag_id].seen_at)) {
          agendar(async () => { await carregarUltimas(); if (!document.querySelector(".leaflet-popup")) desenharUltimas(); });
        }
        const visivel = p.day === $("dia").value && (!carroSel() || carroSel() === p.tag_id) && tags[p.tag_id];
        if (visivel && !brutos.some((x) => x.tag_id === p.tag_id && x.seen_at === p.seen_at && x.lat === p.lat && x.lon === p.lon)) {
          pontos = numerar([...brutos, p]);
          desenhar(false);
        }
        atualizarStatusTexto();
        agendar(carregarDias);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "poll_log" }, () => agendar(carregarStatus))
      .on("postgres_changes", { event: "*", schema: "public", table: "tags" }, () => agendar(async () => { await carregarTags(); await carregarUltimas(); await carregarStatus(); await carregarDia(false); }))
      .subscribe((st) => {
        const vivo = st === "SUBSCRIBED";
        $("st-vivo").classList.toggle("off", !vivo);
        $("st-vivo").textContent = vivo ? "● ao vivo" : "○ reconectando…";
      });
  }

  const timers = new Map();
  function agendar(fn) { clearTimeout(timers.get(fn)); timers.set(fn, setTimeout(fn, 2500)); }

  // ---------- Atualização automática do site ----------
  // Cada publicação troca <meta name="versao">. Se o servidor tiver versão diferente da aberta, recarrega.
  const VERSAO = document.querySelector('meta[name="versao"]')?.content || "0";
  async function verificarVersao() {
    try {
      const html = await fetch(`./?checar=${Date.now()}`, { cache: "no-store" }).then((r) => r.text());
      const nova = (html.match(/<meta name="versao" content="([^"]+)"/) || [])[1];
      if (nova && nova !== VERSAO && !document.querySelector(".leaflet-popup")) location.reload();
    } catch { /* sem internet: tenta na próxima */ }
  }
  setInterval(verificarVersao, 5 * 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) verificarVersao(); });

  function erro(e) { console.error(e); $("st-carros").textContent = "Erro ao carregar: " + (e.message || e); }

  iniciar();
})();
