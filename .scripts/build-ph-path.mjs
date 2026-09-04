import { readFileSync, writeFileSync } from 'fs';

const geom = JSON.parse(readFileSync(new URL('./ph-geometry.json', import.meta.url)));

// Must match the GEO/VW/VH constants written into ZoneMap in src/App.jsx —
// keep any change to bounds or aspect in sync between this generator and the
// component, since both the island path and the zone-strip rectangle are
// projected with the same formula.
const GEO = { minLon: 116.0, maxLon: 127.0, minLat: 4.5, maxLat: 21.5 };
const VH = 440;
// True-shape aspect at the archipelago's mean latitude (~13°N): 1 degree of
// longitude covers less ground than 1 degree of latitude by cos(13°), so
// pixels-per-degree-lon must be scaled down by that factor to avoid stretching
// the silhouette east-west.
const centerLatRad = ((GEO.minLat + GEO.maxLat) / 2) * (Math.PI / 180);
const lonSpan = GEO.maxLon - GEO.minLon;
const latSpan = GEO.maxLat - GEO.minLat;
const VW = Math.round(VH * ((lonSpan * Math.cos(centerLatRad)) / latSpan));

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function geoToSVG(lon, lat) {
  const x = ((lon - GEO.minLon) / (GEO.maxLon - GEO.minLon)) * VW;
  const y = ((GEO.maxLat - lat) / (GEO.maxLat - GEO.minLat)) * VH;
  return [x, y];
}

// Drop only the smallest islets (below this degree^2 threshold) — keeps every
// named island in the brief (Luzon, Mindanao, Palawan, Mindoro, Samar, Leyte,
// plus the Visayas cluster) and most minor ones, trims sub-pixel specks that
// would just be visual noise at thumbnail scale.
const AREA_THRESHOLD = 0.01;

const rings = geom.coordinates
  .map((poly) => poly[0])
  .filter((ring) => ringArea(ring) > AREA_THRESHOLD);

const d = rings
  .map((ring) => {
    const pts = ring.map(([lon, lat]) => geoToSVG(lon, lat).map((v) => Math.round(v * 10) / 10));
    return `M${pts.map((p) => p.join(',')).join('L')}Z`;
  })
  .join('');

writeFileSync(
  new URL('./ph-path-output.txt', import.meta.url),
  `VW=${VW} VH=${VH}\nrings=${rings.length}\npathLength=${d.length}\n\n${d}\n`
);
console.log('VW', VW, 'VH', VH, 'rings kept', rings.length, 'of', geom.coordinates.length, 'path chars', d.length);
