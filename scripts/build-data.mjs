#!/usr/bin/env node
// Builds a page for each city in cities/ from live sources. For a city whose
// folder is cities/<slug>/, it writes:
//   site/<slug>/index.html               the trip planner page (from site/template.html)
//   site/<slug>/data/transit.json        bus schedule for Election Day (from GTFS)
//   site/<slug>/data/site-data.json      site config + polling places with coordinates
//   site/<slug>/data/precincts.geojson   precinct boundaries (optional; used to suggest a precinct)
// and site/index.html, a page linking to every city.
//
// Usage:
//   node scripts/build-data.mjs                                # every city, fetch everything
//   node scripts/build-data.mjs --city radford                 # one city
//   node scripts/build-data.mjs --city radford --gtfs feed.zip # use a local GTFS zip or folder
//   node scripts/build-data.mjs --skip-geocode --skip-precincts

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { buildTransit } from './lib/gtfs.mjs';
import { geocode } from './lib/geocode.mjs';
import { matchPrecincts } from './lib/precincts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const log = (...m) => console.log('•', ...m);
const warn = (...m) => console.warn('⚠', ...m);

async function loadGtfs(urls) {
  const local = opt('--gtfs');
  if (local) {
    if ((await stat(local)).isDirectory()) {
      const files = {};
      for (const f of await readdir(local)) if (f.endsWith('.txt')) files[f] = await readFile(join(local, f), 'utf8');
      return { files, source: local };
    }
    return { files: unzip(await readFile(local)), source: local };
  }
  for (const url of urls) {
    try {
      log(`Downloading GTFS from ${url}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const files = unzip(new Uint8Array(await res.arrayBuffer()));
      if (!files['stop_times.txt']) throw new Error('zip has no stop_times.txt');
      return { files, source: url };
    } catch (e) {
      warn(`GTFS download failed (${url}): ${e.message}`);
    }
  }
  throw new Error('Could not download a GTFS feed from any configured URL');
}

function unzip(buf) {
  const files = {};
  for (const [name, data] of Object.entries(unzipSync(buf))) {
    const base = name.split('/').pop();
    if (base.endsWith('.txt')) files[base] = strFromU8(data);
  }
  return files;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function listCities() {
  const dir = join(root, 'cities');
  const slugs = [];
  for (const name of (await readdir(dir)).sort()) {
    if ((await stat(join(dir, name))).isDirectory()) slugs.push(name);
  }
  return slugs;
}

async function loadCity(slug) {
  const dir = join(root, 'cities', slug);
  return {
    slug,
    config: JSON.parse(await readFile(join(dir, 'site.json'), 'utf8')),
    polling: JSON.parse(await readFile(join(dir, 'polling-places.json'), 'utf8')),
  };
}

async function writePage({ slug, config }) {
  const template = await readFile(join(root, 'site', 'template.html'), 'utf8');
  const vars = {
    siteName: config.siteName,
    agency: config.transit.agency,
    city: config.city,
    cityName: config.cityName,
    addressExample: config.addressExample,
  };
  const html = template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`site/template.html uses {{${k}}}, which the build doesn't fill in`);
    return escHtml(vars[k]);
  });
  await writeFile(join(root, 'site', slug, 'index.html'), html);
}

async function writeIndex(cities) {
  const items = cities.map(({ slug, config }) =>
    `      <li><a href="${escHtml(slug)}/"><strong>${escHtml(config.siteName)}</strong><span>${escHtml(config.transit.agency)} buses to ${escHtml(config.cityName)} polling places</span></a></li>`).join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rides to Vote</title>
  <meta name="description" content="Find a bus from your home to your polling place in Southwest Virginia.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body class="landing">
  <main>
    <h1>Rides to Vote</h1>
    <p>Find a bus from your home to your polling place. Choose your city:</p>
    <ul class="city-list">
${items}
    </ul>
    <p class="hint">An independent, nonpartisan tool. Always confirm your polling place with official sources.</p>
  </main>
</body>
</html>
`;
  await writeFile(join(root, 'site', 'index.html'), html);
}

async function main() {
  const all = await listCities();
  const only = args.flatMap((a, i) => (a === '--city' ? [args[i + 1]] : []));
  for (const slug of only) if (!all.includes(slug)) throw new Error(`No city folder cities/${slug} (have: ${all.join(', ')})`);
  if (opt('--gtfs') && only.length !== 1) throw new Error('--gtfs needs exactly one --city');
  const slugs = only.length ? only : all;

  for (const slug of slugs) {
    console.log(`\n== ${slug}`);
    await buildCity(await loadCity(slug));
  }
  await writeIndex(await Promise.all(all.map(loadCity)));
  log(`Wrote site/index.html (${all.length} cities)`);
}

async function buildCity(city) {
  const { slug, config, polling } = city;
  const outDir = join(root, 'site', slug, 'data');
  await mkdir(outDir, { recursive: true });
  await writePage(city);

  // 1. Transit
  const { files, source } = await loadGtfs(config.transit.gtfsUrls);
  const transit = buildTransit(files, { targetDate: config.election.date });
  transit.source = source;
  transit.generated = new Date().toISOString();
  if (transit.substituted) {
    warn(`Feed has no service on ${config.election.date}; using the ${transit.serviceDate} schedule instead.`);
  }
  const trips = transit.patterns.reduce((n, p) => n + p.trips.length, 0);
  log(`Transit: ${transit.routes.length} routes, ${transit.stops.length} stops, ${transit.patterns.length} patterns, ${trips} trips on ${transit.serviceDate}`);
  await writeFile(join(outDir, 'transit.json'), JSON.stringify(transit));

  // 2. Polling places
  const places = [...polling.precincts, { ...config.earlyVoting, precinct: null, place: config.earlyVoting.name, early: true }];
  if (!flag('--skip-geocode')) {
    for (const p of places) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) continue;
      const hit = await geocode(p.address);
      if (hit) Object.assign(p, hit);
      else warn(`Could not geocode ${p.place} (${p.address})`);
    }
  }
  const located = places.filter((p) => Number.isFinite(p.lat)).length;
  log(`Polling places: ${located}/${places.length} located`);

  const siteData = {
    ...config,
    pollingSource: polling.source,
    pollingChecked: polling.checked,
    places: places.map(({ id, precinct, place, address, note, lat, lon, early }) => ({ id, precinct, place, address, note, lat, lon, early: !!early })),
  };
  siteData.transit = { ...config.transit };
  delete siteData.transit.gtfsUrls;
  await writeFile(join(outDir, 'site-data.json'), JSON.stringify(siteData, null, 2));

  // 3. Precinct boundaries (optional)
  if (!flag('--skip-precincts') && config.precinctBoundaries?.url) {
    try {
      const res = await fetch(config.precinctBoundaries.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { geojson, matched, unmatched } = matchPrecincts(await res.json(), polling.precincts);
      log(`Precinct boundaries: matched ${matched.length}/${polling.precincts.length} precincts`);
      if (unmatched.length) warn(`No boundary for: ${unmatched.join(', ')}`);
      if (matched.length) {
        await writeFile(join(outDir, 'precincts.geojson'), JSON.stringify(geojson));
        siteData.hasPrecincts = true;
        await writeFile(join(outDir, 'site-data.json'), JSON.stringify(siteData, null, 2));
      }
    } catch (e) {
      warn(`Skipping precinct boundaries: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
