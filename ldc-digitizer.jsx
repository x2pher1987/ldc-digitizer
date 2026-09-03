import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  UploadCloud, ScanLine, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Copy, Check, X, ChevronDown, ChevronUp, Trash2, Plus, History, RotateCcw,
  Compass, Ruler, MapPin, FileText, Paperclip, Download, Globe2, FolderOpen, ChevronsUpDown,
  BookOpen, ChevronRight, Save, Type,
} from 'lucide-react';

/* ============================================================================
   TRAVERSE ENGINE
   Faithful port of COORDINATES_TEMPLATE.xlsx ('2001' sheet) formulas.
   Validated against the workbook's cached values for a 22-corner lot:
   area, LEC, REC, ACC and all 22 bearings matched exactly.
   ========================================================================== */

// One line of the traverse: from point A to point B. Shared by the boundary
// traverse and by the TP-1 tie line (which is a single segment, not a polygon).
function computeLine(from, to) {
  const F = from.n - to.n; // change in Lat (Northing)
  const G = from.e - to.e; // change in Dep (Easting)
  const M = Math.sqrt(F * F + G * G); // distance

  const H = G === 0 ? (F > 0 ? 'South' : 'North') : '';
  const J = F === 0 ? (G > 0 ? 'West' : 'East') : '';
  const L = H + J;
  const Ival = H === 'North' ? 2 : 0;
  const Kval = J === 'West' ? 1 : (J === '' ? 0 : 3);

  let O;
  if (F === 0) O = 0;
  else O = Math.abs((Math.atan(G / F) * 180) / Math.PI);

  const P = Math.trunc(O);
  let Qraw = (O - P) * 60;
  Qraw = Math.round((Qraw + Number.EPSILON) * 1e6) / 1e6;
  const Qr = Math.round(Qraw);

  let R, S, T, U, Wv;
  if (L === '') {
    R = F > 0 ? 'S' : 'N';
    if (Qr === 60) { S = P + 1; T = 0; } else { S = P; T = Qr; }
    U = G > 0 ? 'W' : 'E';
    Wv = S + T / 60;
  } else {
    R = ''; U = ''; S = 'due'; T = L;
    Wv = 90 * (Ival + Kval);
  }

  let X;
  if (R === '') X = Wv;
  else if (R === 'N') X = U === 'E' ? 180 + Wv : 180 - Wv;
  else X = U === 'E' ? 360 - Wv : Wv;

  const Y = (X * Math.PI) / 180;
  const AA = -M * Math.cos(Y);
  const AB = -M * Math.sin(Y);

  const bearingText = L === ''
    ? `${R}${String(S).padStart(2, '0')}-${String(T).padStart(2, '0')}${U}`
    : `DUE ${L.toUpperCase()}`;

  return { F, G, M, AA, AB, bearingText };
}

function computeTraverse(corners) {
  const n = corners.length;
  if (n < 3) return null;

  const lines = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const seg = computeLine(corners[i], corners[j]);
    lines.push({
      ...seg,
      from: i + 1, to: j + 1,
      apLine: `${trimNum(corners[i].e)},${trimNum(corners[i].n)}`,
    });
  }

  const M40 = lines.reduce((s, l) => s + l.M, 0);
  const AA40 = lines.reduce((s, l) => s + l.AA, 0);
  const AB40 = lines.reduce((s, l) => s + l.AB, 0);
  const LEC = Math.sqrt(AA40 * AA40 + AB40 * AB40);
  const REC = LEC !== 0 ? M40 / LEC : Infinity;

  let ACC = null;
  if (isFinite(REC) && REC > 0) {
    const digits = String(Math.trunc(Math.abs(REC))).length;
    const roundTo = Math.pow(10, digits - 2);
    ACC = Math.round(REC / roundTo) * roundTo;
  }

  const AN = new Array(n);
  AN[0] = lines[0].F;
  for (let i = 1; i < n; i++) AN[i] = AN[i - 1] + lines[i - 1].F + lines[i].F;
  const AO = AN.map((v, i) => v * lines[i].G);
  const doubleArea = Math.abs(AO.reduce((s, v) => s + v, 0));
  const area = doubleArea / 2;

  // Proper polygon centroid (area-weighted, not a plain average of the corners) —
  // correct for irregular/concave lots, and what "auto-text the lot number"
  // should be positioned at in AutoCAD.
  let signedArea = 0, cN = 0, cE = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = corners[i].e * corners[j].n - corners[j].e * corners[i].n;
    signedArea += cross;
    cE += (corners[i].e + corners[j].e) * cross;
    cN += (corners[i].n + corners[j].n) * cross;
  }
  signedArea *= 0.5;
  const centroid = Math.abs(signedArea) > 1e-9
    ? { e: cE / (6 * signedArea), n: cN / (6 * signedArea) }
    : { e: corners.reduce((s, c) => s + c.e, 0) / n, n: corners.reduce((s, c) => s + c.n, 0) / n };

  return { lines, M40, AA40, AB40, LEC, REC, ACC, doubleArea, area, centroid };
}

function trimNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  // keep up to 3 decimals, drop trailing zeros, matching how the sheet's
  // literal Northing/Easting values were typed (no forced fixed decimals)
  return String(Math.round(v * 1000) / 1000);
}

/* ============================================================================
   GEODETIC CONVERSION — Philippine grid coordinates -> WGS84 (for Google Earth)
   Philippine cadastral Northing/Easting are Transverse Mercator grid values on
   a local datum, not WGS84 lat/long. Two datum families are in use and both are
   offered here, matching the AutoCAD "Available coordinate systems" list:
     - PRS92 / Philippines zone 1-5   (EPSG 3121-3125) — the current standard
     - Luzon 1911 / Philippines zone I-V (EPSG 25391-25395) — the older datum
       that 1980s-era LDC forms were originally computed on
   All ten share the same projection parameters (Clarke 1866 ellipsoid,
   k0 = 0.99995, false easting 500,000, CM every 2° from 117°E) and differ only
   in the datum shift to WGS84.

   Conversion is done properly through geocentric Cartesian coordinates rather
   than an approximate curvilinear shift:
     inverse Transverse Mercator -> geodetic -> Cartesian -> Helmert -> WGS84
   PRS92 uses the full 7-parameter transform from EPSG:15708, whose method is
   *Coordinate Frame rotation* (EPSG 9607) — the rotation sign convention here
   matters: applying the other convention (Position Vector) silently shifts
   results by ~25 m. Luzon 1911 uses EPSG's 3-parameter geocentric translations.

   VERIFIED against the PROJ library (pyproj, EPSG registry): converting the
   same grid points through EPSG:3124->4326 and EPSG:25394->4326 with pyproj
   and with this code agrees to 0.00 m — the PRS92 path implements the EPSG:15708
   Bursa-Wolf 7-parameter transformation exactly, and the Luzon path the EPSG
   geocentric translations.
   DATUM CHOICE MATTERS MORE THAN THE MATH: 1980s Bureau of Lands LDC sheets
   were computed on Luzon 1911, not PRS92 (which only exists from 1992), so the
   default here is Luzon 1911 zone IV. Selecting PRS92 for 1911-datum data
   introduces a systematic ~9 m shift in this area. Note also that EPSG rates
   the Luzon->WGS84 shift itself at ~17 m accuracy, and Google Earth imagery
   georegistration in provincial PH can be off by several meters — so treat the
   overlay as good for placement on imagery, not survey-grade.
   ========================================================================== */

const CLARKE1866 = { a: 6378206.4, f: 1 / 294.978698213898 };
const WGS84_ELLIPSOID = { a: 6378137.0, f: 1 / 298.257223563 };
const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

// EPSG:15708 PRS92 -> WGS84, method 9607 (Coordinate Frame rotation)
const PRS92_SHIFT = {
  dx: -127.62, dy: -67.24, dz: -47.04,
  rx: 3.068, ry: -4.903, rz: -1.578, s: -1.06,
  convention: 'coordinate_frame',
};
// Luzon 1911 -> WGS84, geocentric translations (EPSG 25391-25395 TOWGS84)
const LUZON_SHIFT_A = { dx: -133, dy: -77, dz: -51, convention: 'position_vector' };
const LUZON_SHIFT_B = { dx: -133, dy: -79, dz: -72, convention: 'position_vector' };

const PH_ZONES = {
  'PRS92-1': { label: 'PRS92 / Philippines zone 1', epsg: 3121, cm: 117, shift: PRS92_SHIFT, hint: 'west of 118°E' },
  'PRS92-2': { label: 'PRS92 / Philippines zone 2', epsg: 3122, cm: 119, shift: PRS92_SHIFT, hint: 'Palawan, Sulu' },
  'PRS92-3': { label: 'PRS92 / Philippines zone 3', epsg: 3123, cm: 121, shift: PRS92_SHIFT, hint: 'Luzon, Mindoro, Panay' },
  'PRS92-4': { label: 'PRS92 / Philippines zone 4', epsg: 3124, cm: 123, shift: PRS92_SHIFT, hint: 'Bicol, Masbate, Cebu' },
  'PRS92-5': { label: 'PRS92 / Philippines zone 5', epsg: 3125, cm: 125, shift: PRS92_SHIFT, hint: 'E Mindanao, Samar, Bohol' },
  'LUZON-I': { label: 'Luzon 1911 / Philippines zone I', epsg: 25391, cm: 117, shift: LUZON_SHIFT_A, hint: 'west of 118°E' },
  'LUZON-II': { label: 'Luzon 1911 / Philippines zone II', epsg: 25392, cm: 119, shift: LUZON_SHIFT_B, hint: 'Palawan, Sulu' },
  'LUZON-III': { label: 'Luzon 1911 / Philippines zone III', epsg: 25393, cm: 121, shift: LUZON_SHIFT_A, hint: 'Luzon, Mindoro, Panay' },
  'LUZON-IV': { label: 'Luzon 1911 / Philippines zone IV', epsg: 25394, cm: 123, shift: LUZON_SHIFT_A, hint: 'Bicol, Masbate, Cebu' },
  'LUZON-V': { label: 'Luzon 1911 / Philippines zone V', epsg: 25395, cm: 125, shift: LUZON_SHIFT_B, hint: 'E Mindanao, Samar, Bohol' },
};
const DEFAULT_ZONE = 'LUZON-IV';
const TM_FE = 500000, TM_FN = 0, TM_K0 = 0.99995;

