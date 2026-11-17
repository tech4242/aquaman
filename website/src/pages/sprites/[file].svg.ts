import type { APIRoute, GetStaticPaths } from 'astro';
import * as sprites from '../../lib/sprites';

// Every drawing as a standalone SVG, plus a "lit" copy whose outline is foam for use on dark water.
const names = Object.keys(sprites).filter((k) => k !== 'PALETTE') as Exclude<keyof typeof sprites, 'PALETTE'>[];

export const getStaticPaths: GetStaticPaths = () =>
  names.flatMap((name) => {
    const slug = name.toLowerCase().replace(/_/g, '-');
    return [
      { params: { file: slug }, props: { name, lit: false } },
      { params: { file: `${slug}-lit` }, props: { name, lit: true } },
    ];
  });

export const GET: APIRoute = ({ props }) => {
  const rows = sprites[props.name as (typeof names)[number]] as string[];
  const palette: Record<string, string> = { ...sprites.PALETTE, ...(props.lit ? { '#': sprites.PALETTE.l } : {}) };
  const width = Math.max(...rows.map((r) => r.length));
  // One path per colour, one sub-path per horizontal run.
  const paths: Record<string, string> = {};
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x;
      while (end < row.length && row[end] === ch) end++;
      if (palette[ch]) paths[palette[ch]] = (paths[palette[ch]] ?? '') + `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  const body = Object.entries(paths).map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${rows.length}" shape-rendering="crispEdges">${body}</svg>\n`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
};
