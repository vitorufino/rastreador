// Exportação do trajeto: KML, GeoJSON, GPX, CSV e link do Google Maps.
// Cada ponto: { tag_id, tagNome, cor, seq, total, hora ("HH:MM:SS"), seen_at (ISO), lat, lon, accuracy_m }
// Com vários carros, cada um vira uma pasta/trilha separada no arquivo.
(function () {
  const MAX_URL_PONTOS = 11; // Google Maps (web): origem + 9 paradas + destino

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const dataBR = (dia) => dia.split("-").reverse().join("/");
  const agrupar = (pts) => {
    const g = new Map();
    for (const p of pts) { if (!g.has(p.tag_id)) g.set(p.tag_id, []); g.get(p.tag_id).push(p); }
    return [...g.values()];
  };
  // KML usa cor no formato aabbggrr
  const kmlCor = (hex) => { const h = (hex || "#0b6fb3").replace("#", ""); return "ff" + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); };

  function kml(dia, pts) {
    const icone = (n) => `http://maps.google.com/mapfiles/kml/paddle/${n}.png`;
    const grupos = agrupar(pts);
    const pastas = grupos.map((lista, gi) => {
      const nome = lista[0].tagNome;
      const marcas = lista.map((p) => {
        const estilo = p.seq === 1 ? "#inicio" : p.seq === lista.length ? "#fim" : "#ponto";
        const prec = p.accuracy_m ? ` · precisão ~${Math.round(p.accuracy_m)} m` : "";
        return `      <Placemark>
        <name>${p.seq} · ${p.hora.slice(0, 5)}</name>
        <description>${esc(`${nome} — ponto ${p.seq} de ${lista.length} — ${dataBR(dia)} às ${p.hora}${prec}`)}</description>
        <TimeStamp><when>${p.seen_at}</when></TimeStamp>
        <styleUrl>${estilo}</styleUrl>
        <Point><coordinates>${p.lon},${p.lat},0</coordinates></Point>
      </Placemark>`;
      }).join("\n");
      const coords = lista.map((p) => `${p.lon},${p.lat},0`).join(" ");
      return `  <Style id="linha${gi}"><LineStyle><color>${kmlCor(lista[0].cor)}</color><width>4</width></LineStyle></Style>
  <Folder>
    <name>${esc(nome)}</name>
    <Folder>
      <name>Pontos (ordem cronológica)</name>
${marcas}
    </Folder>
    <Placemark>
      <name>Trajeto ${esc(nome)}</name>
      <styleUrl>#linha${gi}</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>
  </Folder>`;
    }).join("\n");
    const titulo = grupos.length === 1 ? `${grupos[0][0].tagNome} — ${dataBR(dia)}` : `Trajetos ${dataBR(dia)}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(titulo)}</name>
  <Style id="inicio"><IconStyle><Icon><href>${icone("grn-circle")}</href></Icon></IconStyle></Style>
  <Style id="fim"><IconStyle><Icon><href>${icone("red-square")}</href></Icon></IconStyle></Style>
  <Style id="ponto"><IconStyle><scale>0.7</scale><Icon><href>${icone("blu-circle")}</href></Icon></IconStyle></Style>
${pastas}
</Document>
</kml>
`;
  }

  function geojson(dia, pts) {
    const features = pts.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { carro: p.tagNome, ordem: p.seq, horario: p.hora, timestamp_utc: p.seen_at, precisao_m: p.accuracy_m, name: `${p.seq} · ${p.hora.slice(0, 5)}` },
    }));
    for (const lista of agrupar(pts)) {
      if (lista.length >= 2) {
        features.push({ type: "Feature", geometry: { type: "LineString", coordinates: lista.map((p) => [p.lon, p.lat]) },
          properties: { carro: lista[0].tagNome, name: `Trajeto ${lista[0].tagNome} ${dataBR(dia)}`, stroke: lista[0].cor } });
      }
    }
    return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
  }

  function gpx(dia, pts) {
    const wpts = pts.map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}"><time>${p.seen_at}</time><name>${esc(p.tagNome)} ${p.seq} · ${p.hora.slice(0, 5)}</name></wpt>`).join("\n");
    const trks = agrupar(pts).map((lista) => `  <trk><name>${esc(lista[0].tagNome)} ${dataBR(dia)}</name><trkseg>
${lista.map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}"><time>${p.seen_at}</time></trkpt>`).join("\n")}
  </trkseg></trk>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rastreador" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
${trks}
</gpx>
`;
  }

  function csv(dia, pts) {
    const linhas = [["carro", "ordem", "data", "horario", "latitude", "longitude", "precisao_m", "timestamp_utc"].join(";")];
    for (const p of pts) linhas.push([p.tagNome, p.seq, dataBR(dia), p.hora, p.lat, p.lon, p.accuracy_m ?? "", p.seen_at].join(";"));
    return "﻿" + linhas.join("\r\n") + "\r\n"; // BOM: Excel abre acentos certo
  }

  function googleMapsUrl(pts) {
    if (pts.length < 2) return null;
    let sel = pts;
    if (pts.length > MAX_URL_PONTOS) {
      const passo = (pts.length - 1) / (MAX_URL_PONTOS - 1);
      sel = Array.from({ length: MAX_URL_PONTOS }, (_, i) => pts[Math.round(i * passo)]);
    }
    const ll = sel.map((p) => `${p.lat},${p.lon}`);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${ll[0]}&destination=${ll[ll.length - 1]}&travelmode=driving`;
    if (ll.length > 2) url += "&waypoints=" + encodeURIComponent(ll.slice(1, -1).join("|")).replace(/%2C/g, ",");
    return url;
  }

  const FORMATOS = {
    kml: [kml, "application/vnd.google-earth.kml+xml"],
    geojson: [geojson, "application/geo+json"],
    gpx: [gpx, "application/gpx+xml"],
    csv: [csv, "text/csv;charset=utf-8"],
  };

  function baixar(fmt, dia, pts, sufixo = "") {
    const [fn, mime] = FORMATOS[fmt];
    const blob = new Blob([fn(dia, pts)], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `trajeto_${dia}${sufixo}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.Exportar = { baixar, googleMapsUrl, MAX_URL_PONTOS, _formatos: FORMATOS };
})();
