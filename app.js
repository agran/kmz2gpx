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

/* ---------- KML / KMZ / GPX parsing ---------- */

function parseGpxPointEl(el) {
  const lat = parseFloat(el.getAttribute("lat"));
  const lon = parseFloat(el.getAttribute("lon"));
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  const eleEl = getDirectChild(el, "ele");
  const timeEl = getDirectChild(el, "time");
  return {
    lat,
    lon,
    ele: eleEl ? parseFloat(getText(eleEl)) || 0 : 0,
    time: timeEl ? getText(timeEl) || null : null,
  };
}

function parseGpx(gpxText) {
  const doc = new DOMParser().parseFromString(gpxText, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error(
      "Не удалось разобрать GPX: файл повреждён или имеет неверный формат",
    );
  }

  const points = [];
  const tracks = [];
  let pointId = 0;
  let trackId = 0;

  for (const wptEl of doc.getElementsByTagName("wpt")) {
    const coord = parseGpxPointEl(wptEl);
    if (!coord) continue;
    const nameEl = getDirectChild(wptEl, "name");
    pointId += 1;
    points.push({
      id: pointId - 1,
      name: getText(nameEl) || `Точка ${pointId}`,
      lat: coord.lat,
      lon: coord.lon,
      ele: coord.ele,
      time: coord.time,
      selected: true,
    });
  }

  for (const trkEl of doc.getElementsByTagName("trk")) {
    const nameEl = getDirectChild(trkEl, "name");
    const segments = [];
    for (const segEl of trkEl.getElementsByTagName("trkseg")) {
      const seg = [];
      for (const ptEl of segEl.getElementsByTagName("trkpt")) {
        const coord = parseGpxPointEl(ptEl);
        if (coord) seg.push(coord);
      }
      if (seg.length) segments.push(seg);
    }
    if (segments.length) {
      trackId += 1;
      tracks.push({
        id: trackId,
        name: getText(nameEl) || `Трек ${trackId}`,
        segments,
        selected: true,
      });
    }
  }

  for (const rteEl of doc.getElementsByTagName("rte")) {
    const nameEl = getDirectChild(rteEl, "name");
    const seg = [];
    for (const ptEl of rteEl.getElementsByTagName("rtept")) {
      const coord = parseGpxPointEl(ptEl);
      if (coord) seg.push(coord);
    }
    if (seg.length) {
      trackId += 1;
      tracks.push({
        id: trackId,
        name: getText(nameEl) || `Маршрут ${trackId}`,
        segments: [seg],
        selected: true,
      });
    }
  }

  return { points, tracks };
}

// Reads a file and parses it regardless of format: KMZ (zip with a .kml
// inside), plain KML, or GPX. Detected primarily by content, since some
// files may be misnamed or lack the expected extension.
async function readAndParseFile(file) {
  const buffer = await file.arrayBuffer();

  try {
    const zip = await JSZip.loadAsync(buffer);
    const kmlEntryName = Object.keys(zip.files)
      .filter((n) => !zip.files[n].dir)
      .find((n) => n.toLowerCase().endsWith(".kml"));
    if (kmlEntryName) {
      const kmlText = await zip.files[kmlEntryName].async("string");
      return parseKml(kmlText);
    }
  } catch (zipErr) {
    // Not a zip archive — fall through to the plain-text formats below.
  }

  const text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("<gpx")) {
    return parseGpx(text);
  }
  if (text.includes("<kml") || text.includes("<Placemark")) {
    return parseKml(text);
  }
  throw new Error(
    "Не удалось распознать формат файла — поддерживаются KMZ, KML и GPX",
  );
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
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
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

function pointsRouteViaTrailsRequested() {
  const checkbox = document.getElementById("points-route-via-trails");
  return !!(checkbox && checkbox.checked);
}

// Public FOSSGIS OSRM instance (no API key required) used to try to route
// between two points along real trails/paths/roads.
const TRAIL_ROUTING_URL =
  "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";
