"use strict";

/* ---------- State ---------- */

const state = {
  points: [], // { id, name, lat, lon, ele, time, selected }
  tracks: [], // { id, name, segments: [ [ {lat, lon, ele, time}, ... ] ], selected }
  fileBaseName: "export",
};

/* ---------- DOM refs ---------- */

const fileInput = document.getElementById("file-input");
const fileDropText = document.getElementById("file-drop-text");
const fileStatus = document.getElementById("file-status");
const resultCard = document.getElementById("result-card");
const tracksList = document.getElementById("tracks-list");
const pointsList = document.getElementById("points-list");
const tracksEmpty = document.getElementById("tracks-empty");
const pointsEmpty = document.getElementById("points-empty");
const tracksCountEl = document.getElementById("tracks-count");
const pointsCountEl = document.getElementById("points-count");
const toastEl = document.getElementById("toast");

/* ---------- Utils ---------- */

function showToast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function escapeXml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[ch],
  );
}

function getDirectChild(el, tag) {
  const lower = tag.toLowerCase();
  for (const child of el.children) {
    const name = child.tagName;
    if (
      name === tag ||
      name.toLowerCase() === lower ||
      name.toLowerCase().endsWith(":" + lower)
    ) {
      return child;
    }
  }
  return null;
}

function getText(el) {
  return el ? el.textContent.trim() : "";
}

function parseCoordToken(token) {
  const parts = token.split(",").map((v) => parseFloat(v));
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1]))
    return null;
  return { lon: parts[0], lat: parts[1], ele: parts[2] || 0 };
}

function parseCoordsList(text) {
  return text.trim().split(/\s+/).map(parseCoordToken).filter(Boolean);
}

/* ---------- KML / KMZ parsing ---------- */

async function readFileAsKmlText(file) {
  const buffer = await file.arrayBuffer();
  // Try to treat the file as a zip archive (KMZ).
  try {
    const zip = await JSZip.loadAsync(buffer);
    const kmlEntryName = Object.keys(zip.files)
      .filter((n) => !zip.files[n].dir)
      .find((n) => n.toLowerCase().endsWith(".kml"));
    if (kmlEntryName) {
      return await zip.files[kmlEntryName].async("string");
    }
    throw new Error("В архиве KMZ не найден файл .kml");
  } catch (zipErr) {
    // Not a zip (or no kml inside) — fall back to treating it as raw KML text.
    const text = new TextDecoder("utf-8").decode(buffer);
    if (text.includes("<kml") || text.includes("<Placemark")) {
      return text;
    }
    throw zipErr;
  }
}

function parseKml(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error(
      "Не удалось разобрать KML: файл повреждён или имеет неверный формат",
    );
  }

  const placemarks = doc.getElementsByTagName("Placemark");
  const points = [];
  const tracks = [];
  let pointId = 0;
  let trackId = 0;

  for (const pm of placemarks) {
    const nameEl = getDirectChild(pm, "name");
    const rawName = getText(nameEl);

    // Point geometry -> waypoint
    const pointEl = pm.getElementsByTagName("Point")[0];
    if (pointEl) {
      const coordEl = getDirectChild(pointEl, "coordinates");
      const coord = parseCoordToken(getText(coordEl));
      if (coord) {
        let time = null;
        const timeStamp = pm.getElementsByTagName("TimeStamp")[0];
        if (timeStamp) {
          const whenEl = getDirectChild(timeStamp, "when");
          time = getText(whenEl) || null;
        }
        points.push({
          id: pointId++,
          name: rawName || `Точка ${pointId}`,
          lat: coord.lat,
          lon: coord.lon,
          ele: coord.ele,
          time,
          selected: true,
        });
      }
    }

    // LineString geometry (possibly several inside a MultiGeometry) -> track
    const lineEls = pm.getElementsByTagName("LineString");
    if (lineEls.length) {
      const segments = [];
      for (const lineEl of lineEls) {
        const coordEl = getDirectChild(lineEl, "coordinates");
        const segPoints = parseCoordsList(getText(coordEl));
        if (segPoints.length) segments.push(segPoints);
      }
      if (segments.length) {
        trackId += 1;
        tracks.push({
          id: trackId,
          name: rawName || `Трек ${trackId}`,
          segments,
          selected: true,
        });
      }
    }

    // gx:Track geometry (Google Earth track extension) -> track with timestamps
    const gxTracks = pm.getElementsByTagName("gx:Track");
    for (const gxTrack of gxTracks) {
      const whens = gxTrack.getElementsByTagName("when");
      const coords = gxTrack.getElementsByTagName("gx:coord");
      const seg = [];
      for (let i = 0; i < coords.length; i++) {
        const parts = getText(coords[i]).split(/\s+/).map(Number);
        if (
          parts.length < 2 ||
          Number.isNaN(parts[0]) ||
          Number.isNaN(parts[1])
        )
          continue;
        seg.push({
          lon: parts[0],
          lat: parts[1],
          ele: parts[2] || 0,
          time: whens[i] ? getText(whens[i]) || null : null,
        });
      }
      if (seg.length) {
        trackId += 1;
        tracks.push({
          id: trackId,
          name: rawName || `Трек ${trackId}`,
          segments: [seg],
          selected: true,
        });
      }
    }
  }

  return { points, tracks };
}

