import { readFileSync, writeFileSync } from 'fs';
import { feature } from 'topojson-client';

const world = JSON.parse(readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)));
const topo = feature(world, world.objects.countries);

// Philippines ISO 3166-1 numeric code = 608
const phl = topo.features.find((f) => f.id === '608' || f.id === 608 || (f.properties && f.properties.name === 'Philippines'));
if (!phl) {
  console.error('Philippines feature not found. Available ids/names sample:');
  console.error(topo.features.slice(0, 5).map((f) => ({ id: f.id, name: f.properties?.name })));
  process.exit(1);
}

writeFileSync(new URL('./ph-geometry.json', import.meta.url), JSON.stringify(phl.geometry));
console.log('type:', phl.geometry.type);
console.log('rings/polygons:', phl.geometry.coordinates.length);
console.log('first polygon point count:', phl.geometry.coordinates[0][0].length);
