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
    c = Canvas(48, 44)
    cx = 24
    # Eight arms first, so the head overlaps where they join.
    for i in range(8):
        side = i - 3.5
        x0 = cx + side * 3.1
        length = 15 - abs(side) * 1.1
        for t in range(int(length) + 1):
            curl = math.sin(t / 2.6 + i * 0.9) * (1.2 + abs(side) * 0.25)
            x = x0 + side * t * 0.34 + curl
            y = 24 + t
            thick = 3 if t < length - 3 else 2
            for k in range(thick):
                c.set(x + k, y, 's' if k == thick - 1 else 'c')
            if t % 3 == 1 and t > 2:
                c.set(x, y, 'p')  # suckers catch the light
    c.ellipse(cx, 15, 14, 12, 'c')
    # Shadow low on the right, a highlight high on the left.
    for y in range(c.h):
        for x in range(c.w):
            if c.get(x, y) == 'c' and y < 27:
                d = ((x - cx) / 14) ** 2 + ((y - 15) / 12) ** 2
                if d <= 1.0 and (x - cx) / 14 + (y - 15) / 12 > 1.02:
                    c.set(x, y, 's')
    c.ellipse(17, 8, 4, 2, 'p', only='c')
    c.set(13, 11, 'p'); c.set(13, 12, 'p')
    if blink:
        for ex in (15, 27):
            c.rect(ex, 16, 6, 1, 's')
    else:
        for ex in (15, 27):
            c.rect(ex, 12, 6, 7, 'w')
            c.rect(ex + 2, 14, 3, 4, 'd')
            c.set(ex + 2, 14, 'w')
    for x, y in ((21, 21), (22, 22), (23, 22), (24, 22), (25, 22), (26, 21)):
        c.set(x, y, 's')
    c.set(11, 18, 'p'); c.set(12, 19, 'p'); c.set(36, 18, 'p'); c.set(35, 19, 'p')  # cheeks
    c.outline()
    return c.rows()

def chest(open_lid=False):
    c = Canvas(40, 34)
    if open_lid:
        c.rect(6, 4, 28, 9, 's')          # inside of the raised lid
        c.rect(6, 4, 28, 2, 'y'); c.rect(6, 11, 28, 2, 'g')
        c.rect(6, 4, 2, 9, 'y'); c.rect(32, 4, 2, 9, 'y')
        # A heap of coins, with a few sparkles.
        for x in range(8, 32):
            top = 15 - int(2.5 * math.sin((x - 8) / 24 * math.pi)) - (1 if x % 5 == 0 else 0)
            for y in range(top, 18):
                c.set(x, y, 'y' if (x + y) % 4 else 'g')
        for x, y in ((12, 12), (20, 11), (27, 13)):
            c.set(x, y, 'w')
        c.set(16, 12, 'm'); c.set(17, 12, 'm'); c.set(16, 13, 'm')  # a gem
        c.set(24, 12, 'c'); c.set(25, 12, 'c')
        top = 18
    else:
        c.ellipse(20, 12, 14.5, 7, 'c')
        c.rect(5, 12, 30, 8, '.')
        c.ellipse(15, 8, 5, 1.5, 'p', only='c')
        for bx in (9, 19, 29):
            for y in range(4, 12):
                if c.get(bx, y) != '.':
                    c.set(bx, y, 'y'); c.set(bx + 1, y, 'g')
        top = 12
    c.rect(6, top, 28, 12, 'c')
    c.rect(6, top, 28, 2, 'y'); c.rect(6, top + 10, 28, 2, 'g')
    c.rect(6, top + 6, 28, 1, 's')
    for bx in (9, 19, 29):
        c.rect(bx, top, 2, 12, 'y'); c.rect(bx + 1, top + 2, 1, 8, 'g')
    c.rect(31, top + 2, 3, 8, 's')
    c.rect(18, top + 3, 4, 5, 'y'); c.rect(19, top + 5, 2, 2, '#')  # the lock
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
    c = Canvas(34, 34)
    c.rect(16, 1, 2, 3, '#'); c.rect(15, 0, 4, 2, 'y')            # antenna
    c.rect(8, 4, 18, 12, 'l'); c.rect(24, 5, 2, 11, 'm'); c.rect(9, 14, 16, 2, 'm')
    for ex in (11, 19):
        c.rect(ex, 7, 4, 5, '#'); c.set(ex, 7, 'w'); c.set(ex + 1, 7, 'w')
    c.rect(13, 13, 8, 1, '#')
    c.rect(6, 8, 2, 4, 'm'); c.rect(26, 8, 2, 4, 'm')             # ears
    c.rect(11, 17, 12, 7, 'm'); c.rect(21, 17, 2, 7, 'd'); c.rect(14, 19, 6, 3, 'y')
    c.rect(7, 18, 4, 2, 'l'); c.rect(23, 18, 4, 2, 'l')           # arms
    # The raft: three logs lashed together.
    c.rect(1, 25, 32, 5, 'y')
    for x in range(1, 33):
        c.set(x, 29, 'g')
        if x % 11 == 0:
            c.rect(x, 25, 1, 5, 'g')
    c.rect(4, 25, 1, 5, '#'); c.rect(28, 25, 1, 5, '#')
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
print('wrote', len(SPRITES), 'sprites')
