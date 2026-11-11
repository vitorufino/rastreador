// Rota do dia: lê o PDF do carregamento (relatório "Transferir NF Venda entre Carregamento"),
// guarda no Supabase e cruza os bairros planejados com os bairros por onde a tag passou.
(function () {
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  // Praça do relatório -> cidade (prefixo antes do "-"). Acrescente aqui outras praças.
  const PRACAS = { THE: "Teresina", TIM: "Timon", ALT: "Altos", JFR: "José de Freitas", DEM: "Demerval Lobão", NAZ: "Nazária" };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const cidadeDaPraca = (p) => PRACAS[(p || "").split("-")[0].trim().toUpperCase()] || "";

  // ---------- Leitura do PDF ----------
  async function lerPdf(arquivo) {
    const pdf = await pdfjsLib.getDocument({ data: await arquivo.arrayBuffer(), isEvalSupported: false }).promise;
    const paradas = [];
    let motorista = "", carregamento = "", datas = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const itens = (await page.getTextContent()).items
        .filter((i) => i.str.trim())
        .map((i) => ({ t: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width }));

      // cabeçalho da tabela: posição x de cada coluna
      const achar = (txt) => itens.find((i) => i.t === txt);
      const col = {
        nota: achar("Nota"), codigo: achar("Código"), cliente: achar("Cliente"), tp: achar("TP.Venda"),
        bairro: achar("Bairro"), rota: achar("Rota"), praca: achar("Praça"), peso: achar("Tot. peso"),
        carreg: achar("Carreg."), dt: achar("Dt. transf"),
      };
      // texto do cabeçalho pode vir junto ("Nota Código Cliente ..."): tenta separar pelas palavras
      if (!col.bairro || !col.praca) throw new Error("Formato de PDF não reconhecido (não achei as colunas Bairro/Praça).");
      const yCab = col.bairro.y;

      const m = itens.findIndex((i) => /^Motorista:?$/i.test(i.t));
      if (m >= 0 && !motorista) {
        const lado = itens.filter((i) => Math.abs(i.y - itens[m].y) < 2 && i.x > itens[m].x && !/^Placa/i.test(i.t))
          .sort((a, b) => a.x - b.x)[0];
        motorista = lado ? lado.t : "";
      }

      // todas as colunas do cabeçalho (mesma altura do título "Bairro"), pelo centro de cada título
      // cada coluna vai do meio entre o título anterior e o seu até o meio entre o seu e o próximo
      const cabecalho = itens.filter((i) => Math.abs(i.y - yCab) < 2)
        .map((i) => ({ nome: i.t, c: i.x + i.w / 2 })).sort((a, b) => a.c - b.c);
      cabecalho.forEach((h, k) => {
        h.ini = k ? (cabecalho[k - 1].c + h.c) / 2 : -Infinity;
        h.fim = k < cabecalho.length - 1 ? (h.c + cabecalho[k + 1].c) / 2 : Infinity;
      });
      const colunaDe = (i) => {  // coluna com que o texto mais se sobrepõe (funciona p/ esquerda, centro, direita)
        const a = i.x, b = i.x + Math.max(i.w, 1);
        let melhor = cabecalho[0], sob = -1;
        for (const h of cabecalho) {
          const s = Math.min(b, h.fim) - Math.max(a, h.ini);
          if (s > sob) { sob = s; melhor = h; }
        }
        return melhor.nome;
      };

      // linhas abaixo do cabeçalho, agrupadas pela altura (y)
      const linhas = new Map();
      for (const i of itens) {
        if (i.y >= yCab - 1) continue;
        const k = [...linhas.keys()].find((y) => Math.abs(y - i.y) < 2.5) ?? i.y;
        if (!linhas.has(k)) linhas.set(k, []);
        linhas.get(k).push(i);
      }

      for (const lin of [...linhas.entries()].sort((a, b) => b[0] - a[0]).map((e) => e[1])) {
        const primeiro = lin.slice().sort((a, b) => a.x - b.x)[0];
        if (!primeiro || !/^\d{3,}$/.test(primeiro.t) || primeiro.x > (col.codigo?.x ?? col.cliente.x)) continue; // não é linha de nota
        const campo = {};
        for (const i of lin.slice().sort((a, b) => a.x - b.x)) {
          const nome = colunaDe(i);
          campo[nome] = campo[nome] ? campo[nome] + " " + i.t : i.t;
        }
        let bairro = campo["Bairro"] || "";
        if (!campo["Rota"]) bairro = bairro.replace(/\s*\d+$/, ""); // "RENASCENCA II12" -> número da rota grudado
        // código e cliente às vezes vêm num só texto ("103195 FRANCISCO ...")
        const cliente = ((campo["Código"] ? campo["Código"] + " " : "") + (campo["Cliente"] || "")).replace(/^\d+\s+/, "").trim();
        const praca = campo["Praça"] || "";
        if (!carregamento && campo["Carreg."]) carregamento = campo["Carreg."].split(" ")[0];
        const d = (campo["Dt. transf"] || "").match(/\d{2}\/\d{2}\/\d{4}/);
        if (d) datas.push(d[0]);
        if (bairro) paradas.push({ nota: primeiro.t, cliente, bairro: bairro.trim(), praca, cidade: cidadeDaPraca(praca) });
      }
      if (!datas.length) { // período das transferências
        const p = itens.find((i) => /^\d{2}\/\d{2}\/\d{4}\s+a\s+\d{2}\/\d{2}\/\d{4}$/.test(i.t));
        if (p) datas.push(p.t.slice(0, 10));
      }
    }
    if (!paradas.length) throw new Error("Não encontrei nenhuma nota/parada no PDF.");
    const freq = {}; datas.forEach((d) => (freq[d] = (freq[d] || 0) + 1));
    const dataBR = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
    const dia = dataBR ? dataBR.split("/").reverse().join("-") : null;
    return { motorista, carregamento, dia, paradas };
  }

  // ---------- Cruzamento planejado x feito ----------
  function analisar(rotas, pontos) {
    const ord = pontos.slice().sort((a, b) => a.seen_at.localeCompare(b.seen_at));
    const semBairro = ord.filter((p) => p.bairro == null).length;
    // visitas por bairro: chegada, saída e tempo (soma dos trechos contínuos no mesmo bairro)
    const vis = new Map();
    let ant = null;
    for (const p of ord) {
      if (!p.bairro) { ant = null; continue; }
      const k = norm(p.bairro) + "|" + norm(p.cidade);
      if (!vis.has(k)) vis.set(k, { bairro: p.bairro, cidade: p.cidade, chegada: p.seen_at, saida: p.seen_at, ms: 0, pontos: 0 });
      const v = vis.get(k);
      v.saida = p.seen_at; v.pontos++;
      if (ant && ant.k === k) v.ms += new Date(p.seen_at) - new Date(ant.t);
      ant = { k, t: p.seen_at };
    }
    const visitas = [...vis.values()];
    const usadas = new Set();

    // bairros planejados (únicos), com os clientes de cada um
    const plan = new Map();
    for (const r of rotas) for (const s of r.paradas) {
      const k = norm(s.bairro) + "|" + norm(s.cidade);
      if (!plan.has(k)) plan.set(k, { bairro: s.bairro, cidade: s.cidade, clientes: [] });
      if (s.cliente && !plan.get(k).clientes.includes(s.cliente)) plan.get(k).clientes.push(s.cliente);
    }
    const planejados = [...plan.values()].map((pl) => {
      const nb = norm(pl.bairro), nc = norm(pl.cidade);
      const mesmaCidade = (v) => !nc || !v.cidade || norm(v.cidade) === nc;
      let v = visitas.find((x) => norm(x.bairro) === nb && mesmaCidade(x));
      let tipo = "exato";
      if (!v) { // nomes parecidos: "RENASCENCA II" x "Renascença", "PQ POTI" x "Parque Poti"
        v = visitas.find((x) => mesmaCidade(x) && (norm(x.bairro).includes(nb) || nb.includes(norm(x.bairro))));
        tipo = "parecido";
      }
      if (v) usadas.add(v);
      return { ...pl, visita: v || null, tipo: v ? tipo : null };
    });
    const extras = visitas.filter((v) => !usadas.has(v));
    return { planejados, extras, semBairro };
  }

  // ---------- Tela "Rota do dia" ----------
  let ctx = null;        // { sb, carro(), dia(), pontos(), tags(), tagInfo, fmtHora, esc, irPara(tag, dia) }
  let previa = null;     // PDF lido aguardando confirmação
  const $ = (id) => document.getElementById(id);
  const min = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`; };
  const hojeLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());

  function montar(c) {
    ctx = c;
    $("rota-pdf").addEventListener("change", aoEscolherPdf);
    $("rota-conteudo").addEventListener("click", aoClicar);
    $("rota-previa").addEventListener("click", aoClicar);
  }

  async function atualizar() {
    if (!ctx) return;
    const el = $("rota-conteudo"), tag = ctx.carro(), dia = ctx.dia();
    $("rota-enviar").hidden = false;
    if (!tag) { el.innerHTML = '<p class="muted small">Escolha um carro para ver a rota planejada x feita.</p>'; return; }
    const { data: rotas, error } = await ctx.sb.from("rotas").select("*").eq("tag_id", tag).eq("dia", dia).order("enviado_em");
    if (error) { el.innerHTML = `<p class="erro">Erro ao carregar rotas: ${ctx.esc(error.message)}</p>`; return; }
    if (!rotas.length) { el.innerHTML = '<p class="muted small">Nenhuma rota enviada para este carro neste dia.</p>'; return; }

    // links temporários (1 h) para os PDFs — gerados agora para virar link comum (sem bloqueio de pop-up)
    const links = {};
    await Promise.all(rotas.filter((r) => r.arquivo).map(async (r) => {
      const { data } = await ctx.sb.storage.from("rotas").createSignedUrl(r.arquivo, 3600);
      if (data) links[r.id] = data.signedUrl;
    }));
    const a = analisar(rotas, ctx.pontos().filter((p) => p.tag_id === tag));
    const hoje = dia === hojeLocal();
    const ok = a.planejados.filter((p) => p.visita).length;
    const fmt = (iso) => ctx.fmtHora.format(new Date(iso)).slice(0, 5);
    const e = ctx.esc;
    el.innerHTML =
      rotas.map((r) => `<div class="rota-cab"><span><b>Carreg. ${e(r.carregamento || "—")}</b> · ${e(r.motorista || "motorista ?")} · ${r.paradas.length} nota(s)</span>` +
        `<span class="rota-acoes">${links[r.id] ? `<a class="link" href="${e(links[r.id])}" target="_blank" rel="noopener">ver PDF</a>` : ""}` +
        `<button class="link perigo" data-apagar="${r.id}" data-arquivo="${e(r.arquivo || "")}">remover</button></span></div>`).join("") +
      `<p class="rota-resumo"><b>${ok} de ${a.planejados.length}</b> bairro(s) da rota visitado(s)${hoje && ok < a.planejados.length ? " até agora" : ""}.</p>` +
      `<div class="rota-lista">` + a.planejados.map((p) => {
        const v = p.visita;
        const icone = v ? (p.tipo === "exato" ? "✅" : "🟡") : hoje ? "⏳" : "❌";
        const det = v ? `chegada ${fmt(v.chegada)}${v.ms ? ` · ${min(v.ms)} no bairro` : ""}${p.tipo !== "exato" ? ` · nome parecido: “${e(v.bairro)}”` : ""}`
                      : hoje ? "ainda não passou" : "não passou pelo bairro";
        return `<div class="rota-item"><span class="ic">${icone}</span><div><b>${e(p.bairro)}</b>${p.cidade ? ` <span class="muted small">(${e(p.cidade)})</span>` : ""}` +
          `<div class="small">${det}</div><div class="muted small">${p.clientes.map(e).join(" · ")}</div></div></div>`;
      }).join("") + `</div>` +
      (a.extras.length ? `<p class="small"><b>Também passou por:</b> ${a.extras.map((v) => `${e(v.bairro || "?")} (${fmt(v.chegada)})`).join(", ")}</p>` : "") +
      (a.semBairro ? `<p class="muted small">${a.semBairro} ponto(s) do dia ainda sem bairro identificado — o servidor completa em alguns minutos.</p>` : "") +
      `<p class="muted small">✅ visitado · 🟡 nome do bairro parecido (confira) · ${hoje ? "⏳ ainda não visitado" : "❌ não visitado"}</p>`;
  }

  async function aoEscolherPdf(ev) {
    const arq = ev.target.files[0];
    ev.target.value = "";
    if (!arq) return;
    const box = $("rota-previa");
    box.hidden = false;
    box.innerHTML = '<p class="muted small">Lendo o PDF…</p>';
    try {
      const r = await lerPdf(arq);
      previa = { ...r, arquivo: arq };
      const e = ctx.esc;
      const opcoes = Object.values(ctx.tags()).map((t) => `<option value="${e(t.id)}"${t.id === ctx.carro() ? " selected" : ""}>${e(t.nome)}</option>`).join("");
      box.innerHTML =
        `<p><b>Confira a rota lida do PDF:</b></p>` +
        `<p class="small">Motorista: <b>${e(r.motorista || "não identificado")}</b> · Carregamento: <b>${e(r.carregamento || "—")}</b></p>` +
        `<div class="linha"><label class="small">Carro <select id="rota-carro">${opcoes}</select></label>` +
        `<label class="small">Dia <input type="date" id="rota-dia" value="${r.dia || ctx.dia()}"></label></div>` +
        `<ol class="small rota-previa-lista">${r.paradas.map((s) => `<li><b>${e(s.bairro)}</b> — ${e(s.cliente)} <span class="muted">(${e(s.praca)})</span></li>`).join("")}</ol>` +
        `<div class="linha"><button class="btn primary" data-salvar>Salvar rota</button><button class="btn" data-cancelar>Cancelar</button></div>`;
    } catch (err) {
      previa = null;
      box.innerHTML = `<p class="erro">Não consegui ler este PDF: ${ctx.esc(err.message)}</p><button class="btn" data-cancelar>Fechar</button>`;
    }
  }

  async function salvar() {
    const tag = $("rota-carro").value, dia = $("rota-dia").value;
    if (!tag || !dia || !previa) return;
    const box = $("rota-previa");
    box.querySelector("[data-salvar]").disabled = true;
    const nome = `${tag}/${dia}/${(previa.carregamento || "rota").replace(/[^\w-]/g, "")}-${Date.now()}.pdf`;
    const up = await ctx.sb.storage.from("rotas").upload(nome, previa.arquivo, { contentType: "application/pdf" });
    if (up.error) { box.insertAdjacentHTML("beforeend", `<p class="erro">Falha ao enviar o PDF: ${ctx.esc(up.error.message)}</p>`); return; }
    const ins = await ctx.sb.from("rotas").insert({
      tag_id: tag, dia, carregamento: previa.carregamento, motorista: previa.motorista,
      paradas: previa.paradas, arquivo: nome,
    });
    if (ins.error) {
      await ctx.sb.storage.from("rotas").remove([nome]);
      box.insertAdjacentHTML("beforeend", `<p class="erro">Falha ao salvar a rota: ${ctx.esc(ins.error.message)}</p>`);
      return;
    }
    previa = null;
    box.hidden = true; box.innerHTML = "";
    await ctx.irPara(tag, dia);   // mostra o carro/dia da rota salva
    await atualizar();
  }

  async function aoClicar(ev) {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.hasAttribute("data-salvar")) return salvar();
    if (b.hasAttribute("data-cancelar")) { previa = null; $("rota-previa").hidden = true; $("rota-previa").innerHTML = ""; return; }
    if (b.dataset.apagar) {
      if (!confirm("Remover esta rota (e o PDF) deste carro/dia?")) return;
      const del = await ctx.sb.from("rotas").delete().eq("id", b.dataset.apagar);
      if (del.error) return alert("Não consegui remover: " + del.error.message);
      if (b.dataset.arquivo) await ctx.sb.storage.from("rotas").remove([b.dataset.arquivo]);
      atualizar();
    }
  }

  window.Rota = { lerPdf, analisar, norm, cidadeDaPraca, montar, atualizar };
})();
