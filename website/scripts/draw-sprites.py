#!/usr/bin/env python3
"""Draws the home page's pixel art from shapes and writes src/lib/sprites.ts.

Run from website/:  python3 scripts/draw-sprites.py
The output is plain text grids, one character per pixel, so a sprite can also
be touched up by hand; rerunning this script overwrites such edits.
"""
import math, os

class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.g = [['.'] * w for _ in range(h)]
    def set(self, x, y, ch):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            self.g[y][x] = ch
    def get(self, x, y):
        return self.g[y][x] if 0 <= x < self.w and 0 <= y < self.h else '.'
    def rect(self, x0, y0, w, h, ch):
        for y in range(y0, y0 + h):
            for x in range(x0, x0 + w):
                self.set(x, y, ch)
    def ellipse(self, cx, cy, rx, ry, ch, only=None):
        for y in range(self.h):
            for x in range(self.w):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                    if only is None or self.get(x, y) in only:
                        self.set(x, y, ch)
    def outline(self, ch='#'):
        edge = []
        for y in range(self.h):
            for x in range(self.w):
                if self.g[y][x] == '.' and any(self.get(x + dx, y + dy) not in '.' for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    edge.append((x, y))
        for x, y in edge:
            self.g[y][x] = ch
    def rows(self):
        rows = [''.join(r) for r in self.g]
        while rows and set(rows[0]) == {'.'}: rows.pop(0)
        while rows and set(rows[-1]) == {'.'}: rows.pop()
        left = min(len(r) - len(r.lstrip('.')) for r in rows)
        right = min(len(r) - len(r.rstrip('.')) for r in rows)
        return [r[left:len(r) - right] for r in rows]

def octopus(blink=False):
    c = Canvas(72, 66)
    cx, cy, rx, ry = 36, 22, 20, 17
    # Eight arms first, so the head overlaps where they join.
    for i in range(8):
        side = i - 3.5
        x0 = cx + side * 4.4
        length = 22 - abs(side) * 1.6
        steps = int(length * 2)
        for n in range(steps + 1):
            t = n / 2
            curl = math.sin(t / 3.6 + i * 0.9) * (1.7 + abs(side) * 0.35)
            x = x0 + side * t * 0.34 + curl
            y = 35 + t
            thick = 4 if t < length - 7 else 3 if t < length - 3 else 2
            for k in range(thick):
                c.set(x + k, y, 's' if k == thick - 1 else 'c')
            if n % 8 == 3 and t > 3:
                c.set(x, y, 'p'); c.set(x, y + 1, 'p')  # suckers catch the light
    c.ellipse(cx, cy, rx, ry, 'c')
    # Shadow low on the right, dithered where it meets the light.
    for y in range(c.h):
        for x in range(c.w):
            if c.get(x, y) == 'c' and ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                v = (x - cx) / rx + (y - cy) / ry
                if v > 1.04 or (v > 0.86 and (x + y) % 2 == 0):
                    c.set(x, y, 's')
    c.ellipse(25, 11, 6.5, 3.2, 'p', only='c')
    c.rect(22, 10, 3, 1, 'w'); c.set(21, 11, 'w')
    for x, y in ((45, 9), (49, 13), (42, 6), (51, 18)):
        c.set(x, y, 's'); c.set(x + 1, y, 's')              # freckles
    if blink:
        for ex in (22, 41):
            c.rect(ex, 24, 9, 2, 's')
    else:
        for ex in (22, 41):
            c.rect(ex, 17, 9, 11, 'w')
            c.rect(ex, 17, 9, 1, 's')                        # the lid's shadow
            c.rect(ex + 3, 20, 5, 7, 'd'); c.rect(ex + 4, 22, 3, 4, '#')
            c.rect(ex + 3, 20, 2, 2, 'w')
    for x, y in ((30, 31), (31, 32), (32, 33), (33, 33), (34, 33), (35, 33), (36, 33), (37, 33), (38, 33), (39, 32), (40, 31)):
        c.set(x, y, 's')
    for bx in (15, 53):
        c.rect(bx, 28, 4, 2, 'p')                            # cheeks
    c.outline()
    return c.rows()

def chest(open_lid=False):
    c = Canvas(56, 46)
    if open_lid:
        c.rect(8, 4, 40, 13, 's')                            # inside of the raised lid
        c.rect(8, 4, 40, 2, 'y'); c.rect(8, 15, 40, 2, 'g')
        c.rect(8, 4, 3, 13, 'y'); c.rect(45, 4, 3, 13, 'y')
        for x in range(13, 44, 6):
            c.rect(x, 7, 1, 7, '#' if x % 12 == 1 else 's')
        # A heap of coins, with a few sparkles.
        for x in range(11, 45):
            top = 21 - int(4 * math.sin((x - 11) / 34 * math.pi)) - (1 if x % 5 == 0 else 0)
            for y in range(top, 25):
                c.set(x, y, 'g' if (x * 3 + y * 2) % 7 == 0 else 'y')
        for x, y in ((16, 18), (27, 15), (37, 18), (22, 20)):
            c.set(x, y, 'w'); c.set(x + 1, y, 'w')
        c.rect(30, 17, 3, 2, 'm'); c.set(31, 16, 'm')        # a gem
        c.rect(19, 17, 3, 2, 'c')
        top = 25
    else:
        c.ellipse(28, 17, 20.5, 10, 'c')
        c.rect(6, 17, 44, 12, '.')
        c.ellipse(20, 11, 7, 2, 'p', only='c')
        for bx in (12, 26, 40):
            for y in range(6, 17):
                if c.get(bx, y) != '.':
                    c.rect(bx, y, 2, 1, 'y'); c.set(bx + 2, y, 'g')
        top = 17
    c.rect(8, top, 40, 17, 'c')
    for y in range(top + 5, top + 15, 4):
        c.rect(8, y, 40, 1, 's')                             # planks
    c.rect(8, top, 40, 3, 'y'); c.rect(8, top + 2, 40, 1, 'g'); c.rect(8, top + 14, 40, 3, 'g'); c.rect(8, top + 14, 40, 1, 'y')
    for bx in (12, 26, 40):
        c.rect(bx, top, 3, 17, 'y'); c.rect(bx + 2, top + 3, 1, 11, 'g')
        c.set(bx + 1, top + 5, 'w'); c.set(bx + 1, top + 11, 'w')   # rivets
    c.rect(44, top + 3, 4, 11, 's')
    c.rect(25, top + 4, 6, 8, 'y'); c.rect(25, top + 11, 6, 1, 'g'); c.rect(27, top + 6, 2, 2, '#'); c.rect(27, top + 8, 1, 2, '#')  # the lock
    c.outline()
    return c.rows()

def key():
    c = Canvas(26, 12)
    c.ellipse(5, 5, 4, 4, 'y'); c.ellipse(5, 5, 1.6, 1.6, '.')
    c.rect(9, 4, 13, 2, 'y'); c.rect(9, 5, 13, 1, 'g')
    c.rect(16, 6, 2, 3, 'y'); c.rect(20, 6, 2, 4, 'y')
    c.set(3, 3, 'w')
    c.outline()
    return c.rows()

def robot():
    c = Canvas(48, 46)
    c.rect(23, 3, 2, 4, '#'); c.ellipse(24, 2, 2.6, 2.2, 'y'); c.set(23, 1, 'w')      # antenna
    c.rect(11, 7, 26, 16, 'l'); c.rect(34, 8, 3, 15, 'm'); c.rect(12, 21, 24, 2, 'm')  # head
    c.rect(14, 10, 20, 8, '#')                                                          # visor
    for ex in (17, 26):
        c.rect(ex, 12, 5, 4, 'm'); c.rect(ex, 12, 2, 1, 'w'); c.set(ex + 4, 15, 'd')
    c.rect(19, 19, 10, 1, '#'); c.set(21, 19, 'l'); c.set(24, 19, 'l'); c.set(27, 19, 'l')
    c.rect(8, 12, 3, 6, 'm'); c.rect(37, 12, 3, 6, 'm'); c.set(8, 12, 'l'); c.set(37, 12, 'l')
    c.rect(21, 23, 6, 2, 'd')                                                           # neck
    c.rect(14, 25, 20, 10, 'm'); c.rect(31, 25, 3, 10, 'd'); c.rect(14, 25, 20, 1, 'l')
    c.rect(18, 27, 11, 6, 'y'); c.rect(18, 32, 11, 1, 'g'); c.rect(20, 29, 2, 2, 'c'); c.rect(24, 29, 3, 1, '#'); c.rect(24, 31, 3, 1, '#')
    c.rect(9, 26, 5, 3, 'l'); c.rect(34, 26, 5, 3, 'l'); c.rect(7, 26, 2, 4, 'm'); c.rect(39, 26, 2, 4, 'm')
    # The raft: three logs lashed together.
    c.rect(1, 36, 46, 6, 'y'); c.rect(1, 36, 46, 1, 'w'); c.rect(1, 41, 46, 1, 'g')
    for x in (16, 32):
        c.rect(x, 36, 1, 6, 'g')
    for x in (5, 41):
        c.rect(x, 36, 2, 6, '#')
    for x in (2, 18, 34):
        c.set(x, 38, 'g'); c.set(x + 1, 39, 'g'); c.set(x, 39, 'g')                     # the logs' end grain
    c.outline()
    return c.rows()

def fish():
    c = Canvas(20, 12)
    c.ellipse(8, 6, 6, 3.6, 'l')
    for y in range(3, 10):
        for x in range(13, 18):
            if abs(y - 6) <= (x - 13):
                c.set(x, y, 'l')
    c.set(5, 5, '#'); c.rect(7, 8, 4, 1, 'm'); c.set(10, 4, 'm'); c.set(11, 4, 'm')
    c.outline()
    return c.rows()

def bubble():
    c = Canvas(11, 11)
    c.ellipse(5, 5, 4, 4, 'l'); c.ellipse(5, 5, 3, 3, '.')
    c.set(3, 3, 'l'); c.set(4, 3, 'l'); c.set(3, 4, 'l')
    return c.rows()

def tag():
    c = Canvas(26, 12)
    c.rect(6, 2, 16, 7, 'l')
    for i in range(4):
        c.rect(5 - i, 2 + i, 1, 7 - 2 * i, 'l')
    c.set(5, 5, '#'); c.rect(9, 4, 10, 1, 'd'); c.rect(9, 6, 7, 1, 'd')
    c.outline()
    return c.rows()

def weed(height=26, phase=0.0):
    c = Canvas(14, height + 2)
    for t in range(height):
        x = 6 + math.sin(t / 3.0 + phase) * 2.6
        y = height - t
        c.set(x, y, 'd'); c.set(x + 1, y, 'm' if t % 4 == 0 else 'd')
        if t % 5 == 2:
            c.set(x + 2, y, 'd'); c.set(x - 1, y - 1, 'd')
    return c.rows()

def ink():
    c = Canvas(26, 16)
    for cx, cy, r in ((9, 7, 6), (15, 6, 5), (18, 9, 4), (6, 10, 3), (12, 11, 4)):
        c.ellipse(cx, cy, r, r * 0.8, '#')
    c.set(22, 5, '#'); c.set(23, 12, '#'); c.set(3, 4, '#'); c.rect(10, 14, 1, 2, '#'); c.rect(16, 13, 1, 2, '#')
    return c.rows()

def anchor():
    c = Canvas(26, 30)
    c.ellipse(13, 4, 3.4, 3.4, 'l'); c.ellipse(13, 4, 1.5, 1.5, '.')
    c.rect(12, 7, 2, 18, 'l'); c.rect(7, 10, 12, 2, 'l')
    for t in range(0, 11):
        a = math.pi * t / 10
        c.set(13 - math.cos(a) * 9, 18 + math.sin(a) * 7, 'l')
        c.set(13 - math.cos(a) * 8, 18 + math.sin(a) * 6, 'l')
    c.rect(3, 15, 2, 3, 'l'); c.rect(21, 15, 2, 3, 'l')
    c.outline('d')
    return c.rows()

def starfish():
    c = Canvas(22, 22)
    for i in range(5):
        a = -math.pi / 2 + i * 2 * math.pi / 5
        for t in range(0, 10):
            w = max(1, 3 - t // 3)
            for k in range(-w, w + 1):
                c.set(11 + math.cos(a) * t - math.sin(a) * k * 0.6, 11 + math.sin(a) * t + math.cos(a) * k * 0.6, 'c')
    c.ellipse(11, 11, 3, 3, 'c')
    for x, y in ((11, 11), (11, 7), (14, 10), (8, 10), (13, 14), (9, 14)):
        c.set(x, y, 'p')
    c.outline()
    return c.rows()

def shell():
    c = Canvas(20, 16)
    c.ellipse(10, 9, 8, 6.5, 'l')
    c.rect(1, 12, 18, 4, '.')
    c.rect(6, 11, 8, 2, 'l')
    for x in (5, 8, 11, 14):
        for y in range(4, 11):
            if c.get(x, y) == 'l':
                c.set(x, y, 'p')
    c.outline()
    return c.rows()

def crab():
    c = Canvas(30, 20)
    c.ellipse(15, 12, 8, 4.5, 'c')
    c.ellipse(15, 14, 7, 2, 's', only='c')
    for ex in (11, 18):
        c.rect(ex, 5, 1, 3, 'c'); c.rect(ex - 1, 3, 3, 3, 'w'); c.set(ex, 4, '#')
    for sx, d in ((5, -1), (24, 1)):
        c.rect(sx, 8, 2, 2, 'c'); c.ellipse(sx + d * 2 + 0.5, 5, 3, 2.6, 'c'); c.set(sx + d * 2, 4, '.'); c.set(sx + d * 3, 4, '.')
    for i, x in enumerate((8, 10, 19, 21)):
        c.rect(x, 16, 1, 2, 'c'); c.set(x + (-1 if i < 2 else 1), 18, 'c')
    c.outline()
    return c.rows()

def coral():
    c = Canvas(26, 26)
    def branch(x, y, a, n):
        for t in range(n):
            c.set(x + math.cos(a) * t, y - math.sin(a) * t, 'c'); c.set(x + math.cos(a) * t + 1, y - math.sin(a) * t, 's')
        return x + math.cos(a) * n, y - math.sin(a) * n
    x, y = branch(13, 25, math.pi / 2, 9)
    for a, n in ((2.3, 8), (0.9, 9), (1.6, 10)):
        bx, by = branch(x, y, a, n)
        branch(bx, by, a + 0.6, 4); branch(bx, by, a - 0.6, 4)
    c.outline()
    return c.rows()

def rock():
    c = Canvas(30, 14)
    c.ellipse(11, 10, 10, 7, 'd'); c.ellipse(21, 11, 7, 5, 'd')
    c.rect(0, 13, 30, 2, '.')
    c.ellipse(8, 7, 4, 2, 'm', only='d')
    c.outline()
    return c.rows()

def sun():
    c = Canvas(30, 30)
    c.ellipse(15, 15, 7, 7, 'y'); c.ellipse(12, 12, 2, 2, 'w', only='y')
    for i in range(8):
        a = i * math.pi / 4
        for t in (10, 11, 12):
            c.set(15 + math.cos(a) * t, 15 + math.sin(a) * t, 'y')
    return c.rows()

def cloud():
    c = Canvas(36, 14)
    for cx, cy, rx, ry in ((10, 9, 7, 4), (18, 6, 8, 5.5), (26, 9, 7, 4)):
        c.ellipse(cx, cy, rx, ry, 'w')
    c.rect(4, 10, 28, 3, 'w')
    c.rect(4, 12, 28, 1, 'm')
    return c.rows()

def star():
    c = Canvas(13, 13)
    for i in range(5):
        a = -math.pi / 2 + i * 2 * math.pi / 5
        for t in range(0, 6):
            w = 2 if t < 3 else 1 if t < 5 else 0
            for k in range(-w, w + 1):
                c.set(6 + math.cos(a) * t - math.sin(a) * k * 0.55, 6 + math.sin(a) * t + math.cos(a) * k * 0.55, 'y')
    c.outline()
    return c.rows()

def icon():
    """The octopus, small enough to read in a browser tab."""
    c = Canvas(16, 16)
    c.ellipse(7.5, 6, 5.6, 5, 'c')
    for x in (3, 6, 9, 12):
        c.rect(x, 10, 2, 4, 'c'); c.set(x + 1, 13, 's')
    c.set(2, 13, 'c'); c.set(13, 14, 'c')
    for ex in (5, 9):
        c.rect(ex, 5, 2, 3, 'w'); c.set(ex + 1, 6, '#'); c.set(ex + 1, 7, '#')
    c.set(5, 3, 'p'); c.set(6, 2, 'p')
    return c.rows()

SPRITES = {
    'OCTOPUS': octopus(), 'OCTOPUS_BLINK': octopus(blink=True), 'CHEST': chest(), 'CHEST_OPEN': chest(open_lid=True),
    'KEY': key(), 'ROBOT': robot(), 'FISH': fish(), 'BUBBLE': bubble(), 'TAG': tag(),
    'WEED': weed(), 'WEED_TALL': weed(34, 1.3), 'INK': ink(), 'ANCHOR': anchor(), 'STARFISH': starfish(),
    'SHELL': shell(), 'CRAB': crab(), 'CORAL': coral(), 'ROCK': rock(), 'SUN': sun(), 'CLOUD': cloud(), 'STAR': star(),
}

HEADER = '''/**
 * Pixel art for the home page, as text. Each character is one pixel: `.` is
 * empty and the letters name a colour in PALETTE. Sprite.astro turns a grid
 * into SVG rectangles, so the art scales without blurring.
 *
 * Generated by scripts/draw-sprites.py. Change the drawing there and rerun it.
 */
export const PALETTE: Record<string, string> = {
  '#': '#0b2a3a', // ink, the darkest shade
  d: '#136f7a', // deep water
  m: '#3fc1c0', // aqua
  l: '#d9f5ec', // foam
  c: '#ff6b4a', // coral
  s: '#c9412a', // coral, in shadow
  p: '#ffa38a', // coral, in light
  y: '#ffd23f', // sun and brass
  g: '#d99a1c', // brass, in shadow
  w: '#ffffff',
};
'''
out = [HEADER]
for name, rows in SPRITES.items():
    width = max(len(r) for r in rows)
    out.append(f'\nexport const {name} = [\n' + ''.join(f"  '{r.ljust(width, '.')}',\n" for r in rows) + '];\n')
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'lib', 'sprites.ts')
open(path, 'w').write(''.join(out))
# The favicon is the same art, written out as a standalone SVG on deep water.
COLOURS = {'#': '#0b2a3a', 'c': '#ff6b4a', 's': '#c9412a', 'p': '#ffa38a', 'w': '#ffffff'}
rects = ''.join(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{COLOURS[ch]}"/>'
                for y, row in enumerate(icon()) for x, ch in enumerate(row) if ch in COLOURS)
favicon = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 18 18" shape-rendering="crispEdges">'
           '<rect x="-1" y="-1" width="18" height="18" fill="#3fc1c0"/>' + rects + '</svg>\n')
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'favicon.svg'), 'w').write(favicon)
print('wrote', len(SPRITES), 'sprites and the favicon')