// A routed detour is only used if it isn't more than this much longer than
// the straight line between the two points; otherwise we fall back to a
// straight segment (handles points placed off-trail).
const TRAIL_ROUTE_MAX_DEVIATION_RATIO = 0.6;
// If OSRM had to snap an input point more than this far to reach the
// nearest routable path, that point is likely off-trail (in a field,
// forest, building, etc.) — any leg touching it tends to include a
// nonsensical detour just to reach/leave that point, so we skip the routed
// geometry there and connect with a straight line instead.
const TRAIL_WAYPOINT_SNAP_MAX_METERS = 50;
// Skip routing very short hops — not worth the request, and avoids noise.
const TRAIL_ROUTE_MIN_SEGMENT_METERS = 20;
// Minimum delay between requests to the free public routing service, so we
// don't hammer it and trigger rate limiting (HTTP 429).
const TRAIL_ROUTE_REQUEST_DELAY_MS = 400;
// OSRM can route through many waypoints in a single request (one HTTP call
// instead of one per hop). For very large point counts we still split into
// a handful of chunks to keep the URL/response size and server load sane.
const TRAIL_ROUTE_MAX_WAYPOINTS_PER_REQUEST = 100;

// Set for the duration of a single routePointsViaTrails() run once the
// service starts responding with 429, so we stop sending more requests and
// just fall back to straight lines for the remaining points.
let trailRoutingRateLimited = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Splits points into overlapping chunks (each chunk shares its boundary
// point with the next) so a single OSRM request can cover up to
// TRAIL_ROUTE_MAX_WAYPOINTS_PER_REQUEST waypoints at a time.
function chunkPointsForRouting(points, maxPerChunk) {
  if (points.length <= maxPerChunk) return [points];
  const chunks = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(start + maxPerChunk - 1, points.length - 1);
    chunks.push(points.slice(start, end + 1));
    if (end >= points.length - 1) break;
    start = end;
  }
  return chunks;
}

// Flattens a leg's turn-by-turn steps into a single ordered list of
// coordinates, dropping the duplicate point shared by consecutive steps.
function legToPoints(leg) {
  const pts = [];
  for (const step of leg.steps || []) {
    const coords = (step.geometry && step.geometry.coordinates) || [];
    for (const [lon, lat] of coords) {
      const last = pts[pts.length - 1];
      if (
        last &&
        Math.abs(last.lat - lat) < 1e-9 &&
        Math.abs(last.lon - lon) < 1e-9
      ) {
        continue;
      }
      pts.push({ lat, lon, ele: 0, time: null });
    }
  }
  return pts;
}

