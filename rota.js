// Rota do dia: lê o PDF do carregamento (relatório "Transferir NF Venda entre Carregamento"),
// guarda no Supabase e cruza os bairros planejados com os bairros por onde a tag passou.
(function () {
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  // Praça do relatório -> cidade (prefixo antes do "-"). Acrescente aqui outras praças.
  const PRACAS = { THE: "Teresina", TIM: "Timon", ALT: "Altos", JFR: "José de Freitas", DEM: "Demerval Lobão", NAZ: "Nazária" };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const normPlaca = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cidadeDaPraca = (p) => PRACAS[(p || "").split("-")[0].trim().toUpperCase()] || "";

  // ---------- Leitura do PDF ----------
  async function lerPdf(arquivo) {
    const pdf = await pdfjsLib.getDocument({ data: await arquivo.arrayBuffer(), isEvalSupported: false }).promise;
    const paradas = [];
    let motorista = "", carregamento = "", placa = "", datas = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const itens = (await page.getTextContent()).items
        .filter((i) => i.str.trim())
        .map((i) => ({ t: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width }));

      // cabeçalho da tabela: linha que contém "Bairro". Títulos às vezes vêm grudados num só texto
      // ("TP.Venda Bairro"): separa pelos nomes conhecidos, estimando a posição de cada um.
      const base = itens.find((i) => /(^|\s)Bairro(\s|$)/.test(i.t));
      if (!base) throw new Error("Formato de PDF não reconhecido (não achei a coluna Bairro).");
      const yCab = base.y;
      const CONHECIDOS = ["Carreg. anterior", "Tot. peso", "Val. total", "Dt. transf", "TP.Venda", "Volume(s)", "Transação",
        "Carreg.", "Código", "Cliente", "Bairro", "Praça", "Saída", "Nota", "Rota"];
      const titulos = [];
      for (const i of itens.filter((i) => Math.abs(i.y - yCab) < 2)) {
        let resto = i.t, achou = false;
        for (const nome of CONHECIDOS) {
          let pos = resto.indexOf(nome);
          while (pos >= 0) {
            const ini = i.x + (i.w * pos) / i.t.length, larg = (i.w * nome.length) / i.t.length;
            titulos.push({ t: nome, x: ini, y: i.y, w: larg });
            resto = resto.slice(0, pos) + " ".repeat(nome.length) + resto.slice(pos + nome.length);
            achou = true;
            pos = resto.indexOf(nome);
          }
        }
        if (!achou) titulos.push(i);
      }
      const achar = (txt) => titulos.find((i) => i.t === txt);
      const col = { codigo: achar("Código"), cliente: achar("Cliente"), bairro: achar("Bairro"), praca: achar("Praça") };
      if (!col.bairro || !col.praca || !col.cliente) throw new Error("Formato de PDF não reconhecido (não achei as colunas Cliente/Bairro/Praça).");

      const m = itens.findIndex((i) => /^Motorista:?$/i.test(i.t));
      if (m >= 0 && !motorista) {
        const lado = itens.filter((i) => Math.abs(i.y - itens[m].y) < 2 && i.x > itens[m].x && !/^Placa/i.test(i.t))
          .sort((a, b) => a.x - b.x)[0];
        motorista = lado ? lado.t : "";
      }
      // Placa: "Placa:" seguido do texto à direita (ou tudo junto: "Placa: ABC1D23")
      if (!placa) {
        const pi = itens.find((i) => /^Placa:?/i.test(i.t));
        if (pi) {
          const junto = pi.t.replace(/^Placa:?\s*/i, "");
          const lado = itens.filter((i) => Math.abs(i.y - pi.y) < 2 && i.x > pi.x).sort((a, b) => a.x - b.x)[0];
          const cand = normPlaca(junto) || (lado && Math.abs(lado.x - (pi.x + pi.w)) < 120 ? normPlaca(lado.t) : "");
          if (/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(cand)) placa = cand;
        }
      }

      // todas as colunas do cabeçalho (mesma altura do título "Bairro"), pelo centro de cada título
      // cada coluna vai do meio entre o título anterior e o seu até o meio entre o seu e o próximo
      const cabecalho = titulos.map((i) => ({ nome: i.t, c: i.x + i.w / 2 })).sort((a, b) => a.c - b.c);
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
        const mNota = primeiro && primeiro.t.match(/^(\d{3,})(\s|$)/);   // nota pode vir grudada no código/cliente
        if (!mNota || primeiro.x > (col.codigo?.x ?? col.cliente.x)) continue; // não é linha de nota
        const campo = {};
        for (const i of lin.slice().sort((a, b) => a.x - b.x)) {
          const nome = colunaDe(i);
          campo[nome] = campo[nome] ? campo[nome] + " " + i.t : i.t;
        }
        let bairro = campo["Bairro"] || "";
        if (!campo["Rota"]) bairro = bairro.replace(/\s*\d+$/, ""); // "RENASCENCA II12" -> número da rota grudado
        if (!campo["TP.Venda"]) bairro = bairro.replace(/^\d+\s+/, ""); // "1 PARQUE POTI" -> tipo de venda grudado
        // código e cliente às vezes vêm num só texto ("103195 FRANCISCO ...")
        const cliente = ((campo["Nota"] && campo["Nota"] !== mNota[1] ? campo["Nota"] + " " : "") +
          (campo["Código"] ? campo["Código"] + " " : "") + (campo["Cliente"] || "")).replace(/^(\d+\s+)+/, "").trim();
        const praca = (campo["Praça"] || "").replace(/\s+[\d.,]+$/, "");  // número do peso grudado
        if (!carregamento && campo["Carreg."]) carregamento = campo["Carreg."].split(" ")[0];
        const d = (campo["Dt. transf"] || "").match(/\d{2}\/\d{2}\/\d{4}/);
        if (d) datas.push(d[0]);
        if (bairro) paradas.push({ nota: mNota[1], cliente, bairro: bairro.trim(), praca, cidade: cidadeDaPraca(praca) });
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
    return { motorista, carregamento, placa, dia, paradas };
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
    // status de cada nota (para exportar)
    const porChave = new Map(planejados.map((p) => [norm(p.bairro) + "|" + norm(p.cidade), p]));
    const paradas = rotas.flatMap((r) => r.paradas.map((s) => {
      const p = porChave.get(norm(s.bairro) + "|" + norm(s.cidade));
      return { ...s, carregamento: r.carregamento, motorista: r.motorista, visita: p?.visita || null, tipo: p?.tipo || null };
    }));
    return { planejados, extras, semBairro, paradas, pontos: ord };
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
    ultimo = { tag, dia, rotas, a, hoje };
    const ok = a.planejados.filter((p) => p.visita).length;
    const fmt = (iso) => ctx.fmtHora.format(new Date(iso)).slice(0, 5);
    const e = ctx.esc;
    el.innerHTML =
      rotas.map((r) => {
        const pc = normPlaca(ctx.tags()[tag]?.placa);
        const pl = r.placa ? ` · placa ${e(r.placa)}${pc ? (r.placa === pc ? ' <span class="placa-ok">✓</span>' : ' <span class="placa-alerta" title="Diferente da placa do carro">⚠ difere do carro</span>') : ""}` : "";
        return `<div class="rota-cab"><span><b>Carreg. ${e(r.carregamento || "—")}</b> · ${e(r.motorista || "motorista ?")}${pl} · ${r.paradas.length} nota(s)</span>` +
        `<span class="rota-acoes">${links[r.id] ? `<a class="link" href="${e(links[r.id])}" target="_blank" rel="noopener">ver PDF</a>` : ""}` +
        `<button class="link perigo" data-apagar="${r.id}" data-arquivo="${e(r.arquivo || "")}">remover</button></span></div>`;
      }).join("") +
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
      `<p class="muted small">✅ visitado · 🟡 nome do bairro parecido (confira) · ${hoje ? "⏳ ainda não visitado" : "❌ não visitado"}</p>` +
      `<div class="linha"><button class="btn" data-exportar="pdf">⬇ PDF</button><button class="btn" data-exportar="xlsx">⬇ Excel</button></div>`;
  }

  // ---------- Exportação da análise (PDF e Excel) ----------
  let ultimo = null;  // última análise mostrada na tela
  const carregados = {};
  const carregar = (src) => (carregados[src] ||= new Promise((ok, falha) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => falha(new Error("não carregou " + src));
    document.head.appendChild(s);
  }));

  function linhasRelatorio() {
    const { a, hoje } = ultimo;
    const fmt = (iso) => (iso ? ctx.fmtHora.format(new Date(iso)).slice(0, 5) : "");
    const status = (v, tipo) => (v ? (tipo === "exato" ? "Visitado" : "Visitado (nome parecido)") : hoje ? "Ainda não visitado" : "Não visitado");
    return {
      paradas: a.paradas.map((s) => ({
        Nota: s.nota, Cliente: s.cliente, Bairro: s.bairro, Cidade: s.cidade || "", Praça: s.praca || "",
        Status: status(s.visita, s.tipo), Chegada: fmt(s.visita?.chegada), "Tempo no bairro": s.visita?.ms ? min(s.visita.ms) : "",
        "Bairro no mapa": s.visita && s.tipo !== "exato" ? s.visita.bairro : "", Carregamento: s.carregamento || "", Motorista: s.motorista || "",
      })),
      bairros: a.planejados.map((p) => ({
        Bairro: p.bairro, Cidade: p.cidade || "", Status: status(p.visita, p.tipo), Chegada: fmt(p.visita?.chegada),
        Saída: fmt(p.visita?.saida), "Tempo no bairro": p.visita?.ms ? min(p.visita.ms) : "", Clientes: p.clientes.join(" · "),
      })),
      extras: a.extras.map((v) => ({ Bairro: v.bairro, Cidade: v.cidade || "", Chegada: fmt(v.chegada), Saída: fmt(v.saida), "Tempo no bairro": v.ms ? min(v.ms) : "" })),
      pontos: a.pontos.map((p) => ({ Horário: ctx.fmtHora.format(new Date(p.seen_at)), Latitude: p.lat, Longitude: p.lon,
        "Precisão (m)": p.accuracy_m ? Math.round(p.accuracy_m) : "", Bairro: p.bairro ?? "(identificando…)", Cidade: p.cidade || "" })),
    };
  }

  function cabecalho() {
    const { tag, dia, rotas, a } = ultimo;
    const ok = a.planejados.filter((p) => p.visita).length;
    return {
      carro: ctx.tagInfo(tag).nome,
      dia: dia.split("-").reverse().join("/"),
      carregamentos: rotas.map((r) => r.carregamento || "—").join(", "),
      motoristas: [...new Set(rotas.map((r) => r.motorista).filter(Boolean))].join(", ") || "—",
      placaCarro: normPlaca(ctx.tags()[tag]?.placa) || "—",
      placasPdf: [...new Set(rotas.map((r) => r.placa).filter(Boolean))].join(", ") || "—",
      resumo: `${ok} de ${a.planejados.length} bairro(s) da rota visitado(s)`,
      gerado: new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }),
      arquivo: `rota_${tag}_${dia}`,
    };
  }

  async function exportarExcel() {
    await carregar("lib/xlsx.full.min.js");
    const h = cabecalho(), L = linhasRelatorio();
    const wb = XLSX.utils.book_new();
    const resumo = [["Rota do dia — planejado x feito"], [], ["Carro", h.carro], ["Dia", h.dia], ["Carregamento(s)", h.carregamentos],
      ["Motorista(s)", h.motoristas], ["Placa do carro", h.placaCarro], ["Placa no PDF", h.placasPdf],
      ["Resultado", h.resumo], ["Gerado em", h.gerado]];
    const add = (nome, linhas, larguras) => {
      const ws = Array.isArray(linhas[0]) ? XLSX.utils.aoa_to_sheet(linhas) : XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ "(sem dados)": "" }]);
      if (larguras) ws["!cols"] = larguras.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, nome);
    };
    add("Resumo", resumo, [18, 50]);
    add("Paradas", L.paradas, [10, 38, 20, 14, 18, 22, 9, 14, 18, 13, 30]);
    add("Bairros planejados", L.bairros, [22, 14, 22, 9, 9, 14, 60]);
    add("Fora da rota", L.extras, [22, 14, 9, 9, 14]);
    add("Pontos do dia", L.pontos, [10, 12, 12, 12, 22, 14]);
    XLSX.writeFile(wb, h.arquivo + ".xlsx");
  }

  async function exportarPdf() {
    await carregar("lib/jspdf.umd.min.js");
    await carregar("lib/jspdf.plugin.autotable.min.js");
    const h = cabecalho(), L = linhasRelatorio();
    const doc = new jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    doc.setFontSize(15); doc.text("Rota do dia — planejado x feito", 14, 15);
    doc.setFontSize(10);
    doc.text(`Carro: ${h.carro}    Dia: ${h.dia}    Carregamento(s): ${h.carregamentos}`, 14, 22);
    doc.text(`Motorista(s): ${h.motoristas}    Placa do carro: ${h.placaCarro}    Placa no PDF: ${h.placasPdf}` +
      (h.placaCarro !== "—" && h.placasPdf !== "—" && !h.placasPdf.split(", ").includes(h.placaCarro) ? "  (DIFERENTE)" : ""), 14, 27);
    doc.setFont(undefined, "bold"); doc.text(`Resultado: ${h.resumo}`, 14, 33); doc.setFont(undefined, "normal");
    const cor = { "Visitado": [220, 252, 231], "Visitado (nome parecido)": [254, 249, 195], "Não visitado": [254, 226, 226], "Ainda não visitado": [241, 245, 249] };
    const colunas = ["Nota", "Cliente", "Bairro", "Cidade", "Status", "Chegada", "Tempo no bairro", "Bairro no mapa"];
    doc.autoTable({
      startY: 38, head: [colunas], body: L.paradas.map((p) => colunas.map((c) => p[c])),
      styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: [11, 111, 179] },
      didParseCell: (d) => { if (d.section === "body") d.cell.styles.fillColor = cor[d.row.raw[4]] || null; },
    });
    let y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(11); doc.text("Bairros por onde passou fora da rota", 14, y);
    doc.autoTable({
      startY: y + 3, head: [["Bairro", "Cidade", "Chegada", "Saída", "Tempo no bairro"]],
      body: L.extras.length ? L.extras.map((e) => [e.Bairro, e.Cidade, e.Chegada, e["Saída"], e["Tempo no bairro"]]) : [["(nenhum)", "", "", "", ""]],
      styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: [102, 112, 133] },
    });
    y = doc.lastAutoTable.finalY + 6;
    doc.setFontSize(8); doc.setTextColor(102);
    const sem = ultimo.a.semBairro ? ` ${ultimo.a.semBairro} ponto(s) ainda sem bairro identificado.` : "";
    doc.text(`Gerado em ${h.gerado}. Bairro obtido pela posição da tag (OpenStreetMap); passagens rápidas sem celulares por perto podem não ser registradas.${sem}`, 14, y, { maxWidth: 270 });
    doc.save(h.arquivo + ".pdf");
  }

  async function exportar(tipo, botao) {
    if (!ultimo) return;
    const texto = botao.textContent;
    botao.disabled = true; botao.textContent = "Gerando…";
    try { await (tipo === "pdf" ? exportarPdf() : exportarExcel()); }
    catch (e) { alert("Não consegui gerar o arquivo: " + e.message); }
    finally { botao.disabled = false; botao.textContent = texto; }
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
      // carro pela placa do PDF; se não achar, o carro selecionado na tela
      const porPlaca = r.placa && Object.values(ctx.tags()).find((t) => normPlaca(t.placa) === r.placa);
      const escolhido = porPlaca ? porPlaca.id : ctx.carro();
      const opcoes = Object.values(ctx.tags()).map((t) => `<option value="${e(t.id)}"${t.id === escolhido ? " selected" : ""}>${e(t.nome)}</option>`).join("");
      box.innerHTML =
        `<p><b>Confira a rota lida do PDF:</b></p>` +
        `<p class="small">Motorista: <b>${e(r.motorista || "não identificado")}</b> · Carregamento: <b>${e(r.carregamento || "—")}</b>` +
        ` · Placa: <b>${e(r.placa || "não informada no PDF")}</b></p>` +
        `<p class="small" id="rota-placa-status"></p>` +
        `<div class="linha"><label class="small">Carro <select id="rota-carro">${opcoes}</select></label>` +
        `<label class="small">Dia <input type="date" id="rota-dia" value="${r.dia || ctx.dia()}"></label></div>` +
        `<ol class="small rota-previa-lista">${r.paradas.map((s) => `<li><b>${e(s.bairro)}</b> — ${e(s.cliente)} <span class="muted">(${e(s.praca)})</span></li>`).join("")}</ol>` +
        `<div class="linha"><button class="btn primary" data-salvar>Salvar rota</button><button class="btn" data-cancelar>Cancelar</button></div>`;
      $("rota-carro").addEventListener("change", conferirPlaca);
      conferirPlaca();
    } catch (err) {
      previa = null;
      box.innerHTML = `<p class="erro">Não consegui ler este PDF: ${ctx.esc(err.message)}</p><button class="btn" data-cancelar>Fechar</button>`;
    }
  }

  // Validação: placa do PDF x placa cadastrada no carro escolhido
  function situacaoPlaca() {
    const t = ctx.tags()[$("rota-carro").value];
    const pdf = previa?.placa, carro = normPlaca(t?.placa);
    if (!pdf) return { ok: null, txt: "O PDF não traz placa — confira se o carro escolhido está certo." };
    if (!carro) return { ok: null, txt: `O carro escolhido não tem placa cadastrada (⚙ Carros). Placa do PDF: ${pdf}.` };
    return pdf === carro ? { ok: true, txt: `✅ Placa do PDF (${pdf}) confere com o carro escolhido.` }
                         : { ok: false, txt: `⚠️ A placa do PDF (${pdf}) é diferente da placa do carro escolhido (${carro}).` };
  }
  function conferirPlaca() {
    const s = situacaoPlaca(), el = $("rota-placa-status");
    el.textContent = s.txt;
    el.className = "small " + (s.ok === true ? "placa-ok" : s.ok === false ? "placa-alerta" : "muted");
  }

  async function salvar() {
    const tag = $("rota-carro").value, dia = $("rota-dia").value;
    if (!tag || !dia || !previa) return;
    const s = situacaoPlaca();
    if (s.ok === false && !confirm(s.txt.replace("⚠️ ", "") + "\n\nSalvar mesmo assim neste carro?")) return;
    const box = $("rota-previa");
    box.querySelector("[data-salvar]").disabled = true;
    const nome = `${tag}/${dia}/${(previa.carregamento || "rota").replace(/[^\w-]/g, "")}-${Date.now()}.pdf`;
    const up = await ctx.sb.storage.from("rotas").upload(nome, previa.arquivo, { contentType: "application/pdf" });
    if (up.error) { box.insertAdjacentHTML("beforeend", `<p class="erro">Falha ao enviar o PDF: ${ctx.esc(up.error.message)}</p>`); return; }
    const ins = await ctx.sb.from("rotas").insert({
      tag_id: tag, dia, carregamento: previa.carregamento, motorista: previa.motorista, placa: previa.placa || null,
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
    if (b.dataset.exportar) return exportar(b.dataset.exportar, b);
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
