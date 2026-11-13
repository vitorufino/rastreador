// Filtro de pontos impossíveis.
// Na rede Find Hub, cada ponto é a posição do CELULAR de um desconhecido que "ouviu" a tag.
// Se a localização desse celular estava errada (desatualizada, estimada por Wi-Fi, relógio errado),
// o ponto cai longe do trajeto real. Aqui esses pontos são marcados como descartados (nada é apagado).
(function () {
  const VMAX_KMH = 100;        // velocidade máxima plausível entre dois pontos (após descontar a precisão)
  const PREC_MAX_M = 1000;     // pontos com margem de erro maior que isso são descartados
  const DT_MIN_S = 30;         // intervalo mínimo considerado (evita "velocidade infinita" no mesmo minuto)
  const ATRASO_SUSPEITO_MIN = 30;

  const rad = (g) => (g * Math.PI) / 180;
  function km(a, b) {
    const dp = rad(b.lat - a.lat), dl = rad(b.lon - a.lon);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  const seg = (a, b) => Math.max(DT_MIN_S, Math.abs(new Date(b.seen_at) - new Date(a.seen_at)) / 1000);
  // velocidade entre a e b descontando a margem de erro dos dois pontos
  const vel = (a, b) => Math.max(0, km(a, b) - ((a.accuracy_m || 0) + (b.accuracy_m || 0)) / 1000) / (seg(a, b) / 3600);
  const atrasoMin = (p) => (p.polled_at ? (new Date(p.polled_at) - new Date(p.seen_at)) / 60000 : 0);
  // quanto o ponto i "desvia" do caminho entre seus vizinhos válidos (km a mais percorridos por causa dele)
  function desvio(v, i) {
    const a = v[i - 1], b = v[i], c = v[i + 1];
    if (!a && !c) return 0;
    if (!a) return km(b, c);
    if (!c) return km(a, b);
    return km(a, b) + km(b, c) - km(a, c);
  }

  // recebe os pontos de UMA tag; devolve os mesmos objetos com .descartado / .motivo
  function filtrar(pontos) {
    const ord = pontos.slice().sort((a, b) => a.seen_at.localeCompare(b.seen_at));
    ord.forEach((p) => { p.descartado = false; p.motivo = ""; });
    for (const p of ord) {
      if (p.accuracy_m && p.accuracy_m > PREC_MAX_M) { p.descartado = true; p.motivo = `precisão ruim (~${Math.round(p.accuracy_m)} m)`; }
    }
    // remove, um por vez, o pior ponto envolvido num salto impossível, até não sobrar nenhum
    for (let volta = 0; volta < ord.length; volta++) {
      const v = ord.filter((p) => !p.descartado);
      let pior = null;
      for (let i = 0; i + 1 < v.length; i++) {
        const s = vel(v[i], v[i + 1]);
        if (s <= VMAX_KMH) continue;
        // qual dos dois está errado? o que mais desvia do trajeto; empate -> o que chegou atrasado / menos preciso
        const cand = [i, i + 1].map((k) => ({
          k, d: desvio(v, k), atraso: atrasoMin(v[k]) >= ATRASO_SUSPEITO_MIN ? 1 : 0, prec: v[k].accuracy_m || 0,
        })).sort((x, y) => (y.d - x.d) || (y.atraso - x.atraso) || (y.prec - x.prec));
        const escolhido = cand[0];
        if (!pior || s > pior.s) pior = { p: v[escolhido.k], s, d: escolhido.d };
      }
      if (!pior) break;
      pior.p.descartado = true;
      pior.p.motivo = `salto impossível (${Math.round(pior.s)} km/h, desvio de ${pior.d.toFixed(1)} km)`;
    }
    // "vai e volta": um ponto isolado longe do caminho entre vizinhos próximos entre si
    const v = ord.filter((p) => !p.descartado);
    for (let i = 1; i + 1 < v.length; i++) {
      const a = v[i - 1], b = v[i], c = v[i + 1];
      const dAC = Math.max(km(a, c), 0.2), d = desvio(v, i);
      const vAtravessando = (km(a, b) + km(b, c)) / (seg(a, c) / 3600);
      if (d > 2 && (km(a, b) + km(b, c)) / dAC > 4 && vAtravessando > 50) {
        b.descartado = true;
        b.motivo = `fora do trajeto (desvio de ${d.toFixed(1)} km entre pontos vizinhos)`;
      }
    }
    return pontos;
  }

  window.Filtro = { filtrar, km, VMAX_KMH, PREC_MAX_M };
})();
