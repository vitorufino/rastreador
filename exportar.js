// Exportação do trajeto: KML, GeoJSON, GPX, CSV e link do Google Maps.
// Cada ponto: { seq, hora ("HH:MM:SS"), seen_at (ISO), lat, lon, accuracy_m }
(function () {
  const MAX_URL_PONTOS = 11; // Google Maps (web): origem + 9 paradas + destino

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const dataBR = (dia) => dia.split("-").reverse().join("/");

  function kml(dia, pts) {
    const icone = (n) => `http://maps.google.com/mapfiles/kml/paddle/${n}.png`;
    const marcas = pts.map((p) => {
      const estilo = p.seq === 1 ? "#inicio" : p.seq === pts.length ? "#fim" : "#ponto";
      const prec = p.accuracy_m ? ` · precisão ~${Math.round(p.accuracy_m)} m` : "";
      return `    <Placemark>
      <name>${p.seq} · ${p.hora.slice(0, 5)}</name>
      <description>${esc(`Ponto ${p.seq} de ${pts.length} — ${dataBR(dia)} às ${p.hora}${prec}`)}</description>
      <TimeStamp><when>${p.seen_at}</when></TimeStamp>
      <styleUrl>${estilo}</styleUrl>
      <Point><coordinates>${p.lon},${p.lat},0</coordinates></Point>
    </Placemark>`;
    }).join("\n");
    const coords = pts.map((p) => `${p.lon},${p.lat},0`).join(" ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Trajeto ${dataBR(dia)}</name>
  <Style id="inicio"><IconStyle><Icon><href>${icone("grn-circle")}</href></Icon></IconStyle></Style>
  <Style id="fim"><IconStyle><Icon><href>${icone("red-square")}</href></Icon></IconStyle></Style>
  <Style id="ponto"><IconStyle><scale>0.7</scale><Icon><href>${icone("blu-circle")}</href></Icon></IconStyle></Style>
  <Style id="linha"><LineStyle><color>ffb36f0b</color><width>4</width></LineStyle></Style>
  <Folder>
    <name>Pontos (ordem cronológica)</name>
${marcas}
  </Folder>
  <Placemark>
    <name>Trajeto</name>
    <styleUrl>#linha</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
  </Placemark>
</Document>
</kml>
`;
  }

  function geojson(dia, pts) {
    const features = pts.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { ordem: p.seq, horario: p.hora, timestamp_utc: p.seen_at, precisao_m: p.accuracy_m, name: `${p.seq} · ${p.hora.slice(0, 5)}` },
    }));
    if (pts.length >= 2) {
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: pts.map((p) => [p.lon, p.lat]) }, properties: { name: `Trajeto ${dataBR(dia)}` } });
    }
    return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
  }

  function gpx(dia, pts) {
    const wpts = pts.map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}"><time>${p.seen_at}</time><name>${p.seq} · ${p.hora.slice(0, 5)}</name></wpt>`).join("\n");
    const trk = pts.map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}"><time>${p.seen_at}</time></trkpt>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rastreador" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk><name>Trajeto ${dataBR(dia)}</name><trkseg>
${trk}
  </trkseg></trk>
</gpx>
`;
  }

  function csv(dia, pts) {
    const linhas = [["ordem", "data", "horario", "latitude", "longitude", "precisao_m", "timestamp_utc"].join(";")];
    for (const p of pts) linhas.push([p.seq, dataBR(dia), p.hora, p.lat, p.lon, p.accuracy_m ?? "", p.seen_at].join(";"));
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

  function baixar(fmt, dia, pts) {
    const [fn, mime] = FORMATOS[fmt];
    const blob = new Blob([fn(dia, pts)], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `trajeto_${dia}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.Exportar = { baixar, googleMapsUrl, MAX_URL_PONTOS };
})();