// Routes every point in a chunk in one HTTP request. OSRM returns one "leg"
// per consecutive pair of waypoints, each with its own distance, plus one
// "waypoint" entry per input point telling us how far it had to be snapped
// to the nearest routable path. Combining both signals lets us pick which
// hops to keep on the routed trail and which to straighten out:
//   - a point snapped far away is treated as placed off-trail — the legs
//     touching it fall back to a straight line;
//   - otherwise a leg still falls back to a straight line if its routed
//     length deviates too much from the direct distance (e.g. no direct
//     path exists and OSRM loops far around).
async function routeChunkInOneRequest(points) {
  const coordsParam = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `${TRAIL_ROUTING_URL}${coordsParam}?overview=false&geometries=geojson&steps=true`;

  console.log(`[OSRM] Запрос: ${points.length} точек →`, url);
  let response;
  try {
    response = await fetch(url);
  } catch (networkErr) {
    console.warn("[OSRM] Запрос не выполнен (сеть/CORS):", networkErr);
    throw networkErr;
  }
  console.log(
    `[OSRM] Ответ сервера: HTTP ${response.status} ${response.statusText}`,
  );

  if (response.status === 429) {
    trailRoutingRateLimited = true;
    console.warn(
      "[OSRM] Сервис вернул 429 Too Many Requests — запрос отклонён, дальнейшие запросы в этом прогоне отменяются",
    );
    throw new Error("Routing service rate limit (429)");
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.warn(
      `[OSRM] Запрос отклонён: HTTP ${response.status} ${response.statusText}`,
      bodyText.slice(0, 300),
    );
    throw new Error("Routing request failed");
  }

  const data = await response.json();
  if (data.code !== "Ok" || !data.routes || !data.routes.length) {
    console.warn(
      `[OSRM] Сервис ответил кодом "${data.code}" вместо "Ok" — маршрут не построен`,
      data,
    );
    throw new Error("No route found");
  }

  const offTrail = (data.waypoints || []).map(
    (wp) =>
      !!wp &&
      typeof wp.distance === "number" &&
      wp.distance > TRAIL_WAYPOINT_SNAP_MAX_METERS,
  );
  console.log(
    `[OSRM] Успех: код "${data.code}", ${data.waypoints ? data.waypoints.length : 0} waypoints, ` +
      `${offTrail.filter(Boolean).length} из них похоже не на тропе (snap > ${TRAIL_WAYPOINT_SNAP_MAX_METERS} м)`,
  );

  const legs = data.routes[0].legs || [];
  const segments = [];
  for (let i = 0; i < legs.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const straight = haversineMeters(a, b);
    const leg = legs[i];
    const endpointOffTrail = offTrail[i] || offTrail[i + 1];
    const withinDeviation =
      straight >= TRAIL_ROUTE_MIN_SEGMENT_METERS &&
      leg.distance <= straight * (1 + TRAIL_ROUTE_MAX_DEVIATION_RATIO);
    let segmentPoints = [a, b];
    let usedTrail = false;
    if (!endpointOffTrail && withinDeviation) {
      const legPoints = legToPoints(leg);
      if (legPoints.length >= 2) {
        segmentPoints = legPoints;
        usedTrail = true;
      }
    }
    console.log(
      `[OSRM]   Отрезок ${i + 1}/${legs.length}: прямая ${straight.toFixed(0)} м, ` +
        `по тропе ${leg.distance.toFixed(0)} м → ${usedTrail ? "используем тропу" : "используем прямую"}` +
        (endpointOffTrail ? " (точка снята с тропы слишком далеко)" : ""),
    );
    segments.push({ points: segmentPoints, viaTrail: usedTrail });
  }
  return segments;
}

// Concatenates an ordered list of {points, viaTrail} segments into a single
// flat point list, dropping the duplicate boundary point shared by
// consecutive segments.
function flattenSegments(segments) {
  const result = [];
  for (const seg of segments) {
    for (let i = 0; i < seg.points.length; i++) {
      if (i === 0 && result.length) continue;
      result.push(seg.points[i]);
    }
  }
  return result;
}

// Tries to route the *entire* list of points in a single OSRM request first
// (fastest, one HTTP call no matter how many points). Only if that single
// big request fails outright (too many waypoints, timeout, service error)
// do we fall back to splitting into smaller chunks.
async function routePointsViaTrails(points) {
  if (points.length < 2) return [{ points: points.slice(), viaTrail: null }];
  trailRoutingRateLimited = false;

  console.log(
    `[OSRM] Прокладываем маршрут для ${points.length} точек одним запросом...`,
  );
  try {
    const segments = await routeChunkInOneRequest(points);
    console.log(
      `[OSRM] Готово: единый запрос успешен, отрезков: ${segments.length}`,
    );
    return segments;
  } catch (err) {
    if (trailRoutingRateLimited) {
      console.warn(
        "[OSRM] Сервис отклонил запрос из-за ограничения частоты (429) — все точки соединяются напрямую",
      );
      showToast(
        "Сервис маршрутов по тропам временно ограничил запросы — точки соединены напрямую",
        true,
      );
      return [{ points: points.slice(), viaTrail: false }];
    }
    console.warn(
      "[OSRM] Единый запрос со всеми точками не удался, пробуем частями:",
      err,
    );
    return routePointsViaTrailsChunked(points);
  }
}