function inverseTM(x, y, cmDeg, ellipsoid) {
  const { a, f } = ellipsoid;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = (y - TM_FN) / TM_K0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 = mu
    + (1.5 * e1 - (27 / 32) * e1 ** 3) * Math.sin(2 * mu)
    + ((21 / 16) * e1 ** 2 - (55 / 32) * e1 ** 4) * Math.sin(4 * mu)
    + ((151 / 96) * e1 ** 3) * Math.sin(6 * mu)
    + ((1097 / 512) * e1 ** 4) * Math.sin(8 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const T1 = Math.tan(phi1) ** 2;
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5);
  const D = (x - TM_FE) / (N1 * TM_K0);
  const phi = phi1 - ((N1 * Math.tan(phi1)) / R1) * (
    D ** 2 / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720
  );
  const lambda = (cmDeg * Math.PI) / 180 + (
    D - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120
  ) / Math.cos(phi1);
  return { lat: (phi * 180) / Math.PI, lon: (lambda * 180) / Math.PI };
}

// Geodetic (lat/lon on a given ellipsoid) -> geocentric Cartesian XYZ.
function geodeticToCartesian(latDeg, lonDeg, h, ellipsoid) {
  const { a, f } = ellipsoid;
  const e2 = 2 * f - f * f;
  const phi = (latDeg * Math.PI) / 180, lambda = (lonDeg * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return {
    X: (N + h) * Math.cos(phi) * Math.cos(lambda),
    Y: (N + h) * Math.cos(phi) * Math.sin(lambda),
    Z: (N * (1 - e2) + h) * Math.sin(phi),
  };
}

// Geocentric Cartesian XYZ -> geodetic, by the standard iteration (converges in a few passes).
function cartesianToGeodetic(X, Y, Z, ellipsoid) {
  const { a, f } = ellipsoid;
  const e2 = 2 * f - f * f;
  const lambda = Math.atan2(Y, X);
  const p = Math.sqrt(X * X + Y * Y);
  let phi = Math.atan2(Z, p * (1 - e2));
  let N = a, h = 0;
  for (let i = 0; i < 10; i++) {
    N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    h = p / Math.cos(phi) - N;
    phi = Math.atan2(Z, p * (1 - (e2 * N) / (N + h)));
  }
  return { lat: (phi * 180) / Math.PI, lon: (lambda * 180) / Math.PI, h };
}

// 7-parameter Helmert in geocentric space. The two conventions differ only in
// the sign of the rotation terms, but that difference is worth ~25 m here.
function helmert(X, Y, Z, p) {
  const { dx = 0, dy = 0, dz = 0, rx = 0, ry = 0, rz = 0, s = 0, convention } = p;
  const Rx = rx * ARCSEC_TO_RAD, Ry = ry * ARCSEC_TO_RAD, Rz = rz * ARCSEC_TO_RAD;
  const S = 1 + s * 1e-6;
  let sx, sy, sz;
  if (convention === 'coordinate_frame') {
    sx = X + Rz * Y - Ry * Z;
    sy = -Rz * X + Y + Rx * Z;
    sz = Ry * X - Rx * Y + Z;
  } else {
    sx = X - Rz * Y + Ry * Z;
    sy = Rz * X + Y - Rx * Z;
    sz = -Ry * X + Rx * Y + Z;
  }
  return { X: dx + S * sx, Y: dy + S * sy, Z: dz + S * sz };
}

function gridToWGS84(easting, northing, zoneKey) {
  const z = PH_ZONES[zoneKey] || PH_ZONES[DEFAULT_ZONE];
  const local = inverseTM(easting, northing, z.cm, CLARKE1866);
  const c = geodeticToCartesian(local.lat, local.lon, 0, CLARKE1866);
  const t = helmert(c.X, c.Y, c.Z, z.shift);
  return cartesianToGeodetic(t.X, t.Y, t.Z, WGS84_ELLIPSOID);
}

function buildKML(points, title, description, lotId) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // The Placemark id carries the lot number — QGIS surfaces it as the feature's
  // "id" field on Identify, and Google Earth ignores it harmlessly.
  const idAttr = String(lotId ?? '').trim() ? ` id="${esc(String(lotId).trim().replace(/\s+/g, '_'))}"` : '';
  const ring = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},0`).join(' ');
  const closedRing = points.length ? `${ring} ${points[0].lon.toFixed(6)},${points[0].lat.toFixed(6)},0` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${esc(title)}</name>
<Style id="lotBoundary"><LineStyle><color>ff2fc4e8</color><width>3</width></LineStyle><PolyStyle><color>552fc4e8</color></PolyStyle></Style>
<Placemark${idAttr}>
<name>${esc(title)}</name>
<description>${esc(description)}</description>
<styleUrl>#lotBoundary</styleUrl>
<Polygon><outerBoundaryIs><LinearRing><coordinates>${closedRing}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>
</Document>
</kml>`;
}


// Write text to the clipboard reliably. navigator.clipboard is often blocked
// inside sandboxed iframes, so on failure fall back to the classic hidden
// textarea + execCommand('copy') path, which actually WRITES the clipboard
// (unlike merely selecting the text and hoping the user presses Ctrl+C).
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function downloadTextFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------------
   Bearing / distance comparison helpers (computed vs what the AI read off
   the historical form) — this is the "yellow box" verification step.
   ------------------------------------------------------------------------- */

