/**
 * Pixel art for the home page, drawn as text. Each character is one pixel:
 * `.` is empty and the letters name a colour in PALETTE. Sprite.astro turns a
 * grid into SVG rectangles, so the art scales without blurring.
 */
export const PALETTE: Record<string, string> = {
  '#': '#0b2a3a', // ink, the darkest shade
  d: '#136f7a', // deep water
  m: '#3fc1c0', // aqua
  l: '#d9f5ec', // foam
  c: '#ff6b4a', // coral
  s: '#c9412a', // coral, in shadow
  y: '#ffd23f', // sun and brass
  w: '#ffffff',
};

export const OCTOPUS = [
  '......########......',
  '....##cccccccc##....',
  '...#cccccccccccc#...',
  '..#cclccccccccccc#..',
  '..#clccccccccccccs#.',
  '..#ccwwwccccwwwccs#.',
  '..#ccwddccccwddccs#.',
  '..#ccwddccccwddccs#.',
  '..#ccccccccccccccs#.',
  '..#ccccccssssccccs#.',
  '...#ccccccccccccs#..',
  '..#cc#cc#cc#cc#cc#..',
  '.#cs#cs#cs#.#cs#cs#.',
  '.#c#.#c#.#c#.#c#.#c#',
  '#c#..#c#.#c#.#c#..#c',
  '##...##..##..##...##',
];

/** Eyes shut: the same sprite with the eye rows filled in, for a blink. */
export const OCTOPUS_BLINK = OCTOPUS.map((row, i) =>
  i === 5 ? '..#ccccccccccccccs#.' : i === 6 ? '..#ccssscccc###ccs#.'.replace('###', 'sss') : i === 7 ? '..#ccccccccccccccs#.' : row,
);

export const ROBOT = [
  '.......y........',
  '.......#........',
  '...##########...',
  '...#llllllll#...',
  '...#l##ll##l#...',
  '...#l##ll##l#...',
  '...#llllllll#...',
  '...#ll####ll#...',
  '...##########...',
  '....#mmmmmm#....',
  '..###mmmmmm###..',
  '....########....',
  '################',
  '#yyyyyyyyyyyyyy#',
  '#y#y#y#y#y#y#y##',
  '.##############.',
];

export const KEY = [
  '.###.........',
  '#yyy#........',
  '#y.y#########',
  '#yyy#yyyyyyy#',
  '.###.#y#y#y#.',
  '.....#.#.#.#.',
];

export const CHEST = [
  '.##############.',
  '#yyyyyyyyyyyyyy#',
  '#y############y#',
  '#yyyyyy##yyyyyy#',
  '################',
  '#ssssss#y#sssss#',
  '#cccccc###ccccc#',
  '#cccccccccccccc#',
  '#y############y#',
  '#yyyyyyyyyyyyyy#',
  '################',
];

export const FISH = [
  '..####...#',
  '.#llll#.##',
  '#l#llll#l#',
  '.#llll#.##',
  '..####...#',
];

export const BUBBLE = ['.###.', '#l..#', '#...#', '#...#', '.###.'];

export const TAG = [
  '..#########',
  '.#lllllllll#',
  '#l#lllllllll#',
  '.#lllllllll#',
  '..#########',
];

export const WEED = [
  '..d..',
  '.dd..',
  '.d...',
  '.dd..',
  '..dd.',
  '...d.',
  '..dd.',
  '.dd..',
  '.d...',
  '.dd..',
  '..d..',
  '..d..',
];

export const INK = [
  '...####.....',
  '.########.#.',
  '###########.',
  '############',
  '.##########.',
  '..###.####..',
  '....#...#...',
];