// Fallback used only when the single all-points request above fails: routes
// the points in smaller overlapping chunks so one oversized/unreachable
// request doesn't block routing entirely.
async function routePointsViaTrailsChunked(points) {
  const chunks = chunkPointsForRouting(
    points,
    TRAIL_ROUTE_MAX_WAYPOINTS_PER_REQUEST,
  );
  console.log(
    `[OSRM] Разбиваем на ${chunks.length} запрос(а) по ${TRAIL_ROUTE_MAX_WAYPOINTS_PER_REQUEST} точек`,
  );
  const allSegments = [];

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (trailRoutingRateLimited) {
      console.warn(
        `[OSRM] Пропуск части ${c + 1}/${chunks.length} — уже ограничены (429)`,
      );
      allSegments.push({ points: chunk, viaTrail: false });
      continue;
    }
    try {
      const chunkSegments = await routeChunkInOneRequest(chunk);
      allSegments.push(...chunkSegments);
    } catch (err) {
      if (!trailRoutingRateLimited) {
        console.warn(
          `[OSRM] Часть ${c + 1}/${chunks.length} не проложена, используем прямые линии:`,
          err,
        );
      }
      allSegments.push({ points: chunk, viaTrail: false });
    }
    if (c < chunks.length - 1 && !trailRoutingRateLimited) {
      await sleep(TRAIL_ROUTE_REQUEST_DELAY_MS);
    }
  }

  if (trailRoutingRateLimited) {
    showToast(
      "Сервис маршрутов по тропам временно ограничил запросы — часть точек соединена напрямую",
      true,
    );
  }
  return allSegments;
}