function parseBearing(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.trim().toUpperCase().match(/^([NS])\s*0*(\d{1,2})[°\-\s]+0*(\d{1,2})['\s]*([EW])$/);
  if (!m) return null;
  return { ns: m[1], deg: Number(m[2]), min: Number(m[3]), ew: m[4] };
}

function bearingsMatch(computedText, formText, tolMin = 2) {
  const a = parseBearing(computedText);
  const b = parseBearing(formText);
  if (!a || !b) return null; // not comparable (e.g. a due-cardinal line, or unreadable form text)
  if (a.ns !== b.ns || a.ew !== b.ew) return false;
  const diff = Math.abs((a.deg * 60 + a.min) - (b.deg * 60 + b.min));
  return diff <= tolMin;
}

function distanceMatch(computed, formValue, tol = 0.05) {
  const b = Number(formValue);
  if (!isFinite(b)) return null;
  const rel = Math.max(tol, computed * 0.002);
  return Math.abs(computed - b) <= rel;
}

// Combined per-row status used by both the corner table and the bearing/distance
// check table, so the two never disagree. A manual override always wins:
// 'approved' forces a green match, 'rejected' forces a flagged mismatch.
// With no override, falls back to the automatic bearing+distance comparison.
// Returns true (matched) / false (not matched) / null (nothing to compare against).
function rowMatchStatus(line, cornerRow) {
  if (!line || !cornerRow) return null;
  if (cornerRow.override === 'approved') return true;
  if (cornerRow.override === 'rejected') return false;
  const bMatch = bearingsMatch(line.bearingText, cornerRow.bearingText);
  const dMatch = distanceMatch(line.M, cornerRow.distance);
  if (bMatch === false || dMatch === false) return false;
  if (bMatch === null && dMatch === null) return null;
  return true;
}

function fmt(n, d = 2) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/* ============================================================================
   IMAGE HANDLING
   ========================================================================== */

function resizeImageFile(file, maxDim = 2000, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('Could not decode that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================================
   AI EXTRACTION
   Two separate calls (header vs. corner table) so a lot with many corners
   never risks the corner table getting cut off by the token limit.
   ========================================================================== */

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

async function callClaudeVision(prompt, base64, mediaType, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        // 529 = overloaded, 503 = unavailable — worth retrying
        if ((res.status === 529 || res.status === 503 || res.status === 529) && attempt < retries) {
          lastErr = new Error(`API temporarily unavailable (${res.status}) — retrying…`);
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        // Surface the real status and snippet of the response body so it's diagnosable
        const snippet = t.slice(0, 300);
        throw new Error(`API returned ${res.status}${snippet ? ': ' + snippet : ''}. Check that the artifact has API access.`);
      }
      const data = await res.json();
      const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!raw) throw new Error('API returned an empty response. The image may be too large or the model is busy — try again.');
      return raw;
    } catch (e) {
      lastErr = e;
      if (attempt < retries && (e.message?.includes('fetch') || e.message?.includes('network') || e.message?.includes('NetworkError'))) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const HEADER_PROMPT = `You are an expert geodetic engineer, cadastral data specialist, and optical character recognition (OCR) auditor.
Analyze this scanned Philippine Bureau of Lands (B.L.) Form No. 1000-V-9-A "Lot Data Computation" document with extreme precision. Historical survey sheets contain handwritten numbers, dense columns, faint typewriter text, and hand corrections — follow this strict extraction and validation protocol.
Extract ONLY the header metadata and the tie-point row (not the numbered corner rows).
Respond with ONLY compact JSON, no markdown fences, no explanation, matching exactly this shape:
{"formType":"","lotNo":"","sheetNo":"","owner":"","address":"","barangay":"","cadSurveyNo":"","quadrangle":"","barrio":"","munCity":"","island":"","geodeticEngr":"","dateSurveyed":"","survSymNo":"","lrcNo":"","surveyNumber":"","declaredArea":null,"tieLabel":"","tieN":null,"tieE":null,"tieBearing":"","tieDistance":null,"notes":""}
### 1. Header Information Extraction — field locations (they are always in these positions):
- "formType": TOP LEFT edge, the small printed form identifier (e.g. "B.L. FORM NO. 1000-V-9-A (67)"). Extract as printed.
- "lotNo": TOP RIGHT of the form, the number printed directly above the printed label "LOT NO.". It sits to the LEFT of the small "SHT." number — take the LOT NO. value, never the SHT. value. Digits only, e.g. "7936".
- "sheetNo": the small number above the printed label "SHT." at the far top right, immediately right of LOT NO. Usually a single digit like "1".
- "owner": TOP LEFT of the form, the text printed directly above the printed label "NAME OF CLAIMANT". It may be a person's name (e.g. "Mendoza Gemina") or a government/institutional claimant (e.g. "MUN. GOVT. OF PLACER") — extract it exactly as printed either way. Do NOT confuse it with "CONTRACTOR OR GEO. ENGR." (the surveyor, printed in the top middle) or with "ADDRESS OF CLAIMANT" (printed just below it).
- "address": the line above the printed label "ADDRESS OF CLAIMANT", just below the claimant name, exactly as printed (e.g. "POBLACION PLACER MASBATE").
- "barangay": the barangay/barrio part of the claimant's address — its FIRST locality word(s), before the municipality and province (e.g. from "POBLACION PLACER MASBATE" the barangay is "Poblacion"). Return in Title Case. If the address is unreadable, "".
- "munCity": the municipality or city part of the claimant's address — the locality word AFTER the barangay and before the province (e.g. from "POBLACION PLACER MASBATE" the municipality is "Placer"). Return in Title Case. If unreadable, "".
- "quadrangle": the latitude/longitude quadrangle values printed around "CM ... N ... E" above the printed label "QUADRANGLE" (top middle-right). Extract the full string as printed, e.g. "CM 11-52N 123-55E SEC.4-A".
- "surveyNumber": the value above the printed label "SURVEY NUMBER", at the far top right below LOT NO./SHT. For lots in Placer, Masbate this is essentially always "CAD-553-D" (it may appear as "CAD.553-D", "CAD. 553-D", sometimes with a suffix like "C-34"). Normalize it to "CAD-553-D" unless the form clearly shows a different cadastral number.
- "dateSurveyed": the MO/DAY/YR boxes near the top middle, above "DATE SURVEYED". Return exactly as printed (e.g. "03-23-87").
- "geodeticEngr": the name above "CONTRACTOR OR GEO. ENGR." in the top middle.
### 2. Tie point row:
- The tie point is the row whose CORNER NO. reads "TP-1" (its TRAVERSE STA. OCC. is usually "BLLM 1" or similar). It is the reference monument the survey ties to, NOT a lot corner.
- "tieLabel" is the station name (e.g. "BLLM 1"); "tieN"/"tieE" are that row's LOT CORNER COORDINATES Northing/Easting; "tieBearing"/"tieDistance" are that row's LOT BOUNDARY LINE bearing and distance (the tie line running from the tie point to corner 1).
- CRITICAL TIE POINT DIGIT CHECK: The TP-1 Easting is especially prone to 9→3 misreads because it sits alone above the numbered corners, making the clustering sanity check harder. Cross-check it this way: (a) ALL Easting values on the same form should agree in their first 5 significant digits (e.g. if corners read 599xxx, the TP-1 Easting must also start with 599, never 539 or 539). (b) Use the tieBearing and tieBearingDistance to independently verify: compute the expected Easting offset = tieDistance × sin(tieBearing) and check that the TP-1 Easting ± that offset lands on Corner 1's Easting within a few metres. If it does not, the TP-1 Easting likely contains a 9→3 substitution — re-read it.
- Normalize tieBearing exactly like "S87-03W": compass letter, degrees, hyphen, minutes, compass letter, no spaces, no degree symbols. Use "" if unreadable.
### 3. Validation protocol:
- Return every text field in UPPERCASE, matching how these forms are actually typed (e.g. "MENDOZA GEMINA", "POBLACION PLACER MASBATE") — except tieBearing, which keeps its own compass-letter format (already uppercase by construction).
- Use "" for text you cannot find, and null for numbers you cannot find. Never invent, infer, or "correct" a value that isn't legible — an empty field is better than a guessed one.
- declaredArea, tieN, tieE, tieDistance are plain decimal numbers (no commas, no units, no letters).
- Where a figure has been struck through and handwritten over (common for AREA), the handwritten correction is the final value — use it and say so briefly in "notes" (under 200 characters). If nothing is uncertain, "notes" can be "".
- Cross-check digits that are easily confused in typewriter/carbon copies: 9/3 (the most common error on these forms — a 9 has a closed top loop, a 3 has two open bowls), 1/7, 3/8, 5/6, 0/8. If a digit is genuinely ambiguous, mention which field in "notes".`;

const CORNERS_PROMPT = `You are an expert geodetic engineer, cadastral data specialist, and optical character recognition (OCR) auditor reading the "LOT CORNER COORDINATES" and "LOT BOUNDARY LINE" columns of the corner table on a scanned Philippine Bureau of Lands "Lot Data Computation" form.
Extract EVERY numbered corner row, in the exact order they appear top to bottom. Do NOT include the tie-point row (the one whose CORNER NO. reads "TP-1") — that row is handled separately.
Respond with ONLY compact JSON, no markdown fences, no explanation, matching exactly this shape:
{"corners":[[cornerNo, northing, easting, "bearingText", distance, "cornerDesc"], ...]}
Rules:
- northing, easting come from the LOT CORNER COORDINATES columns, as plain decimal numbers.
- bearingText comes from the LOT BOUNDARY LINE "BEARING" column, normalized EXACTLY like "S85-07W" or "N24-01W": compass letter, degrees, hyphen, minutes, compass letter, no spaces, no degree symbols. If unreadable, use "".
- distance comes from the LOT BOUNDARY LINE "DISTANCE" column as a plain decimal number. If unreadable, use null.
- cornerDesc is the CORNER DESC. column text (e.g. "OLD COR", "PS MON"), or "" if blank.
- Include a row for every corner even if some of its cells are unclear (use null/"" for those cells only) — never skip a whole row.
- Keep the JSON compact (no extra whitespace) since the table can be long.
CRITICAL DIGIT CHECK — 9 vs 3: on these faint typewriter carbon copies the digit "9" is very frequently misread as "3". Before finalizing each coordinate, re-examine every "3" you read: a 9 has ONE closed loop at the top with a straight tail; a 3 has TWO open right-facing bowls and no closed loop. Coordinates on one sheet cluster tightly (Northings within a few hundred meters of each other, likewise Eastings) — if a digit choice makes a value jump far from its neighbors (e.g. 1312332 among 1313xxx values), re-read it, since the 9 reading (1312932) is usually the correct one. This clustering sanity check applies to both Northing AND Easting: if all corner Eastings start with 599xxx, then any value starting with 539xxx almost certainly has a 9→3 substitution in the second digit. Also cross-check 1/7, 5/6, and 0/8 the same way.`;

function repairCornersJSON(raw) {
  const cleaned = stripFences(raw);
  const m = cleaned.match(/"corners"\s*:\s*\[([\s\S]*)/);
  if (!m) throw new Error('No corners field found in the response.');
  const body = m[1];
  let depth = 0, lastGood = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '[') depth++;
    else if (body[i] === ']') { depth--; if (depth === 0) lastGood = i; }
  }
  if (lastGood === -1) throw new Error('No complete corner rows found.');
  const rows = JSON.parse('[' + body.slice(0, lastGood + 1) + ']');
  return { corners: rows };
}

async function runExtraction(base64, mediaType) {
  // Run header first, then corners sequentially — so a transient failure on one
  // doesn't mask the other, and the real API error reaches the user.
  let headerRaw;
  try {
    headerRaw = await callClaudeVision(HEADER_PROMPT, base64, mediaType);
  } catch (e) {
    throw new Error(`Header extraction failed: ${e.message}`);
  }

  let cornersRaw;
  try {
    cornersRaw = await callClaudeVision(CORNERS_PROMPT, base64, mediaType);
  } catch (e) {
    throw new Error(`Corner table extraction failed: ${e.message}`);
  }

  let headerJson;
  try {
    headerJson = JSON.parse(stripFences(headerRaw));
  } catch (e) {
    // The raw response wasn't valid JSON — surface what came back so it's diagnosable
    const preview = headerRaw ? headerRaw.slice(0, 200) : '(empty)';
    throw new Error(`The AI returned an unexpected response for the header fields — the image may be too small, blurry, or not a Lot Data Computation form. Response preview: ${preview}`);
  }

  let cornersJson, repaired = false;
  try {
    cornersJson = JSON.parse(stripFences(cornersRaw));
  } catch (e) {
    try { cornersJson = repairCornersJSON(cornersRaw); repaired = true; }
    catch (e2) {
      const preview = cornersRaw ? cornersRaw.slice(0, 200) : '(empty)';
      throw new Error(`Could not read the corner table. Try a clearer or closer photo of the table. Response preview: ${preview}`);
    }
  }

  const corners = (cornersJson.corners || []).map((row) => ({
    n: row[1] ?? '', e: row[2] ?? '', bearingText: row[3] || '', distance: row[4] ?? '', cornerDesc: row[5] || '', override: null,
  }));

  return { header: headerJson, corners, repaired };
}

/* ============================================================================
   PERSISTENT STORAGE — lot records, keyed as Barangay_Section_LotNo
   ========================================================================== */

function sanitizeKey(s) {
  return (s || '').toString().trim().replace(/[^a-zA-Z0-9\-_.]/g, '_').slice(0, 50) || '_';
}

function recordKey(barangay, section, lotNo) {
  return `lot:${sanitizeKey(barangay)}:${sanitizeKey(section)}:${sanitizeKey(lotNo)}`;
}

function filenameStem(barangay, section, lotNo) {
  const b = String(barangay ?? '').trim() ? sanitizeKey(barangay) : 'Barangay';
  const s = String(section ?? '').trim() ? sanitizeKey(section) : 'Section';
  const l = String(lotNo ?? '').trim() ? sanitizeKey(lotNo) : 'Lot';
  return `${b}_${s}_${l}`;
}

// KML files follow the requested "Municipality_Barangay_Section_LotNumber.kml"
// pattern, keeping the explicit Lot_ prefix on the number.
function kmlFilename(municipality, barangay, section, lotNo) {
  const m = String(municipality ?? '').trim() ? sanitizeKey(municipality) : 'Municipality';
  const b = String(barangay ?? '').trim() ? sanitizeKey(barangay) : 'Barangay';
  const s = String(section ?? '').trim() ? sanitizeKey(section) : 'Section';
  const l = String(lotNo ?? '').trim() ? sanitizeKey(lotNo) : '0';
  return `${m}_${b}_${s}_LOT_${l}.kml`;
}

async function saveLotRecord(barangay, section, record, previousKey) {
  try {
    const lotNo = record.header?.lotNo || 'untitled';
    const key = recordKey(barangay, section, lotNo);
    await window.storage.set(key, JSON.stringify({ barangay, section, ...record, savedAt: Date.now() }), false);
    // If this save is an EDIT of an existing record and the identity fields
    // (barangay/section/lot no) changed, the new key differs from the old one —
    // without this, the old entry is orphaned and shows up as a duplicate lot.
    if (previousKey && previousKey !== key) {
      await deleteLotRecord(previousKey);
    }
    return key;
  } catch (e) { return null; }
}

async function listAllLotRecords() {
  try {
    const res = await window.storage.list('lot:', false);
    if (!res || !res.keys) return [];
    const out = [];
    for (const k of res.keys) {
      try {
        const r = await window.storage.get(k, false);
        if (r && r.value) out.push({ key: k, ...JSON.parse(r.value) });
      } catch (e) { /* skip corrupted */ }
    }
    // Sort by barangay then section then lotNo
    out.sort((a, b) => {
      const ba = (a.barangay || '').localeCompare(b.barangay || '');
      if (ba !== 0) return ba;
      const se = (a.section || '').localeCompare(b.section || '');
      if (se !== 0) return se;
      return (a.header?.lotNo || '').toString().localeCompare((b.header?.lotNo || '').toString(), undefined, { numeric: true });
    });
    return out;
  } catch (e) { return []; }
}

async function deleteLotRecord(key) {
  try {
    const r = await window.storage.get(key, false);
    if (r) await window.storage.delete(key, false);
  } catch (e) { /* ignore */ }
}

/* ============================================================================
   SMALL UI ATOMS
   ========================================================================== */

const gridBg = {
  backgroundImage:
    'linear-gradient(rgba(125,211,252,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(125,211,252,0.07) 1px, transparent 1px)',
  backgroundSize: '22px 22px',
};

function Field({ label, value, onChange, placeholder, mono }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-widest text-stone-500 mb-1">{label}</span>
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-transparent border-0 border-b border-stone-300 focus:border-amber-600 focus:outline-none focus:ring-0 text-stone-900 placeholder-stone-400 py-1 text-sm ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function MatchPill({ status }) {
  if (status === null) {
    return <span className="inline-flex items-center gap-1 text-[11px] text-stone-500">—</span>;
  }
  if (status) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400">
        <CheckCircle2 size={13} /> match
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-400">
      <XCircle size={13} /> check
    </span>
  );
}

// Compact traffic-light dot for the corner table, where a text pill won't fit.
function MatchDot({ status }) {
  const color = status === true ? 'bg-emerald-500' : status === false ? 'bg-rose-500' : 'bg-stone-300';
  const title = status === true ? 'Bearing/distance match the form' : status === false ? 'Does not match the form' : 'Nothing to compare yet';
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} title={title} />;
}

// X / check pair to manually force a row's match state, overriding the automatic
// comparison — for cases where the form reading was noisy but the person has
// visually confirmed the corner is fine (or flagged one that isn't).
function OverrideButtons({ value, onSet }) {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => onSet(value === 'rejected' ? null : 'rejected')}
        title="Mark as not matched (needs correction)"
        className={`rounded-sm p-0.5 transition-colors ${value === 'rejected' ? 'bg-rose-100 text-rose-600' : 'text-stone-300 hover:text-rose-500'}`}
      >
        <X size={13} />
      </button>
      <button
        onClick={() => onSet(value === 'approved' ? null : 'approved')}
        title="Mark as checked and correct"
        className={`rounded-sm p-0.5 transition-colors ${value === 'approved' ? 'bg-emerald-100 text-emerald-600' : 'text-stone-300 hover:text-emerald-500'}`}
      >
        <Check size={13} />
      </button>
    </div>
  );
}

