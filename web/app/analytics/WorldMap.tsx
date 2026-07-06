'use client';

// =============================================================================
// Dependency-free choropleth. Path data is a pre-projected (equirectangular,
// lat clipped [-58, 83] to drop Antarctica) simplification of Natural Earth
// 110m country borders — baked once from world-atlas@2/countries-110m.json,
// no d3/topojson/react-simple-maps at runtime (keeps the next-on-pages bundle
// light). GA4's `country` dimension names are matched against Natural Earth's
// `properties.name`; COUNTRY_ALIASES below bridges the handful that differ.
// =============================================================================

import React, { useMemo } from 'react';
import worldData from './world-map-data.json';

type CountryPath = { id: string; name: string; d: string };
type WorldData = { viewBox: string; width: number; height: number; countries: CountryPath[] };

const WORLD = worldData as unknown as WorldData;

// GA4 country name -> Natural Earth `properties.name` (only where they differ).
const COUNTRY_ALIASES: Record<string, string> = {
  'United States': 'United States of America',
  'Myanmar (Burma)': 'Myanmar',
  'Ivory Coast': "Côte d'Ivoire",
  'Congo - Brazzaville': 'Congo',
  'Congo - Kinshasa': 'Dem. Rep. Congo',
  'Democratic Republic of the Congo': 'Dem. Rep. Congo',
  'Republic of the Congo': 'Congo',
  'Bosnia & Herzegovina': 'Bosnia and Herz.',
  'North Macedonia': 'Macedonia',
  'Eswatini': 'eSwatini',
  'Czech Republic': 'Czechia',
  'Dominican Republic': 'Dominican Rep.',
  'Central African Republic': 'Central African Rep.',
  'South Sudan': 'S. Sudan',
  'Equatorial Guinea': 'Eq. Guinea',
  'Western Sahara': 'W. Sahara',
  'Trinidad & Tobago': 'Trinidad and Tobago',
  'Solomon Islands': 'Solomon Is.',
  'Falkland Islands (Islas Malvinas)': 'Falkland Is.',
  'Palestine': 'Palestine',
  'St. Vincent & Grenadines': 'Saint Vincent and the Grenadines',
};

function normalize(name: string): string {
  return COUNTRY_ALIASES[name] ?? name;
}

export interface WorldMapDatum {
  country: string;
  value: number;
}

export function WorldMap({
  data,
  height = 260,
}: {
  data: WorldMapDatum[];
  height?: number;
}) {
  const byName = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data) m.set(normalize(d.country), d.value);
    return m;
  }, [data]);

  const max = useMemo(() => Math.max(1, ...data.map((d) => d.value)), [data]);

  const colorFor = (name: string): string => {
    const v = byName.get(name);
    if (!v) return 'var(--paper-sunk)';
    const t = Math.sqrt(v / max); // sqrt scale — one dominant country shouldn't wash out the rest
    // interpolate between a light and a saturated brand-stone tone
    const lightness = 82 - t * 50; // 82% (near-white) -> 32% (deep)
    return `hsl(210, 45%, ${lightness}%)`;
  };

  return (
    <svg
      viewBox={WORLD.viewBox}
      style={{ width: '100%', height, display: 'block' }}
      role="img"
      aria-label="Active users by country"
    >
      <rect x={0} y={0} width={WORLD.width} height={WORLD.height} fill="transparent" />
      {WORLD.countries.map((c) => {
        const v = byName.get(c.name);
        const title = v ? `${c.name}: ${new Intl.NumberFormat('en-US').format(v)}` : c.name;
        return (
          <g key={c.id}>
            {/* Fill needs each fragment closed (the antimeridian-splitter emits
                one Z per fragment — Russia/Fiji/the Aleutians end up as 2-3
                closed pieces instead of one ring). */}
            <path d={c.d} fill={colorFor(c.name)} fillRule="evenodd">
              <title>{title}</title>
            </path>
            {/* Stroke is drawn from a Z-stripped copy of the same "d". Every
                closed fragment's Z would otherwise draw a straight border
                stroke connecting its two cut ends — for Russia's Arctic-coast
                fragments that chord runs almost the full map width and shows
                up as a stray horizontal line. Fill doesn't have this problem
                (SVG needs the explicit close there); only the visible stroke
                does, so we skip Z for stroke only. */}
            <path d={c.d.replace(/Z/g, '')} fill="none" stroke="var(--paper)" strokeWidth={0.4} />
          </g>
        );
      })}
    </svg>
  );
}

export default WorldMap;