async function buildTrackPointsForExport(points) {
  const ordered = maybeOrderByProximity(points);
  if (pointsRouteViaTrailsRequested()) {
    try {
      const segments = await routePointsViaTrails(ordered);
      return { points: flattenSegments(segments), segments };
    } catch (err) {
      console.error("Не удалось проложить маршрут по тропам:", err);
      return {
        points: ordered,
        segments: [{ points: ordered, viaTrail: false }],
      };
    }
  }
  return { points: ordered, segments: [{ points: ordered, viaTrail: null }] };
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

function nextPointId() {
  return state.points.length
    ? Math.max(...state.points.map((p) => p.id)) + 1
    : 0;
}

function nextTrackId() {
  return state.tracks.length
    ? Math.max(...state.tracks.map((t) => t.id)) + 1
    : 1;
}

function gpxForScope(scope) {
  const asTrack = pointsAsTrackRequested();
  switch (scope) {
    case "all": {
      if (asTrack) {
        return buildTrackPointsForExport(state.points).then(({ points }) => {
          const pointsTrack = pointsToTrack(points);
          const tracks = pointsTrack
            ? [...state.tracks, pointsTrack]
            : state.tracks;
          return buildGpx({ tracks });
        });
      }
      return buildGpx({ points: state.points, tracks: state.tracks });
    }
    case "tracks-selected":
      return buildGpx({ tracks: state.tracks.filter((t) => t.selected) });
    case "points-all": {
      if (asTrack) {
        return buildTrackPointsForExport(state.points).then(({ points }) => {
          const pointsTrack = pointsToTrack(points);
          return buildGpx({ tracks: pointsTrack ? [pointsTrack] : [] });
        });
      }
      return buildGpx({ points: state.points });
    }
    case "points-selected": {
      const selected = state.points.filter((p) => p.selected);
      if (asTrack) {
        return buildTrackPointsForExport(selected).then(({ points }) => {
          const pointsTrack = pointsToTrack(points);
          return buildGpx({ tracks: pointsTrack ? [pointsTrack] : [] });
        });
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
let pointsTrackPreviewLayers = [];
let previewRequestToken = 0;
// Tracks the point most recently added via a map click, so a second click on
// that exact point (while still in add mode) removes it — a quick "undo"
// for an accidental/misplaced click, without affecting any other point.
let lastAddedPointId = null;

function mapClickAddModeRequested() {
  const checkbox = document.getElementById("map-click-add-mode");
  return !!(checkbox && checkbox.checked);
}

function mapDragModeRequested() {
  const checkbox = document.getElementById("map-drag-mode");
  return !!(checkbox && checkbox.checked);
}

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
  map.on("click", (e) => {
    if (!mapClickAddModeRequested()) return;
    addManualPoint(e.latlng.lat, e.latlng.lng, "");
    showToast("Точка добавлена по клику на карте");
  });
  return map;
}

function trackStyle(selected) {
  return selected
    ? { color: "#2563eb", weight: 5, opacity: 0.9 }
    : { color: "#9aa5b1", weight: 3, opacity: 0.6, dashArray: "4 6" };
}

function pointDivIcon(selected) {
  const size = selected ? 18 : 14;
  const fill = selected ? "#2563eb" : "#c3c9d1";
  const border = selected ? "#1d4ed8" : "#8b93a1";
  return L.divIcon({
    className: "point-marker-icon",
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:2px solid ${border};box-shadow:0 0 0 1px rgba(255,255,255,.7);"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function previewSegmentStyle(viaTrail) {
  if (viaTrail === true) {
    // Successfully routed along a real trail/path.
    return { color: "#16a34a", weight: 4, opacity: 0.9 };
  }
  if (viaTrail === false) {
    // Routing was attempted for this hop but rejected (off-trail point or
    // too big a detour) — connected with a plain straight line instead.
    return { color: "#f59e0b", weight: 4, opacity: 0.85, dashArray: "2 8" };
  }
  // Routing wasn't requested at all — just a plain order preview.
  return { color: "#16a34a", weight: 4, opacity: 0.85, dashArray: "2 8" };
}

function previewSegmentTooltip(viaTrail) {
  if (viaTrail === true) return "По тропе";
  if (viaTrail === false)
    return "Напрямую (тропа не найдена или точка не на тропе)";
  return "Предпросмотр маршрута из выбранных точек";
}

function clearPointsTrackPreview() {
  if (mapLayerGroup) {
    for (const layer of pointsTrackPreviewLayers) {
      mapLayerGroup.removeLayer(layer);
    }
  }
  pointsTrackPreviewLayers = [];
}

function updatePointsTrackPreview() {
  const myToken = ++previewRequestToken;
  if (!mapLayerGroup) return;
  clearPointsTrackPreview();
  if (!pointsAsTrackRequested()) return;
  const selectedPoints = state.points.filter((p) => p.selected);
  if (selectedPoints.length < 2) return;

  Promise.resolve(buildTrackPointsForExport(selectedPoints))
    .catch(() => {
      const ordered = maybeOrderByProximity(selectedPoints);
      return {
        points: ordered,
        segments: [{ points: ordered, viaTrail: null }],
      };
    })
    .then(({ segments }) => {
      if (myToken !== previewRequestToken || !mapLayerGroup) return;
      for (const seg of segments) {
        if (seg.points.length < 2) continue;
        const latlngs = seg.points.map((p) => [p.lat, p.lon]);
        const line = L.polyline(latlngs, previewSegmentStyle(seg.viaTrail));
        line.bindTooltip(previewSegmentTooltip(seg.viaTrail));
        line.addTo(mapLayerGroup);
        line.bringToBack();
        pointsTrackPreviewLayers.push(line);
      }
    });
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

// Removes a point entirely (used to "undo" a just-added point on a second
// click while in map-click-add-mode).
function removePoint(id) {
  const idx = state.points.findIndex((p) => p.id === id);
  if (idx === -1) return;
  state.points.splice(idx, 1);
  const marker = pointLayerById[id];
  if (marker && mapLayerGroup) mapLayerGroup.removeLayer(marker);
  delete pointLayerById[id];
  if (lastAddedPointId === id) lastAddedPointId = null;
  renderLists();
  updatePointsTrackPreview();
}

function createPointMarker(point) {
  const marker = L.marker([point.lat, point.lon], {
    icon: pointDivIcon(point.selected),
    draggable: mapDragModeRequested(),
    autoPan: true,
  });
  marker.bindTooltip(escapeXml(point.name));
  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    if (mapClickAddModeRequested()) {
      // A second click on the point that was *just* added removes it again
      // (quick undo for a misplaced click). Any other point is left alone
      // — the click is meant for adding, not for toggling selection.
      if (point.id === lastAddedPointId) {
        removePoint(point.id);
        showToast("Точка удалена");
      }
      return;
    }
    togglePointSelection(point.id);
  });
  marker.on("dragend", () => {
    const latlng = marker.getLatLng();
    point.lat = latlng.lat;
    point.lon = latlng.lng;
    renderLists();
    updatePointsTrackPreview();
  });
  return marker;
}

function addManualPoint(lat, lon, name) {
  const mapInstance = ensureMap();
  const wasEmpty = state.points.length === 0 && state.tracks.length === 0;
  const id = nextPointId();
  const point = {
    id,
    name: name && name.trim() ? name.trim() : `Точка ${id + 1}`,
    lat,
    lon,
    ele: 0,
    time: null,
    selected: true,
  };
  state.points.push(point);
  const marker = createPointMarker(point);
  marker.addTo(mapLayerGroup);
  pointLayerById[point.id] = marker;
  lastAddedPointId = point.id;
  if (wasEmpty) {
    mapInstance.setView([lat, lon], 15);
  }
  renderLists();
  updatePointsTrackPreview();
  return point;
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
        if (mapClickAddModeRequested()) {
          // Let the user place a point directly on the track instead of
          // toggling its selection — that's what the click was meant to do.
          addManualPoint(e.latlng.lat, e.latlng.lng, "");
          showToast("Точка добавлена по клику на карте");
          return;
        }
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
    const marker = createPointMarker(point);
    marker.addTo(mapLayerGroup);
    pointLayerById[point.id] = marker;
    allLatLngs.push([point.lat, point.lon]);
  }

  if (allLatLngs.length) {
    mapInstance.fitBounds(allLatLngs, { padding: [24, 24], maxZoom: 16 });
  } else {
    mapInstance.setView([20, 0], 2);
  }

  pointsTrackPreviewLayers = [];
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
    if (marker) marker.setIcon(pointDivIcon(point.selected));
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

document
  .getElementById("points-route-via-trails")
  .addEventListener("change", () => {
    updatePointsTrackPreview();
  });

document.getElementById("map-drag-mode").addEventListener("change", () => {
  const enabled = mapDragModeRequested();
  for (const marker of Object.values(pointLayerById)) {
    if (!marker.dragging) continue;
    if (enabled) marker.dragging.enable();
    else marker.dragging.disable();
  }
  showToast(
    enabled
      ? "Перетаскивание точек включено"
      : "Перетаскивание точек выключено",
  );
});

document.querySelectorAll("button[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const scope = btn.dataset.scope;
    const usesRouting =
      pointsAsTrackRequested() && pointsRouteViaTrailsRequested();
    if (usesRouting) showToast("Прокладываем маршрут по тропам…");
    const gpx = await gpxForScope(scope);
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
  lastAddedPointId = null;
  fileInput.value = "";
  fileStatus.textContent = "";
  fileStatus.classList.remove("error");
  fileDropText.textContent = "Нажмите, чтобы выбрать KMZ/KML/GPX файл";
  renderLists();
  renderMap();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  fileDropText.textContent = file.name;
  fileStatus.classList.remove("error");
  fileStatus.textContent = "Обработка файла...";

  try {
    const { points, tracks } = await readAndParseFile(file);

    if (!points.length && !tracks.length) {
      throw new Error("В файле не найдено ни точек, ни треков");
    }

    const pointIdOffset = nextPointId();
    const trackIdOffset = nextTrackId();
    const newPoints = points.map((p, i) => ({ ...p, id: pointIdOffset + i }));
    const newTracks = tracks.map((t, i) => ({ ...t, id: trackIdOffset + i }));

    state.points = state.points.concat(newPoints);
    state.tracks = state.tracks.concat(newTracks);
    state.fileBaseName =
      file.name.replace(/\.(kmz|kml|gpx)$/i, "") || "export";

    fileStatus.textContent = `Добавлено: ${tracks.length} трек(ов), ${points.length} точ(ек). Всего: ${state.tracks.length} трек(ов), ${state.points.length} точ(ек)`;
    renderLists();
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

renderLists();
renderMap();
requestAnimationFrame(() => {
  if (map) map.invalidateSize();
});

/* ---------- PWA install / offline support ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((err) => console.error("Ошибка регистрации service worker:", err));
  });
}