# ---- The README banner: the home page's scene as one standalone SVG ----------------

GLYPHS = {
    'a': ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
    'q': ['.....', '.####', '#...#', '#...#', '.####', '....#', '....#'],
    'u': ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
    'm': ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
    'n': ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
}
HEX = {'#': '#0b2a3a', 'd': '#136f7a', 'm': '#3fc1c0', 'l': '#d9f5ec', 'c': '#ff6b4a', 's': '#c9412a',
       'p': '#ffa38a', 'y': '#ffd23f', 'g': '#d99a1c', 'w': '#ffffff'}

def runs(rows, swap=None):
    """Rectangles for a grid, one per horizontal run of a colour."""
    out = []
    for y, row in enumerate(rows):
        x = 0
        while x < len(row):
            ch = row[x]; end = x
            while end < len(row) and row[end] == ch: end += 1
            colour = (swap or {}).get(ch, HEX.get(ch))
            if colour: out.append(f'<rect x="{x}" y="{y}" width="{end - x}" height="1" fill="{colour}"/>')
            x = end
    return ''.join(out)

def group(rows, x, y, cls='', swap=None):
    return f'<g transform="translate({x} {y})"><g class="{cls}">{runs(rows, swap)}</g></g>'

def banner():
    W, H, SEA = 320, 132, 46
    lit = {'#': HEX['l']}
    parts = [f'<rect width="{W}" height="{SEA}" fill="{HEX["l"]}"/>',
             f'<rect y="{SEA}" width="{W}" height="30" fill="{HEX["m"]}"/>',
             f'<rect y="{SEA + 30}" width="{W}" height="26" fill="{HEX["d"]}"/>',
             f'<rect y="{SEA + 56}" width="{W}" height="{H - SEA - 56}" fill="{HEX["#"]}"/>']
    # Waves along the surface, and a dithered row where each depth meets the next.
    for x in range(0, W, 8):
        parts.append(f'<path fill="{HEX["m"]}" d="M{x + 2} {SEA - 3}h2v1h-2zM{x + 1} {SEA - 2}h4v1h-4zM{x} {SEA - 1}h6v1h-6z"/>')
    for y, colour in ((SEA + 28, HEX['d']), (SEA + 54, HEX['#'])):
        for row in (0, 1):
            cells = ''.join(f'M{x} {y + row}h1v1h-1z' for x in range(row, W, 2))
            parts.append(f'<path fill="{colour}" d="{cells}"/>')
    # The wordmark, drawn in pixels because a README cannot load a font.
    word = []
    for i, letter in enumerate('aquaman'):
        for gy, row in enumerate(GLYPHS[letter]):
            for gx, ch in enumerate(row):
                if ch == '#':
                    word.append(f'<rect x="{14 + i * 18 + gx * 3}" y="{8 + gy * 3}" width="3" height="3" fill="{HEX["#"]}"/>')
    parts.append(''.join(word))
    parts.append(group(sun(), 198, 2))
    parts.append(group(cloud(), 150, 16, 'drift'))
    parts.append(group(cloud(), 262, 6, 'drift slow'))
    # The agent on its raft, and the line it lowers to the tag.
    rob = robot()
    rx = 232
    parts.append(f'<rect x="{rx + 23}" y="{SEA}" width="1" height="48" fill="{HEX["#"]}"/>')
    parts.append(f'<rect x="{rx + 23}" y="{SEA + 48}" width="1" height="18" fill="{HEX["l"]}"/>')
    parts.append(group(tag(), rx + 11, SEA + 64, swap=lit))
    parts.append(group(rob, rx, SEA - len(rob) + 5, 'bob'))
    parts.append(group(fish(), 96, SEA + 10, 'swim'))
    # The keeper and what it keeps.
    octo = octopus()
    parts.append(group(octo, 18, H - len(octo) - 4, 'bob late', swap=lit))
    che = chest()
    parts.append(group(che, 92, H - len(che) - 4, swap=lit))
    parts.append(group(key(), 104, H - len(che) - 18, swap=lit))
    parts.append(group(weed(22, 0.4), 168, H - 24))
    parts.append(group(anchor(), 196, H - 32))
    parts.append(group(weed(18, 1.9), 296, H - 20))
    style = ('<style>'
             '@media (prefers-reduced-motion: no-preference){'
             '.bob{animation:bob 1.6s steps(2,jump-none) infinite}.late{animation-duration:2.4s}'
             '.drift{animation:drift 40s steps(40) infinite alternate}.slow{animation-duration:70s}'
             '.swim{animation:swim 30s steps(60) infinite}}'
             '@keyframes bob{50%{transform:translateY(1px)}}'
             '@keyframes drift{to{transform:translateX(-24px)}}'
             '@keyframes swim{from{transform:translateX(230px)}to{transform:translateX(-130px)}}'
             '</style>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" shape-rendering="crispEdges" role="img" '
            f'aria-labelledby="t"><title id="t">aquaman: an AI agent on a raft at the surface lowers a line; far below, '
            f'an octopus guards the vault and the key</title>{style}{"".join(parts)}</svg>\n')

assets = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'assets')
os.makedirs(assets, exist_ok=True)
open(os.path.join(assets, 'banner.svg'), 'w').write(banner())
print('wrote docs/assets/banner.svg')

