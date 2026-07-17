import React from 'react';

// ISO codes for flag images (flagcdn) — reliable across platforms, unlike
// emoji flags which render as plain letters on Windows.
const ISO = {
  France: 'fr', Spain: 'es', England: 'gb-eng', Argentina: 'ar', Brazil: 'br',
  Germany: 'de', Italy: 'it', Portugal: 'pt', Netherlands: 'nl', Belgium: 'be',
  Croatia: 'hr', Morocco: 'ma', Japan: 'jp', Mexico: 'mx', USA: 'us',
  Uruguay: 'uy', Colombia: 'co', Senegal: 'sn', Ghana: 'gh', Nigeria: 'ng',
  Poland: 'pl', Switzerland: 'ch', Denmark: 'dk', Sweden: 'se', Norway: 'no',
  Australia: 'au', Canada: 'ca', Ecuador: 'ec', Vietnam: 'vn', Myanmar: 'mm',
  Liechtenstein: 'li', Gibraltar: 'gi', 'New Zealand': 'nz', India: 'in',
  Scotland: 'gb-sct', Wales: 'gb-wls', 'South Korea': 'kr', Qatar: 'qa',
  'Saudi Arabia': 'sa', Iran: 'ir', Tunisia: 'tn', Cameroon: 'cm', Serbia: 'rs',
  Austria: 'at', Ukraine: 'ua', Turkey: 'tr', 'Czech Republic': 'cz',
};

export function Flag({ name, size = 22, round = false }) {
  const iso = ISO[name];
  if (!iso) return <span style={{ fontSize: size * 0.9 }}>⚽</span>;
  return (
    <img
      className={`flag-img ${round ? 'round' : ''}`}
      src={`https://flagcdn.com/w80/${iso}.png`}
      srcSet={`https://flagcdn.com/w160/${iso}.png 2x`}
      alt={name}
      style={{ width: size, height: round ? size : undefined }}
      loading="lazy"
    />
  );
}

// kept for text-only contexts (share text etc.)
export const flag = name => (ISO[name] ? '' : '⚽');