function SectionEyebrow({ children }) {
  return (
    <div className="flex items-center gap-2 text-cyan-400 mb-3">
      <span className="text-[11px] font-bold uppercase tracking-[0.2em]">{children}</span>
      <span className="h-px flex-1 bg-cyan-400/20" />
    </div>
  );
}

/* ============================================================================
   UPLOAD ZONE
   ========================================================================== */

function UploadZone({ onFile, busy, stepMsg, error }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false);
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={`relative rounded-sm border-2 border-dashed transition-colors ${dragOver ? 'border-amber-500 bg-amber-50' : 'border-stone-300 bg-stone-50'}`}
      style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 27px, rgba(120,113,108,0.08) 28px)' }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) onFile(f); }}
      />
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
        {busy ? (
          <>
            <Loader2 className="animate-spin text-amber-600" size={30} />
            <p className="text-sm font-medium text-stone-700">{stepMsg || 'Reading the form…'}</p>
            <p className="text-xs text-stone-500 max-w-xs">This takes 10–20 seconds. The header and corner table are read separately and re-tried automatically if the API is busy.</p>
          </>
        ) : (
          <>
            <div className="rounded-full bg-white border border-stone-300 p-3 shadow-sm">
              <ScanLine className="text-stone-500" size={22} />
            </div>
            <p className="text-sm font-medium text-stone-700">Drop a Lot Data Computation scan here</p>
            <p className="text-xs text-stone-500">or</p>
            <button
              onClick={() => inputRef.current && inputRef.current.click()}
              className="inline-flex items-center gap-2 rounded-sm bg-slate-900 text-stone-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide hover:bg-slate-800 transition-colors"
            >
              <UploadCloud size={14} /> Browse file
            </button>
          </>
        )}
        {error && (
          <div className="mt-2 flex flex-col items-start gap-2 text-rose-700 bg-rose-50 border border-rose-200 rounded-sm px-3 py-2 text-xs max-w-md text-left w-full">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => inputRef.current && inputRef.current.click()}
              className="inline-flex items-center gap-1.5 rounded-sm bg-rose-700 text-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide hover:bg-rose-600 transition-colors"
            >
              <UploadCloud size={12} /> Try again with the same or a different image
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   CORNER TABLE (editable)
   ========================================================================== */

function CornerTable({ corners, setCorners, result, tiePoint, setTiePoint, onAddSheet, addingSheet, addSheetError }) {
  const sheetInputRef = useRef(null);
  const update = (idx, key, val) => {
    setCorners((prev) => prev.map((c, i) => (i === idx ? { ...c, [key]: val } : c)));
  };
  const remove = (idx) => setCorners((prev) => prev.filter((_, i) => i !== idx));
  const add = () => setCorners((prev) => [...prev, { n: '', e: '', bearingText: '', distance: '', cornerDesc: '', override: null }]);

  // The tie line runs from TP-1 to corner 1. It's checkable against the form the
  // same way boundary lines are, but it is NOT part of the polygon — including it
  // would corrupt the area, so it is computed separately here.
  const tieLine = useMemo(() => {
    const tn = Number(tiePoint?.n), te = Number(tiePoint?.e);
    const c1 = corners[0];
    const cn = Number(c1?.n), ce = Number(c1?.e);
    if (![tn, te, cn, ce].every(Number.isFinite)) return null;
    return computeLine({ n: tn, e: te }, { n: cn, e: ce });
  }, [tiePoint?.n, tiePoint?.e, corners[0]?.n, corners[0]?.e]);

  const tieStatus = rowMatchStatus(tieLine, tiePoint);

  // Detect likely 9→3 substitution in the TP-1 Easting: compare its leading prefix
  // to the median of the corner Eastings. If the TP-1 Easting's thousands digit
  // differs by ~60000 (i.e. 599xxx vs 539xxx) it almost certainly has the digit wrong.
  const tpEastingWarn = useMemo(() => {
    const te = Number(tiePoint?.e);
    if (!Number.isFinite(te) || !corners.length) return null;
    const cornerEastings = corners.map((c) => Number(c.e)).filter(Number.isFinite);
    if (!cornerEastings.length) return null;
    const medianE = cornerEastings.slice().sort((a, b) => a - b)[Math.floor(cornerEastings.length / 2)];
    const diff = Math.abs(te - medianE);
    // A 9→3 swap in the second digit (e.g. 599→539) shifts by ~60000; flag any diff > 5000
    if (diff > 5000) {
      const suggested = Math.round((te + diff) * 1000) / 1000; // most likely correct value
      return `TP-1 EASTING (${te}) IS ${diff.toFixed(0)} M FROM THE CORNER EASTINGS (${medianE.toFixed(0)}). LIKELY 9→3 DIGIT MISREAD — SHOULD THIS BE ${suggested}?`;
    }
    return null;
  }, [tiePoint?.e, corners]);

  return (
    <div>
      <div className="overflow-x-auto border border-stone-300 rounded-sm">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-stone-200/70 text-stone-600 uppercase tracking-wide text-[10px]">
              <th className="px-2 py-2 text-left w-14">#</th>
              <th className="px-2 py-2 text-left">NORTHING</th>
              <th className="px-2 py-2 text-left">EASTING</th>
              <th className="px-2 py-2 text-left w-24">BEARING</th>
              <th className="px-2 py-2 text-left w-20">DISTANCE</th>
              <th className="px-2 py-2 text-center w-16">MATCHED</th>
              <th className="px-2 py-2 text-center w-14">CHECKED</th>
              <th className="px-2 py-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {/* Tie point — reference monument the survey ties to, not a lot corner */}
            <tr className="border-t border-stone-200 bg-amber-50/70">
              <td className="px-2 py-1.5 font-mono font-semibold text-amber-800" title={tiePoint?.label || 'Tie point'}>TP-1</td>
              <td className="px-1 py-1">
                <input value={tiePoint?.n ?? ''} onChange={(e) => setTiePoint({ ...tiePoint, n: e.target.value })} inputMode="decimal"
                  placeholder="not read"
                  className="w-28 font-mono text-xs text-stone-900 bg-transparent border-0 border-b border-transparent hover:border-amber-300 focus:border-amber-600 focus:outline-none py-0.5 placeholder-stone-400" />
              </td>
              <td className="px-1 py-1">
                <div className="flex items-start gap-1">
                  <input value={tiePoint?.e ?? ''} onChange={(e) => setTiePoint({ ...tiePoint, e: e.target.value })} inputMode="decimal"
                    placeholder="not read"
                    className={`w-28 font-mono text-xs text-stone-900 bg-transparent border-0 border-b focus:outline-none py-0.5 placeholder-stone-400 ${tpEastingWarn ? 'border-rose-500 text-rose-700 font-semibold' : 'border-transparent hover:border-amber-300 focus:border-amber-600'}`} />
                  {tpEastingWarn && (
                    <span title={tpEastingWarn} className="text-rose-600 cursor-help shrink-0 mt-0.5">
                      <AlertTriangle size={13} />
                    </span>
                  )}
                </div>
                {tpEastingWarn && (
                  <div className="mt-1 text-[10px] text-rose-700 font-semibold max-w-xs leading-tight">{tpEastingWarn}</div>
                )}
              </td>
              <td className="px-2 py-1 font-mono text-[11px] text-amber-800">{tieLine ? tieLine.bearingText : '—'}</td>
              <td className="px-2 py-1 font-mono text-[11px] text-amber-800">{tieLine ? fmt(tieLine.M) : '—'}</td>
              <td className="px-1 py-1 text-center"><MatchDot status={tieStatus} /></td>
              <td className="px-1 py-1 text-center">
                <OverrideButtons value={tiePoint?.override ?? null} onSet={(v) => setTiePoint({ ...tiePoint, override: v })} />
              </td>
              <td className="px-1 py-1" />
            </tr>
            {corners.map((c, i) => {
              const status = rowMatchStatus(result?.lines?.[i], c);
              return (
                <tr key={i} className="border-t border-stone-200 bg-white/60">
                  <td className="px-2 py-1.5 text-stone-500 font-mono">{i + 1}</td>
                  <td className="px-1 py-1">
                    <input value={c.n} onChange={(e) => update(i, 'n', e.target.value)} inputMode="decimal"
                      className="w-28 font-mono text-xs text-stone-900 bg-transparent border-0 border-b border-transparent hover:border-stone-300 focus:border-amber-600 focus:outline-none py-0.5" />
                  </td>
                  <td className="px-1 py-1">
                    <input value={c.e} onChange={(e) => update(i, 'e', e.target.value)} inputMode="decimal"
                      className="w-28 font-mono text-xs text-stone-900 bg-transparent border-0 border-b border-transparent hover:border-stone-300 focus:border-amber-600 focus:outline-none py-0.5" />
                  </td>
                  <td className="px-2 py-1 font-mono text-[11px] text-stone-600">{result?.lines?.[i] ? result.lines[i].bearingText : '—'}</td>
                  <td className="px-2 py-1 font-mono text-[11px] text-stone-600">{result?.lines?.[i] ? fmt(result.lines[i].M) : '—'}</td>
                  <td className="px-1 py-1 text-center">
                    <MatchDot status={status} />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <OverrideButtons value={c.override ?? null} onSet={(v) => update(i, 'override', v)} />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <button onClick={() => remove(i)} className="text-stone-400 hover:text-rose-600 transition-colors" title="Remove corner">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <button onClick={add} className="inline-flex items-center gap-1 text-xs font-medium text-stone-600 hover:text-amber-700 transition-colors">
          <Plus size={13} /> Add corner
        </button>
        <input
          ref={sheetInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f && onAddSheet) onAddSheet(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => sheetInputRef.current && sheetInputRef.current.click()}
          disabled={addingSheet}
          className="inline-flex items-center gap-1 text-xs font-medium text-stone-600 hover:text-amber-700 disabled:opacity-60 transition-colors"
          title="Scan or upload sheet 2 (or 3...) of this lot — its corner rows are appended below"
        >
          {addingSheet ? <Loader2 size={13} className="animate-spin" /> : <ScanLine size={13} />}
          {addingSheet ? 'Reading sheet…' : 'Add another sheet'}
        </button>
        {addSheetError && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-700">
            <AlertTriangle size={12} /> {addSheetError}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-stone-500">
        <span className="text-amber-700 font-medium">TP-1</span> ({tiePoint?.label || 'tie point'}) is the reference monument the survey ties to — it's checked against the form's tie line but is not part of the lot boundary, so it's excluded from the area and the AutoCAD points.
        Corners 1–{corners.length} are the boundary walk order. Use ✕ / ✓ to mark a row as checked — ✓ means you've verified and corrected it by eye, ✕ flags it as still not matching.
      </p>
    </div>
  );
}

/* ============================================================================
   RESULTS
   ========================================================================== */

function AreaCard({ declaredArea, computedArea }) {
  const declared = Number(declaredArea);
  const hasDeclared = isFinite(declared) && declaredArea !== '' && declaredArea !== null;
  const diff = hasDeclared ? computedArea - declared : null;
  const pct = hasDeclared && declared !== 0 ? (diff / declared) * 100 : null;
  const ok = hasDeclared ? Math.abs(diff) <= Math.max(1, declared * 0.005) : null;

  return (
    <div className="rounded-sm border border-slate-700 bg-slate-900 p-4">
      <SectionEyebrow>Area check</SectionEyebrow>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Computed</div>
          <div className="font-mono text-lg text-stone-100">{fmt(computedArea)} <span className="text-xs text-slate-500">sq.m</span></div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Declared (form)</div>
          <div className="font-mono text-lg text-stone-100">{hasDeclared ? `${fmt(declared)}` : '—'} <span className="text-xs text-slate-500">sq.m</span></div>
        </div>
      </div>
      {hasDeclared && (
        <div className="mt-3 pt-3 border-t border-slate-700 flex items-center justify-between">
          <span className="text-xs text-slate-400">diff {diff >= 0 ? '+' : ''}{fmt(diff)} sq.m ({pct >= 0 ? '+' : ''}{fmt(pct, 2)}%)</span>
          <MatchPill status={ok} />
        </div>
      )}
    </div>
  );
}

function AccuracyCard({ result }) {
  return (
    <div className="rounded-sm border border-slate-700 bg-slate-900 p-4">
      <SectionEyebrow>Accuracy</SectionEyebrow>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">L.E.C.</div>
          <div className="font-mono text-stone-100">{fmt(result.LEC, 4)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">R.E.C.</div>
          <div className="font-mono text-stone-100">{fmt(result.REC, 1)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Ratio</div>
          <div className="font-mono text-amber-400">1 : {result.ACC ?? '—'}</div>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-slate-700 text-xs text-slate-400">
        Total perimeter <span className="font-mono text-slate-300">{fmt(result.M40)} m</span> across {result.lines.length} lines
      </div>
    </div>
  );
}

function BearingDistanceTable({ result, corners }) {
  return (
    <div className="rounded-sm border border-slate-700 bg-slate-900 p-4">
      <SectionEyebrow>Bearing &amp; distance check</SectionEyebrow>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="text-slate-500 uppercase tracking-wide text-[10px]">
              <th className="px-2 py-1.5 text-left">Line</th>
              <th className="px-2 py-1.5 text-left">Computed bearing</th>
              <th className="px-2 py-1.5 text-left">Form bearing</th>
              <th className="px-2 py-1.5 text-left">Computed dist.</th>
              <th className="px-2 py-1.5 text-left">Form dist.</th>
              <th className="px-2 py-1.5 text-left">Result</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((l, i) => {
              const overall = rowMatchStatus(l, corners[i]);
              return (
                <tr key={i} className="border-t border-slate-800">
                  <td className="px-2 py-1.5 text-slate-500 font-mono">{l.from}→{l.to}</td>
                  <td className="px-2 py-1.5 font-mono text-cyan-300">{l.bearingText}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-300">{corners[i]?.bearingText || '—'}</td>
                  <td className="px-2 py-1.5 font-mono text-cyan-300">{fmt(l.M)}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-300">{corners[i]?.distance !== '' && corners[i]?.distance !== undefined ? fmt(Number(corners[i].distance)) : '—'}</td>
                  <td className="px-2 py-1.5"><MatchPill status={overall} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function APOutput({ result }) {
  const [copied, setCopied] = useState(false);
  // Column AP in the real workbook starts one row above the first corner with the
  // literal value "PL" (row 41), then D&","&C per corner from row 42 down — so
  // copying that whole range pastes the command AND every point in one paste.
  const text = ['PL', ...result.lines.map((l) => l.apLine)].join('\n');

  const copy = async () => {
    const ok = await writeClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      // last resort: select the block so a manual Ctrl+C works
      const el = document.getElementById('ap-output-block');
      if (el && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  return (
    <div className="rounded-sm border border-cyan-900/60 bg-black overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-cyan-900/60">
        <div className="flex items-center gap-2 text-cyan-300">
          <Compass size={14} />
          <span className="text-[11px] font-bold uppercase tracking-[0.2em]">AutoCAD points · Column AP</span>
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-sm bg-amber-600 hover:bg-amber-500 text-black text-xs font-semibold px-3 py-1.5 transition-colors"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre id="ap-output-block" className="px-4 py-3 text-cyan-300 font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre">
        <span className="select-none text-slate-600">00 › </span><span className="text-amber-400">PL</span>{'\n'}
        {result.lines.map((l, i) => (
          <React.Fragment key={i}>
            <span className="select-none text-slate-600">{String(i + 1).padStart(2, '0')} › </span>{l.apLine}{i < result.lines.length - 1 ? '\n' : ''}
          </React.Fragment>
        ))}
      </pre>
      <div className="px-4 pb-3 text-[11px] text-slate-500">
        <span className="text-amber-400 font-mono">PL</span> is the first line — with the AutoCAD command line focused, paste the whole block in one go and it starts the polyline and enters every point. Type <span className="font-mono text-slate-400">C</span> afterward to close it.
      </div>
    </div>
  );
}

/* ---- ZoneMap: proper multi-island Philippines silhouette + zone coverage ---- */
const ZONE_EXTENTS = {
  'PRS92-1':  [116.04,  6.21, 118.00, 18.64],
  'PRS92-2':  [118.00,  3.02, 120.07, 20.42],
  'PRS92-3':  [119.70,  3.00, 122.21, 21.62],
  'PRS92-4':  [121.74,  3.44, 124.29, 22.18],
  'PRS92-5':  [123.73,  4.76, 126.65, 21.97],
  'LUZON-I':  [116.04,  6.21, 118.00, 18.64],
  'LUZON-II': [118.00,  3.02, 120.07, 20.42],
  'LUZON-III':[119.70,  3.00, 122.21, 21.62],
  'LUZON-IV': [121.74,  3.44, 124.29, 22.18],
  'LUZON-V':  [123.73,  4.76, 126.65, 21.97],
};
// Viewport: lon 115-128, lat 2-22.5 → 260×420 SVG units
const GEO = { minLon: 115, maxLon: 128, minLat: 2, maxLat: 22.5 };
const VW = 260, VH = 420;
function geoToSVG(lon, lat) {
  const x = ((lon - GEO.minLon) / (GEO.maxLon - GEO.minLon)) * VW;
  const y = ((GEO.maxLat - lat) / (GEO.maxLat - GEO.minLat)) * VH;
  return [x, y];
}
// Simplified coastline data for each major island group, traced from real outlines
// at thumbnail scale — enough to read as the actual shape of the Philippines.
const PH_ISLANDS = {
  luzon: [[121.97,20.45],[122.35,18.40],[122.10,17.60],[122.20,16.80],[122.10,16.00],[121.50,15.80],[121.60,15.00],[121.80,14.80],[121.50,14.30],[121.20,14.00],[120.80,14.00],[120.30,13.80],[120.00,14.20],[119.80,14.50],[120.10,14.90],[120.00,15.50],[119.80,16.20],[120.00,17.00],[120.20,17.80],[120.40,18.20],[120.70,18.50],[121.30,18.80],[121.60,19.60],[121.90,20.00]],
  mindanao: [[122.05,7.00],[122.30,7.60],[122.80,7.80],[123.30,7.40],[124.00,7.80],[124.50,7.60],[125.30,7.40],[126.00,7.50],[126.60,8.00],[126.60,8.70],[125.90,8.80],[126.10,9.40],[125.70,9.70],[125.30,9.60],[125.50,8.80],[125.10,8.60],[124.50,8.80],[124.00,8.80],[123.50,8.60],[123.00,8.30],[122.80,8.00],[122.50,7.80],[122.20,7.50],[122.00,7.20],[122.00,6.90]],
  samarLeyte: [[124.10,12.00],[124.50,11.80],[125.00,11.60],[125.20,11.20],[125.00,10.80],[124.80,10.50],[125.00,10.20],[125.30,9.80],[124.80,9.60],[124.30,9.70],[123.80,10.00],[123.30,10.40],[123.50,11.20],[124.00,11.60]],
  cebuBohol: [[124.00,10.60],[124.30,10.40],[124.30,10.00],[124.00,9.70],[123.70,9.80],[123.40,10.10],[123.60,10.40]],
  negros: [[122.60,11.00],[122.80,10.80],[123.20,10.60],[123.40,10.20],[123.20,9.80],[122.90,9.60],[122.70,9.80],[122.50,10.00],[122.40,10.40]],
  panay: [[121.80,11.80],[122.20,11.60],[122.60,11.20],[122.30,10.80],[122.00,10.50],[121.60,10.60],[121.40,11.00],[121.60,11.50]],
  palawan: [[120.10,11.60],[119.70,11.20],[119.40,10.80],[119.20,10.20],[119.00,9.80],[118.80,9.50],[118.50,9.20],[118.30,8.90],[117.90,8.50],[117.70,8.10],[117.50,8.30],[117.80,8.70],[118.10,9.00],[118.40,9.50],[118.70,9.90],[119.10,10.40],[119.50,10.80],[119.80,11.30]],
  mindoro: [[121.00,13.50],[121.30,13.20],[121.60,12.80],[121.50,12.40],[121.20,12.20],[120.80,12.20],[120.60,12.60],[120.80,13.10]],
  sulu: [[120.50,6.10],[121.00,6.00],[121.50,6.00],[122.00,6.20],[122.00,6.50],[121.50,6.40],[121.00,6.30],[120.50,6.40]],
  basilan: [[121.90,6.55],[122.30,6.45],[122.50,6.65],[122.20,6.80],[121.90,6.75]],
};
// Convert a list of [lon,lat] pairs to an SVG points string
function islandPoints(coords) {
  return coords.map(([lon, lat]) => {
    const [x, y] = geoToSVG(lon, lat);
    return `${Math.round(x)},${Math.round(y)}`;
  }).join(' ');
}

function ZoneMap({ activeZone }) {
  const ext = ZONE_EXTENTS[activeZone];
  if (!ext) return null;
  const [x1, y1] = geoToSVG(ext[0], ext[3]); // minLon, maxLat → top-left
  const [x2, y2] = geoToSVG(ext[2], ext[1]); // maxLon, minLat → bottom-right
  const cmZone = PH_ZONES[activeZone];
  const [cmX] = geoToSVG(cmZone?.cm ?? 120, 12);
  return (
    <svg
      viewBox={`0 0 ${VW} ${VH}`}
      width={130}
      height={210}
      className="rounded-sm border border-slate-600"
      style={{ background: '#0c1524' }}
      aria-label={`Zone coverage map — ${cmZone?.label ?? activeZone}`}
    >
      {/* Sea background */}
      <rect x={0} y={0} width={VW} height={VH} fill="#0c1524" />
      {/* Zone highlight rectangle */}
      <rect x={x1} y={y1} width={Math.max(2, x2 - x1)} height={Math.max(2, y2 - y1)}
        fill="rgba(251,191,36,0.18)" stroke="#f59e0b" strokeWidth={1.5} />
      {/* Central meridian dashed line */}
      <line x1={cmX} y1={0} x2={cmX} y2={VH}
        stroke="#f59e0b" strokeWidth={1} strokeDasharray="5 3" opacity={0.65} />
      {/* Island silhouettes */}
      {Object.entries(PH_ISLANDS).map(([name, coords]) => (
        <polygon key={name} points={islandPoints(coords)}
          fill="#334155" stroke="#64748b" strokeWidth={0.7}
          strokeLinejoin="round" />
      ))}
      {/* BOHOL separate small blob */}
      <circle cx={Math.round(geoToSVG(124.15,9.85)[0])} cy={Math.round(geoToSVG(124.15,9.85)[1])} r={4}
        fill="#334155" stroke="#64748b" strokeWidth={0.7} />
      {/* Masbate small blob */}
      <circle cx={Math.round(geoToSVG(123.60,12.20)[0])} cy={Math.round(geoToSVG(123.60,12.20)[1])} r={3}
        fill="#334155" stroke="#64748b" strokeWidth={0.7} />
      {/* Batanes (northernmost) small dots */}
      <circle cx={Math.round(geoToSVG(121.97,20.45)[0])} cy={Math.round(geoToSVG(121.97,20.45)[1])} r={3}
        fill="#334155" stroke="#64748b" strokeWidth={0.7} />
    </svg>
  );
}

function EarthOutput({ result, corners, header, zone, setZone, municipality, barangay, section }) {
  const [copied, setCopied] = useState(false);
  const [conversionError, setConversionError] = useState(null);
  const [hoverZone, setHoverZone] = useState(null); // preview the hovered zone on the map

  const points = useMemo(() => {
    try {
      setConversionError(null);
      return corners
        .map((c) => ({ n: Number(c.n), e: Number(c.e) }))
        .filter((c) => Number.isFinite(c.n) && Number.isFinite(c.e))
        .map((c) => gridToWGS84(c.e, c.n, zone));
    } catch (e) {
      setConversionError('Could not convert these coordinates.');
      return [];
    }
  }, [corners, zone]);

  if (!points.length) return null;

  const centroid = {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  };
  const centroidText = `${centroid.lat.toFixed(6)}, ${centroid.lon.toFixed(6)}`;

  const copyCentroid = async () => {
    const ok = await writeClipboard(centroidText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const download = () => {
    const title = `Lot ${header.lotNo || 'Untitled'}`;
    // Use the DECLARED area from the form in the KML description; fall back to
    // the computed area only when the form's declared figure is missing.
    const declared = Number(header.declaredArea);
    const areaText = String(header.declaredArea ?? '').trim() !== '' && Number.isFinite(declared)
      ? `${fmt(declared)} sq.m (declared)`
      : (result ? `${fmt(result.area)} sq.m (computed)` : null);
    const desc = [header.owner, areaText].filter(Boolean).join(' \u00b7 ');
    const kml = buildKML(points, title, desc, header.lotNo);
    // Naming convention: Municipality_Barangay_Section_Lot_#.kml
    downloadTextFile(kml, kmlFilename(municipality, barangay, section, header.lotNo), 'application/vnd.google-earth.kml+xml');
  };

  return (
    <div className="rounded-sm border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <SectionEyebrow>Google Earth placement</SectionEyebrow>
      </div>

      <div className="flex flex-wrap items-start gap-4 mb-3">
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Coordinate system</span>
          <select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            onMouseLeave={() => setHoverZone(null)}
            className="bg-slate-800 border border-slate-600 rounded-sm text-xs text-stone-100 px-2 py-1.5 focus:outline-none focus:border-amber-500"
          >
            <optgroup label="PRS92 (current standard)">
              {Object.entries(PH_ZONES).filter(([k]) => k.startsWith('PRS92')).map(([key, z]) => (
                <option key={key} value={key}
                  onMouseEnter={() => setHoverZone(key)}
                >{z.label} · CM {z.cm}°E ({z.hint})</option>
              ))}
            </optgroup>
            <optgroup label="Luzon 1911 (older datum)">
              {Object.entries(PH_ZONES).filter(([k]) => k.startsWith('LUZON')).map(([key, z]) => (
                <option key={key} value={key}
                  onMouseEnter={() => setHoverZone(key)}
                >{z.label} · CM {z.cm}°E ({z.hint})</option>
              ))}
            </optgroup>
          </select>
        </label>
        <div className="flex flex-col items-start gap-1">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Zone coverage</span>
          <ZoneMap activeZone={hoverZone || zone} />
          <span className="text-[10px] text-slate-600">Hover an option to preview its region</span>
        </div>
        <div>
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Centroid (WGS84)</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-cyan-300">{centroidText}</span>
            <button onClick={copyCentroid} className="text-slate-400 hover:text-amber-400 transition-colors" title="Copy centroid">
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      </div>

      {conversionError && (
        <div className="flex items-start gap-2 text-rose-300 bg-rose-900/20 border border-rose-800/50 rounded-sm px-3 py-2 text-xs mb-3">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {conversionError}
        </div>
      )}

      <button
        onClick={download}
        className="inline-flex items-center gap-1.5 rounded-sm bg-amber-600 hover:bg-amber-500 text-black text-xs font-semibold px-3 py-1.5 transition-colors"
      >
        <Download size={13} /> Download boundary as .kml
      </button>
      <span className="ml-3 text-[11px] text-slate-500">saves as <span className="font-mono text-slate-300">{kmlFilename(municipality, barangay, section, header.lotNo)}</span></span>
      <p className="mt-2 text-[11px] text-slate-500">
        Open the file in Google Earth Pro (double-click it, or File → Open) or drag it into QGIS to drop the lot boundary in next to your existing barangay layer.
        1980s B.L. forms are computed on the Luzon 1911 datum, so Luzon 1911 zone IV is the correct pick for these sheets — choose PRS92 only if your coordinates were re-computed to PRS92. Good for placement on imagery, not survey-grade.
      </p>
    </div>
  );
}

/* ---- SavePanel: barangay/section input + save button + records browser ---- */
function LabelOutput({ result, header }) {
  const [copied, setCopied] = useState(false);
  const lotNo = String(header.lotNo || '').trim();
  // Text height scales with lot size so the label reads sensibly whether the
  // lot is a small residential parcel or a large institutional one — roughly
  // proportional to a "typical" linear dimension of the polygon.
  const height = Math.max(0.5, Math.round((Math.sqrt(result.area) / 10) * 100) / 100);
  const insertion = `${trimNum(result.centroid.e)},${trimNum(result.centroid.n)}`;
  // TEXT command sequence: command, insertion point, height, rotation, the
  // string itself, then a blank line — TEXT keeps prompting for another line
  // of text until it gets an empty Enter, which is what ends the command.
  const lines = ['TEXT', insertion, String(height), '0', lotNo || 'LOT', ''];
  const text = lines.join('\n');

  const copy = async () => {
    const ok = await writeClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      const el = document.getElementById('label-output-block');
      if (el && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  return (
    <div className="rounded-sm border border-cyan-900/60 bg-black overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-cyan-900/60">
        <div className="flex items-center gap-2 text-cyan-300">
          <Type size={14} />
          <span className="text-[11px] font-bold uppercase tracking-[0.2em]">Auto-text lot no.</span>
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-sm bg-amber-600 hover:bg-amber-500 text-black text-xs font-semibold px-3 py-1.5 transition-colors"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre id="label-output-block" className="px-4 py-3 text-cyan-300 font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre">
        <span className="select-none text-slate-600">1 › </span><span className="text-amber-400">TEXT</span>{'\n'}
        <span className="select-none text-slate-600">2 › </span>{insertion}{'\n'}
        <span className="select-none text-slate-600">3 › </span>{height}{'\n'}
        <span className="select-none text-slate-600">4 › </span>0{'\n'}
        <span className="select-none text-slate-600">5 › </span>{lotNo || 'LOT'}{'\n'}
        <span className="select-none text-slate-600">6 › </span><span className="text-slate-600">(blank — ends the command)</span>
      </pre>
      <div className="px-4 pb-3 text-[11px] text-slate-500">
        With the AutoCAD command line focused, paste this after drawing the boundary — it places the lot number as text at the polygon's centroid ({insertion}). Line 3 is the text height ({height}, scaled to this lot's size) — edit it before pasting if you want it bigger or smaller.
      </div>
    </div>
  );
}

function SavePanel({ header, tiePoint, corners, zone, result, municipality, setMunicipality, barangay, setBarangay, section, setSection, onLoadRecord, loadedKey, setLoadedKey }) {
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null); // {ok, text}
  const [records, setRecords] = useState([]);
  const [expanded, setExpanded] = useState({}); // barangayKey -> bool
  const [showRecords, setShowRecords] = useState(false);
  const [sortBy, setSortBy] = useState('lot'); // 'lot' | 'section' | 'owner' | 'area'
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'

  // Build filename preview
  const stem = filenameStem(barangay, section, header.lotNo);

  const refresh = useCallback(async () => {
    const all = await listAllLotRecords();
    setRecords(all);
  }, []);

  useEffect(() => { refresh(); }, []);

  // Show a save-panel message. Clearing any pending auto-hide timer first
  // prevents a stale timer from an earlier success wiping a newer message.
  const msgTimer = useRef(null);
  const showMsg = (msg, autoClear = false) => {
    if (msgTimer.current) { clearTimeout(msgTimer.current); msgTimer.current = null; }
    setSaveMsg(msg);
    if (autoClear) msgTimer.current = setTimeout(() => setSaveMsg(null), 3000);
  };

  const handleSave = async () => {
    if (!barangay.trim()) { showMsg({ ok: false, text: 'Enter a barangay name first.' }); return; }
    if (!section.trim()) { showMsg({ ok: false, text: 'Enter a section number first.' }); return; }
    setSaving(true); showMsg(null);
    const key = await saveLotRecord(barangay.trim(), section.trim(), { header, tiePoint, corners, zone, municipality: municipality.trim() }, loadedKey);
    await refresh();
    setSaving(false);
    if (key) {
      setLoadedKey(key); // further saves now overwrite this same record instead of forking a new one
      showMsg({ ok: true, text: `Saved as ${filenameStem(barangay, section, header.lotNo)}` }, true);
    } else {
      showMsg({ ok: false, text: 'Save failed — check storage.' });
    }
  };

  const handleDelete = async (key) => {
    await deleteLotRecord(key);
    await refresh();
    // If the record currently open in the editor was the one just deleted,
    // stop treating it as "loaded" — otherwise the next Save would silently
    // resurrect it under whatever key the form currently has.
    if (loadedKey === key) setLoadedKey(null);
  };

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
  };

  // Group records by barangay, then sort each group by the active column
  const byBarangay = useMemo(() => {
    const groups = {};
    for (const r of records) {
      const b = r.barangay || '(no barangay)';
      if (!groups[b]) groups[b] = [];
      groups[b].push(r);
    }
    const val = (r) => {
      if (sortBy === 'lot') return (r.header?.lotNo || '').toString();
      if (sortBy === 'section') return (r.section || '').toString();
      if (sortBy === 'owner') return (r.header?.owner || '').toString();
      return Number(r.header?.declaredArea) || 0; // area
    };
    for (const b of Object.keys(groups)) {
      groups[b].sort((a, z) => {
        const av = val(a), zv = val(z);
        const cmp = typeof av === 'number'
          ? av - zv
          : av.localeCompare(zv, undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return groups;
  }, [records, sortBy, sortDir]);

  const SortTh = ({ col, children, className = 'text-left' }) => (
    <th className={`px-3 py-1.5 ${className}`}>
      <button
        onClick={() => toggleSort(col)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide text-[10px] transition-colors ${sortBy === col ? 'text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}
        title={`Sort by ${children}`}
      >
        {children}
        {sortBy === col ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : <ChevronsUpDown size={10} className="opacity-50" />}
      </button>
    </th>
  );

  return (
    <div className="rounded-sm border border-slate-700 bg-slate-900 p-4 space-y-4">
      <SectionEyebrow>Save to records</SectionEyebrow>

      {/* Input row + save button */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Municipality</span>
          <input
            value={municipality}
            onChange={(e) => { setMunicipality(e.target.value); setSaveMsg(null); }}
            placeholder="e.g. Placer"
            className="w-32 bg-slate-800 border border-slate-600 rounded-sm text-xs text-stone-100 placeholder-slate-500 px-2 py-1.5 focus:outline-none focus:border-amber-500"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Barangay</span>
          <input
            value={barangay}
            onChange={(e) => { setBarangay(e.target.value); setSaveMsg(null); }}
            placeholder="e.g. Poblacion"
            className="w-36 bg-slate-800 border border-slate-600 rounded-sm text-xs text-stone-100 placeholder-slate-500 px-2 py-1.5 focus:outline-none focus:border-amber-500"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Section</span>
          <input
            value={section}
            onChange={(e) => { setSection(e.target.value); setSaveMsg(null); }}
            placeholder="e.g. 1"
            className="w-24 bg-slate-800 border border-slate-600 rounded-sm text-xs text-stone-100 placeholder-slate-500 px-2 py-1.5 focus:outline-none focus:border-amber-500"
          />
        </label>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-black text-xs font-semibold px-3 py-1.5 transition-colors"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          Save
        </button>
        {saveMsg && (
          <span className={`text-xs font-medium ${saveMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
            {saveMsg.text}
          </span>
        )}
      </div>
      {/* Filename preview */}
      <div className="text-[11px] text-slate-500">
        Will save as <span className="font-mono text-slate-300">{stem}</span>
      </div>

      {/* Records browser toggle */}
      <button
        onClick={() => { if (!showRecords) refresh(); setShowRecords((v) => !v); }}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-cyan-400 transition-colors"
      >
        <BookOpen size={13} />
        {showRecords ? 'Hide records' : `Browse records (${records.length} lots)`}
        {showRecords ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {showRecords && (
        <>
        <p className="text-[11px] text-slate-500 -mt-2">Click a lot's row to open it for preview and editing. Click a column header to sort.</p>
        <div className="border border-slate-700 rounded-sm overflow-hidden">
          {Object.keys(byBarangay).length === 0 ? (
            <div className="px-4 py-6 text-xs text-slate-500 text-center">No records saved yet.</div>
          ) : (
            Object.entries(byBarangay).map(([bgy, lots]) => {
              const open = expanded[bgy] !== false; // default open
              return (
                <div key={bgy} className="border-b border-slate-700 last:border-0">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [bgy]: !open }))}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-750 text-left"
                  >
                    <span className="flex items-center gap-2 text-xs font-bold text-cyan-300 uppercase tracking-wide">
                      <FolderOpen size={13} /> {bgy}
                    </span>
                    <span className="flex items-center gap-2 text-[11px] text-slate-500">
                      {lots.length} lot{lots.length !== 1 ? 's' : ''}
                      {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </span>
                  </button>
                  {open && (
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr className="bg-slate-900">
                          <SortTh col="section">Section</SortTh>
                          <SortTh col="lot">Lot No.</SortTh>
                          <SortTh col="owner">Owner</SortTh>
                          <SortTh col="area">Area (sq.m)</SortTh>
                          <th className="px-3 py-1.5 text-left uppercase tracking-wide text-[10px] text-slate-500">Filename</th>
                          <th className="px-3 py-1.5 w-16" />
                        </tr>
                      </thead>
                      <tbody>
                        {lots.map((r) => (
                          <tr
                            key={r.key}
                            onClick={() => onLoadRecord && onLoadRecord(r)}
                            title="Open this lot for preview and editing"
                            className="border-t border-slate-800 hover:bg-slate-800/50 cursor-pointer"
                          >
                            <td className="px-3 py-1.5 font-mono text-slate-300">{r.section || '—'}</td>
                            <td className="px-3 py-1.5 font-mono text-amber-400">{r.header?.lotNo || '—'}</td>
                            <td className="px-3 py-1.5 text-slate-300 max-w-[160px] truncate">{r.header?.owner || '—'}</td>
                            <td className="px-3 py-1.5 font-mono text-slate-300">{r.header?.declaredArea ? fmt(Number(r.header.declaredArea)) : '—'}</td>
                            <td className="px-3 py-1.5 font-mono text-slate-400 text-[11px]">{filenameStem(r.barangay, r.section, r.header?.lotNo)}</td>
                            <td className="px-3 py-1.5 text-right">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(r.key); }}
                                title="Delete this record"
                                className="text-slate-600 hover:text-rose-400 transition-colors"
                              >
                                <Trash2 size={12} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })
          )}
        </div>
        </>
      )}
    </div>
  );
}

/* ============================================================================
   MAIN APP
   ========================================================================== */

const emptyHeader = () => ({
  formType: '', lotNo: '', sheetNo: '', owner: '', address: '', cadSurveyNo: '', quadrangle: '', barrio: '',
  munCity: '', island: '', geodeticEngr: '', dateSurveyed: '', survSymNo: '',
  lrcNo: '', surveyNumber: '', declaredArea: '',
});

export default function LDCDigitizer() {
  const [stage, setStage] = useState('upload'); // upload | extracting | ready
  const [extractStepMsg, setExtractStepMsg] = useState(''); // shown during extraction
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [header, setHeader] = useState(emptyHeader());
  const [tiePoint, setTiePoint] = useState({ label: 'BLLM 1', n: '', e: '', bearingText: '', distance: '' });
  const [corners, setCorners] = useState([]);
  const [notes, setNotes] = useState('');
  const [repairedNote, setRepairedNote] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [zone, setZone] = useState(DEFAULT_ZONE);
  const [municipality, setMunicipality] = useState('');
  const [barangay, setBarangay] = useState('');
  const [section, setSection] = useState('');
  const [loadedKey, setLoadedKey] = useState(null); // storage key of the record currently being edited, if any

  const numericCorners = useMemo(
    () => corners
      .map((c) => ({ n: Number(c.n), e: Number(c.e) }))
      .filter((c) => Number.isFinite(c.n) && Number.isFinite(c.e)),
    [corners]
  );
  const result = useMemo(
    () => (numericCorners.length >= 3 ? computeTraverse(numericCorners) : null),
    [numericCorners]
  );

  const handleFile = useCallback(async (file) => {
    setUploadError(null);
    setStage('extracting');
    setExtractStepMsg('Preparing image…');
    setLoadedKey(null); // a fresh scan is a new lot, not an edit of a loaded record
    try {
      const { base64, mediaType, dataUrl } = await resizeImageFile(file);
      setImageDataUrl(dataUrl);
      setExtractStepMsg('Reading header fields (lot no., owner, tie point)…');
      const { header: h, corners: c, repaired } = await runExtraction(base64, mediaType);
      setExtractStepMsg('Done.');
      setHeader({
        formType: h.formType || '', lotNo: h.lotNo || '', sheetNo: h.sheetNo || '', owner: h.owner || '', address: h.address || '',
        cadSurveyNo: h.cadSurveyNo || '', quadrangle: h.quadrangle || '', barrio: h.barrio || '',
        munCity: h.munCity || '', island: h.island || '', geodeticEngr: h.geodeticEngr || '',
        dateSurveyed: h.dateSurveyed || '', survSymNo: h.survSymNo || '', lrcNo: h.lrcNo || '',
        surveyNumber: h.surveyNumber || '', declaredArea: h.declaredArea ?? '',
      });
      // Auto-fill barangay from the form: dedicated field first, then barrio,
      // then the first locality word of the claimant's address.
      const autoBarangay = h.barangay || h.barrio || ((h.address || '').trim().split(/[\s,]+/)[0] || '');
      setBarangay(autoBarangay ? autoBarangay.trim().toUpperCase() : '');
      // Municipality auto-fills the same way: dedicated field, else the address
      // word after the barangay (e.g. "Placer" from "POBLACION PLACER MASBATE").
      const addrWords = (h.address || '').trim().split(/[\s,]+/).filter(Boolean);
      const autoMun = h.munCity || (addrWords.length > 1 ? addrWords[1] : '');
      setMunicipality(autoMun ? autoMun.trim().toUpperCase() : '');
      setTiePoint({ label: h.tieLabel || 'BLLM 1', n: h.tieN ?? '', e: h.tieE ?? '', bearingText: h.tieBearing || '', distance: h.tieDistance ?? '' });
      setCorners(c.length ? c : [{ n: '', e: '', bearingText: '', distance: '', cornerDesc: '', override: null }]);
      setNotes(h.notes || '');
      setRepairedNote(!!repaired);
      setStage('ready');
    } catch (e) {
      setUploadError(e.message || 'Something went wrong reading that image.');
      setExtractStepMsg('');
      setStage('upload');
    }
  }, []);

  const [addingSheet, setAddingSheet] = useState(false);
  const [addSheetError, setAddSheetError] = useState(null);

  // Multi-sheet LDCs: a lot with many corners continues onto sheet 2 (and 3...).
  // This reads ONLY the corner table off an additional sheet and appends the
  // rows to the existing list — the header stays from sheet 1.
  const handleAddSheet = useCallback(async (file) => {
    setAddingSheet(true);
    setAddSheetError(null);
    try {
      const { base64, mediaType } = await resizeImageFile(file);
      const cornersRaw = await callClaudeVision(CORNERS_PROMPT, base64, mediaType);
      let cornersJson;
      try { cornersJson = JSON.parse(stripFences(cornersRaw)); }
      catch (e) { cornersJson = repairCornersJSON(cornersRaw); }
      const extra = (cornersJson.corners || []).map((row) => ({
        n: row[1] ?? '', e: row[2] ?? '', bearingText: row[3] || '', distance: row[4] ?? '', cornerDesc: row[5] || '', override: null,
      }));
      if (!extra.length) throw new Error('No corner rows found on that sheet.');
      setCorners((prev) => {
        const merged = [...prev];
        for (const c of extra) {
          const last = merged[merged.length - 1];
          // Continuation sheets sometimes repeat the previous sheet's last corner — skip the duplicate.
          if (last && String(last.n) === String(c.n) && String(last.e) === String(c.e)) continue;
          merged.push(c);
        }
        return merged;
      });
    } catch (e) {
      setAddSheetError(e.message || 'Could not read that sheet.');
    }
    setAddingSheet(false);
  }, []);

  const handleLoadRecord = (r) => {
    setLoadedKey(r.key || null);
    setHeader({ ...emptyHeader(), ...r.header });
    setTiePoint(r.tiePoint || { label: 'BLLM 1', n: '', e: '', bearingText: '', distance: '' });
    setCorners(r.corners || []);
    setZone(r.zone || DEFAULT_ZONE);
    setMunicipality(r.municipality || '');
    setBarangay(r.barangay || '');
    setSection(r.section || '');
    setNotes('');
    setRepairedNote(false);
    setImageDataUrl(null);
    setStage('ready');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const reset = () => {
    setStage('upload');
    setImageDataUrl(null);
    setHeader(emptyHeader());
    setTiePoint({ label: 'BLLM 1', n: '', e: '', bearingText: '', distance: '' });
    setCorners([]);
    setNotes('');
    setRepairedNote(false);
    setUploadError(null);
    setZone(DEFAULT_ZONE);
    setMunicipality('');
    setBarangay('');
    setSection('');
    setLoadedKey(null);
  };

  return (
    <div className="min-h-full w-full bg-slate-950 text-stone-200 uppercase" style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' }}>
      <div style={gridBg} className="border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-5 py-6 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-400 mb-1">LDC · Digitizer <span className="normal-case tracking-normal font-medium text-slate-400">by Chris Cuaca, REA, LET, BSCE</span></div>
            <h1 className="text-xl font-bold text-stone-50 tracking-tight">Lot Data Computation → AutoCAD · QGIS · KML</h1>
          </div>
          {stage === 'ready' && (
            <button onClick={reset} className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-400 hover:text-stone-100 transition-colors">
              <RotateCcw size={13} /> New lot
            </button>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-6 space-y-6">
        {stage !== 'ready' && (
          <>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setHeader(emptyHeader());
                  setTiePoint({ label: 'BLLM 1', n: '', e: '', bearingText: '', distance: '' });
                  setCorners([{ n: '', e: '', bearingText: '', distance: '', cornerDesc: '', override: null }]);
                  setNotes('');
                  setRepairedNote(false);
                  setUploadError(null);
                  setLoadedKey(null);
                  setStage('ready');
                }}
                className="inline-flex items-center gap-1.5 rounded-sm border border-stone-300 bg-white text-stone-700 hover:border-amber-600 hover:text-amber-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors"
              >
                <FileText size={13} /> Manual Input
              </button>
            </div>
            <UploadZone onFile={handleFile} busy={stage === 'extracting'} stepMsg={extractStepMsg} error={uploadError} />
          </>
        )}

        {stage === 'ready' && (
          <>
            {(notes || repairedNote) && (
              <div className="flex items-start gap-2 text-amber-200 bg-amber-900/20 border border-amber-800/50 rounded-sm px-3 py-2 text-xs">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  {repairedNote && 'The corner table response was long and had to be trimmed to the last complete row — double check the last corner. '}
                  {notes}
                </span>
              </div>
            )}

            {/* ---- Review (paper panel) ---- */}
            <div className="rounded-sm border border-stone-300 bg-stone-100 p-5">
              <div className="flex items-center gap-2 mb-4 text-stone-500">
                <Paperclip size={14} />
                <span className="text-[11px] font-bold uppercase tracking-[0.2em]">Step 1 · Review extracted data</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mb-5">
                <Field label="Lot No." value={header.lotNo} onChange={(v) => setHeader({ ...header, lotNo: v })} mono />
                <Field label="Owner / Claimant" value={header.owner} onChange={(v) => setHeader({ ...header, owner: v })} />
                <Field label="Survey Number" value={header.surveyNumber} onChange={(v) => setHeader({ ...header, surveyNumber: v })} mono />
                <Field label="Declared Area (sq.m)" value={header.declaredArea} onChange={(v) => setHeader({ ...header, declaredArea: v })} mono />
                <Field label="Address" value={header.address} onChange={(v) => setHeader({ ...header, address: v })} />
                <Field label="Quadrangle" value={header.quadrangle} onChange={(v) => setHeader({ ...header, quadrangle: v })} mono />
              </div>

              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Corner coordinates</div>
              <CornerTable corners={corners} setCorners={setCorners} result={result} tiePoint={tiePoint} setTiePoint={setTiePoint} onAddSheet={handleAddSheet} addingSheet={addingSheet} addSheetError={addSheetError} />
            </div>

            {/* ---- Results (blueprint panels) ---- */}
            {result ? (
              <div className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <AreaCard declaredArea={header.declaredArea} computedArea={result.area} />
                  <AccuracyCard result={result} />
                </div>
                <BearingDistanceTable result={result} corners={corners} />
                <APOutput result={result} />
                <LabelOutput result={result} header={header} />
                <EarthOutput result={result} corners={corners} header={header} zone={zone} setZone={setZone} municipality={municipality} barangay={barangay} section={section} />
                <SavePanel header={header} tiePoint={tiePoint} corners={corners} zone={zone} result={result} municipality={municipality} setMunicipality={setMunicipality} barangay={barangay} setBarangay={setBarangay} section={section} setSection={setSection} onLoadRecord={handleLoadRecord} loadedKey={loadedKey} setLoadedKey={setLoadedKey} />
                <p className="text-[11px] text-slate-500 pt-1">{corners.length} corners · edits above recompute everything live.</p>
              </div>
            ) : (
              <div className="rounded-sm border border-slate-700 bg-slate-900 p-5 text-sm text-slate-400">
                Enter at least 3 corners with Northing and Easting to compute the boundary.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