/* ---------- GPX generation ---------- */

function pointToWpt(p) {
  let xml = `  <wpt lat="${p.lat}" lon="${p.lon}">\n`;
  if (p.ele) xml += `    <ele>${p.ele}</ele>\n`;
  if (p.time) xml += `    <time>${escapeXml(p.time)}</time>\n`;
  xml += `    <name>${escapeXml(p.name)}</name>\n`;
  xml += `  </wpt>\n`;
  return xml;
}

function trackToTrk(t) {
  let xml = `  <trk>\n    <name>${escapeXml(t.name)}</name>\n`;
  for (const seg of t.segments) {
    xml += `    <trkseg>\n`;
    for (const pt of seg) {
      xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">\n`;
      if (pt.ele) xml += `        <ele>${pt.ele}</ele>\n`;
      if (pt.time) xml += `        <time>${escapeXml(pt.time)}</time>\n`;
      xml += `      </trkpt>\n`;
    }
    xml += `    </trkseg>\n`;
  }
  xml += `  </trk>\n`;
  return xml;
}

function buildGpx({ points = [], tracks = [] }) {
  let body = "";
  for (const p of points) body += pointToWpt(p);
  for (const t of tracks) body += trackToTrk(t);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="kmz2gpx-web" xmlns="http://www.topografix.com/GPX/1/1" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n` +
    `${body}</gpx>\n`
  );
}

function pointsAsTrackRequested() {
  const checkbox = document.getElementById("points-as-track");
  return !!(checkbox && checkbox.checked);
}
function pointsOrderByProximityRequested() {
  const checkbox = document.getElementById("points-order-by-proximity");
  return !!(checkbox && checkbox.checked);
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Greedy nearest-neighbor reordering: starts from the first point (in list
// order) and repeatedly jumps to the closest remaining point. Useful when
// clarifying/extra points were appended to the end of the list instead of
// being placed in their proper position along the route.
function orderPointsByProximity(points) {
  if (points.length < 3) return points.slice();
  const remaining = points.slice();
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dist = haversineMeters(last, remaining[i]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered;
}

function maybeOrderByProximity(points) {
  return pointsOrderByProximityRequested()
    ? orderPointsByProximity(points)
    : points;
}
function pointsToTrack(points, name) {
  if (!points.length) return null;
  return {
    id: "points-as-track",
    name: name || "Точки",
    segments: [
      points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
    ],
  };
}

function gpxForScope(scope) {
  const asTrack = pointsAsTrackRequested();
  switch (scope) {
    case "all": {
      if (asTrack) {
        const pointsTrack = pointsToTrack(maybeOrderByProximity(state.points));
        const tracks = pointsTrack
          ? [...state.tracks, pointsTrack]
          : state.tracks;
        return buildGpx({ tracks });
      }
      return buildGpx({ points: state.points, tracks: state.tracks });
    }
    case "tracks-selected":
      return buildGpx({ tracks: state.tracks.filter((t) => t.selected) });
    case "points-all": {
      if (asTrack) {
        const pointsTrack = pointsToTrack(maybeOrderByProximity(state.points));
        return buildGpx({ tracks: pointsTrack ? [pointsTrack] : [] });
      }
      return buildGpx({ points: state.points });
    }
    case "points-selected": {
      const selected = state.points.filter((p) => p.selected);
      if (asTrack) {
        const pointsTrack = pointsToTrack(maybeOrderByProximity(selected));
        return buildGpx({ tracks: pointsTrack ? [pointsTrack] : [] });
      }
      return buildGpx({ points: selected });
    }
    default:
      return buildGpx({});
  }
}

function filenameForScope(scope) {
  const map = {
    all: "all",
    "tracks-selected": "tracks-selected",
    "points-all": "points-all",
    "points-selected": "points-selected",
  };
  return `${state.fileBaseName}-${map[scope] || scope}.gpx`;
}

/* ---------- Clipboard / download ---------- */

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function downloadGpx(text, filename) {
  const blob = new Blob([text], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- Map (OpenStreetMap / Leaflet) ---------- */

let map = null;
let mapLayerGroup = null;
let trackLayerById = {};
let pointLayerById = {};
let pointsTrackPreviewLine = null;

function ensureMap() {
  if (map) return map;
  map = L.map("map", { scrollWheelZoom: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  mapLayerGroup = L.layerGroup().addTo(map);
  map.setView([20, 0], 2);
  return map;
}

function trackStyle(selected) {
  return selected
    ? { color: "#2563eb", weight: 5, opacity: 0.9 }
    : { color: "#9aa5b1", weight: 3, opacity: 0.6, dashArray: "4 6" };
}

function pointStyle(selected) {
  return selected
    ? {
        radius: 7,
        color: "#1d4ed8",
        weight: 2,
        fillColor: "#2563eb",
        fillOpacity: 0.9,
      }
    : {
        radius: 5,
        color: "#8b93a1",
        weight: 1,
        fillColor: "#c3c9d1",
        fillOpacity: 0.6,
      };
}

function updatePointsTrackPreview() {
  if (!mapLayerGroup) return;
  if (pointsTrackPreviewLine) {
    mapLayerGroup.removeLayer(pointsTrackPreviewLine);
    pointsTrackPreviewLine = null;
  }
  if (!pointsAsTrackRequested()) return;
  const selectedPoints = state.points.filter((p) => p.selected);
  if (selectedPoints.length < 2) return;
  const orderedPoints = maybeOrderByProximity(selectedPoints);
  const latlngs = orderedPoints.map((p) => [p.lat, p.lon]);
  pointsTrackPreviewLine = L.polyline(latlngs, {
    color: "#16a34a",
    weight: 4,
    opacity: 0.85,
    dashArray: "2 8",
  });
  pointsTrackPreviewLine.bindTooltip(
    "Предпросмотр маршрута из выбранных точек",
  );
  pointsTrackPreviewLine.addTo(mapLayerGroup);
  pointsTrackPreviewLine.bringToBack();
}

function toggleTrackSelection(id) {
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;
  track.selected = !track.selected;
  renderLists();
  updateMapStyles();
}

function togglePointSelection(id) {
  const point = state.points.find((p) => p.id === id);
  if (!point) return;
  point.selected = !point.selected;
  renderLists();
  updateMapStyles();
  updatePointsTrackPreview();
}

function renderMap() {
  const mapInstance = ensureMap();
  mapLayerGroup.clearLayers();
  trackLayerById = {};
  pointLayerById = {};
  const allLatLngs = [];

  for (const track of state.tracks) {
    const segLayers = [];
    for (const seg of track.segments) {
      if (!seg.length) continue;
      const latlngs = seg.map((p) => [p.lat, p.lon]);
      const polyline = L.polyline(latlngs, trackStyle(track.selected));
      polyline.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        toggleTrackSelection(track.id);
      });
      polyline.bindTooltip(escapeXml(track.name));
      polyline.addTo(mapLayerGroup);
      segLayers.push(polyline);
      allLatLngs.push(...latlngs);
    }
    trackLayerById[track.id] = segLayers;
  }

  for (const point of state.points) {
    const marker = L.circleMarker(
      [point.lat, point.lon],
      pointStyle(point.selected),
    );
    marker.bindTooltip(escapeXml(point.name));
    marker.on("click", () => togglePointSelection(point.id));
    marker.addTo(mapLayerGroup);
    pointLayerById[point.id] = marker;
    allLatLngs.push([point.lat, point.lon]);
  }

  if (allLatLngs.length) {
    mapInstance.fitBounds(allLatLngs, { padding: [24, 24], maxZoom: 16 });
  } else {
    mapInstance.setView([20, 0], 2);
  }

  pointsTrackPreviewLine = null;
  updatePointsTrackPreview();
}

function updateMapStyles() {
  for (const track of state.tracks) {
    const layers = trackLayerById[track.id];
    if (!layers) continue;
    for (const layer of layers) layer.setStyle(trackStyle(track.selected));
  }
  for (const point of state.points) {
    const marker = pointLayerById[point.id];
    if (marker) marker.setStyle(pointStyle(point.selected));
  }
}

/* ---------- Rendering ---------- */

function trackPointCount(track) {
  return track.segments.reduce((sum, seg) => sum + seg.length, 0);
}

function renderLists() {
  tracksCountEl.textContent = state.tracks.length;
  pointsCountEl.textContent = state.points.length;

  tracksEmpty.classList.toggle("hidden", state.tracks.length > 0);
  pointsEmpty.classList.toggle("hidden", state.points.length > 0);

  tracksList.innerHTML = "";
  for (const track of state.tracks) {
    const li = document.createElement("li");
    li.className = "item-row";
    li.innerHTML = `
      <input type="checkbox" data-kind="track" data-id="${track.id}" ${track.selected ? "checked" : ""}>
      <div class="item-info">
        <span class="item-name">${escapeXml(track.name)}</span>
        <span class="item-meta">${trackPointCount(track)} точек, ${track.segments.length} сегм.</span>
      </div>`;
    tracksList.appendChild(li);
  }

  pointsList.innerHTML = "";
  for (const point of state.points) {
    const li = document.createElement("li");
    li.className = "item-row";
    li.innerHTML = `
      <input type="checkbox" data-kind="point" data-id="${point.id}" ${point.selected ? "checked" : ""}>
      <div class="item-info">
        <span class="item-name">${escapeXml(point.name)}</span>
        <span class="item-meta">${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}</span>
      </div>`;
    pointsList.appendChild(li);
  }
}

/* ---------- Event handlers ---------- */

tracksList.addEventListener("change", (e) => {
  const target = e.target;
  if (target.matches('input[data-kind="track"]')) {
    const id = Number(target.dataset.id);
    const track = state.tracks.find((t) => t.id === id);
    if (track) track.selected = target.checked;
    updateMapStyles();
  }
});

pointsList.addEventListener("change", (e) => {
  const target = e.target;
  if (target.matches('input[data-kind="point"]')) {
    const id = Number(target.dataset.id);
    const point = state.points.find((p) => p.id === id);
    if (point) point.selected = target.checked;
    updateMapStyles();
    updatePointsTrackPreview();
  }
});

document.getElementById("tracks-select-all").addEventListener("click", () => {
  state.tracks.forEach((t) => (t.selected = true));
  renderLists();
  updateMapStyles();
});
document.getElementById("tracks-select-none").addEventListener("click", () => {
  state.tracks.forEach((t) => (t.selected = false));
  renderLists();
  updateMapStyles();
});
document.getElementById("points-select-all").addEventListener("click", () => {
  state.points.forEach((p) => (p.selected = true));
  renderLists();
  updateMapStyles();
  updatePointsTrackPreview();
});
document.getElementById("points-select-none").addEventListener("click", () => {
  state.points.forEach((p) => (p.selected = false));
  renderLists();
  updateMapStyles();
  updatePointsTrackPreview();
});

document.getElementById("points-as-track").addEventListener("change", () => {
  updatePointsTrackPreview();
});

document
  .getElementById("points-order-by-proximity")
  .addEventListener("change", () => {
    updatePointsTrackPreview();
  });

document.querySelectorAll("button[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const scope = btn.dataset.scope;
    const gpx = gpxForScope(scope);
    if (btn.dataset.action === "copy") {
      const ok = await copyToClipboard(gpx);
      showToast(
        ok ? "GPX скопирован в буфер обмена" : "Не удалось скопировать",
        !ok,
      );
    } else if (btn.dataset.action === "download") {
      downloadGpx(gpx, filenameForScope(scope));
      showToast("Файл сохранён");
    }
  });
});

document.getElementById("reset-btn").addEventListener("click", () => {
  state.points = [];
  state.tracks = [];
  fileInput.value = "";
  fileStatus.textContent = "";
  fileStatus.classList.remove("error");
  fileDropText.textContent = "Нажмите, чтобы выбрать KMZ/KML файл";
  resultCard.classList.add("hidden");
  if (mapLayerGroup) mapLayerGroup.clearLayers();
  trackLayerById = {};
  pointLayerById = {};
  pointsTrackPreviewLine = null;
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  fileDropText.textContent = file.name;
  fileStatus.classList.remove("error");
  fileStatus.textContent = "Обработка файла...";
  resultCard.classList.add("hidden");

  try {
    const kmlText = await readFileAsKmlText(file);
    const { points, tracks } = parseKml(kmlText);

    if (!points.length && !tracks.length) {
      throw new Error("В файле не найдено ни точек, ни треков");
    }

    state.points = points;
    state.tracks = tracks;
    state.fileBaseName = file.name.replace(/\.(kmz|kml)$/i, "") || "export";

    fileStatus.textContent = `Готово: ${tracks.length} трек(ов), ${points.length} точ(ек)`;
    renderLists();
    resultCard.classList.remove("hidden");
    renderMap();
    requestAnimationFrame(() => {
      if (map) map.invalidateSize();
    });
  } catch (err) {
    console.error(err);
    fileStatus.classList.add("error");
    fileStatus.textContent = err.message || "Ошибка при обработке файла";
  }
});

/* ---------- PWA install / offline support ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((err) => console.error("Ошибка регистрации service worker:", err));
  });
}
