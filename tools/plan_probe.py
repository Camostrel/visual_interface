#!/usr/bin/env python3
"""
plan_probe.py — проверка пары «DXF + SVG» ДО конвертации.

Отвечает на один вопрос: можно ли этот план принимать в работу?
Ничего не пишет, только отчитывается. Конвертер (plan_dxf.py) опирается
на те же проверки, но падает; пробник — показывает картину целиком.

    python3 plan_probe.py "5 этаж.dxf" "5 этаж.svg"

Что проверяет:
  1. DXF: блоки устройств с атрибутами, XData помещений, согласованность NAME.
  2. SVG: слои Illustrator, состав слоя значков.
  3. Единое преобразование DXF -> SVG: подобие ли это (поворот/перекос ~ 0).
  4. Остатки по классам и ОТРЫВ от второго кандидата (доказательство однозначности).
  5. Кросс-проверка на зонах помещений — данных, не участвовавших в вычислении.
"""
import argparse
import collections
import math
import re
import sys
import xml.etree.ElementTree as ET

try:
    import ezdxf
except ImportError:
    sys.exit("нужен ezdxf:  pip install ezdxf")

NS = '{http://www.w3.org/2000/svg}'
ROOM_APPID = 'VISUAL_INTERFACE_ROOM'

# слои DXF, на которых живут устройства (дублируют атрибут TYPE — сверяем оба)
DEVICE_LAYERS = {'Lamp': 'L', 'MS': 'MS', 'KP': 'KP'}


# --------------------------------------------------------------------------- DXF

def read_dxf(path):
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    devices, rooms = [], []
    for ins in msp.query('INSERT'):
        attrs = {a.dxf.tag: a.dxf.text for a in ins.attribs}
        if 'NAME' not in attrs:
            continue
        devices.append({
            'name': attrs['NAME'].strip(),
            'type': attrs.get('TYPE', ''),
            'attrs': attrs,
            'layer': ins.dxf.layer,
            'block': ins.dxf.name,
            'x': float(ins.dxf.insert.x),
            'y': float(ins.dxf.insert.y),
            'rotation': float(ins.dxf.rotation),
            'xscale': float(ins.dxf.xscale),
            'yscale': float(ins.dxf.yscale),
        })
    for pl in msp.query('LWPOLYLINE'):
        try:
            xdata = pl.get_xdata(ROOM_APPID)
        except Exception:
            continue
        fields = dict(t.value.split('=', 1) for t in xdata if '=' in t.value)
        rooms.append({
            'name': fields.get('NAME', ''),
            'floor': fields.get('FLOOR', ''),
            'closed': bool(pl.closed),
            'points': [(float(x), float(y)) for x, y in pl.get_points('xy')],
        })
    return doc, devices, rooms


# --------------------------------------------------------------------------- SVG

def decode_id(raw):
    """Illustrator кодирует спецсимволы в id: _x5F_ -> '_', _x30_ -> '0'."""
    return re.sub(r'_x([0-9A-Fa-f]{2})_', lambda m: chr(int(m.group(1), 16)), raw or '')


def parse_points(raw):
    nums = [float(v) for v in re.split(r'[\s,]+', (raw or '').strip()) if v]
    return list(zip(nums[0::2], nums[1::2]))


def svg_layers(root):
    """Верхнеуровневые <g> = слои Illustrator (декодированное имя -> элемент)."""
    return {decode_id(g.get('id')): g for g in root if g.tag == NS + 'g'}


def shapes_of(layer):
    """Плоский список фигур слоя с центром и габаритом. Групп устройства в
    Illustrator-SVG нет — значок распадается на отдельные примитивы."""
    out = []
    for el in layer.iter():
        tag = el.tag[len(NS):]
        if tag == 'rect':
            x, y, w, h = (float(el.get(a)) for a in ('x', 'y', 'width', 'height'))
            out.append({'el': el, 'tag': tag, 'cx': x + w / 2, 'cy': y + h / 2,
                        'bbox': (x, y, x + w, y + h)})
        elif tag == 'circle':
            cx, cy, r = (float(el.get(a)) for a in ('cx', 'cy', 'r'))
            out.append({'el': el, 'tag': tag, 'cx': cx, 'cy': cy,
                        'bbox': (cx - r, cy - r, cx + r, cy + r)})
        elif tag == 'line':
            x1, y1, x2, y2 = (float(el.get(a)) for a in ('x1', 'y1', 'x2', 'y2'))
            out.append({'el': el, 'tag': tag, 'cx': (x1 + x2) / 2, 'cy': (y1 + y2) / 2,
                        'bbox': (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))})
        elif tag == 'polygon':
            pts = parse_points(el.get('points'))
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            out.append({'el': el, 'tag': tag, 'pts': pts,
                        'cx': sum(xs) / len(xs), 'cy': sum(ys) / len(ys),
                        'bbox': (min(xs), min(ys), max(xs), max(ys))})
        elif tag == 'text':
            m = re.search(r'translate\(([-\d.]+)[\s,]+([-\d.]+)\)', el.get('transform') or '')
            if m:
                out.append({'el': el, 'tag': tag, 'cx': float(m.group(1)), 'cy': float(m.group(2)),
                            'bbox': None, 'text': ''.join(el.itertext()).strip()})
    return out


# ----------------------------------------------------------------- преобразование

def solve_affine(pairs):
    """МНК: (x,y) -> (X,Y), полные 6 параметров. Ограничений на подобие НЕ
    накладываем сознательно — иначе поворот/перекос спрячется в остатки."""
    S = [[0.0] * 3 for _ in range(3)]
    tx, ty = [0.0] * 3, [0.0] * 3
    for (x, y), (X, Y) in pairs:
        v = (x, y, 1.0)
        for i in range(3):
            for j in range(3):
                S[i][j] += v[i] * v[j]
            tx[i] += v[i] * X
            ty[i] += v[i] * Y
    A = [S[i][:] + [tx[i], ty[i]] for i in range(3)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        pivot = A[c][c]
        if abs(pivot) < 1e-30:
            raise ValueError('вырожденная система: опорные точки на одной прямой')
        A[c] = [v / pivot for v in A[c]]
        for r in range(3):
            if r != c and A[r][c]:
                f = A[r][c]
                A[r] = [u - f * w for u, w in zip(A[r], A[c])]
    return (A[0][3], A[1][3], A[2][3], A[0][4], A[1][4], A[2][4])


def apply_m(M, x, y):
    a, b, c, d, e, f = M
    return (a * x + b * y + c, d * x + e * y + f)


def matrix_props(M):
    """Масштабы по осям, поворот и перекос. Перекос считаем как отклонение угла
    между образами осей от прямого — знак определителя (флип Y) на него не влияет."""
    a, b, c, d, e, f = M
    sx, sy = math.hypot(a, d), math.hypot(b, e)
    rot = math.degrees(math.atan2(d, a))
    cos_between = (a * b + d * e) / (sx * sy)
    shear = 90.0 - math.degrees(math.acos(max(-1.0, min(1.0, cos_between))))
    return sx, sy, rot, shear


def fit_transform(dxf_pts, svg_pts, rounds=4):
    """Стартуем от bbox-оценки (масштаб + флип Y), уточняем ближайшим соседом.
    Работает потому, что классы равномощны: 31 датчик <-> 31 кружок."""
    dx = [p[0] for p in dxf_pts]; dy = [p[1] for p in dxf_pts]
    sx = [p[0] for p in svg_pts]; sy = [p[1] for p in svg_pts]
    ax = (max(sx) - min(sx)) / (max(dx) - min(dx))
    ay = (max(sy) - min(sy)) / (max(dy) - min(dy))
    M = (ax, 0.0, min(sx) - min(dx) * ax, 0.0, -ay, max(sy) + min(dy) * ay)
    for _ in range(rounds):
        pairs = []
        for p in dxf_pts:
            q = apply_m(M, *p)
            best = min(svg_pts, key=lambda s: (s[0] - q[0]) ** 2 + (s[1] - q[1]) ** 2)
            pairs.append((p, best))
        M = solve_affine(pairs)
    return M


# ------------------------------------------------------------------ габарит блока

def block_extents(doc, name, _cache={}):
    """Габарит определения блока в его собственных единицах. Реальный размер
    значка задаёт масштаб вставки (лампа — единичный квадрат × 182×1198)."""
    if name in _cache:
        return _cache[name]
    xs, ys = [], []
    for e in doc.blocks.get(name):
        t = e.dxftype()
        if t == 'LWPOLYLINE':
            for x, y in e.get_points('xy'):
                xs.append(x); ys.append(y)
        elif t == 'LINE':
            xs += [e.dxf.start.x, e.dxf.end.x]; ys += [e.dxf.start.y, e.dxf.end.y]
        elif t == 'CIRCLE':
            xs += [e.dxf.center.x - e.dxf.radius, e.dxf.center.x + e.dxf.radius]
            ys += [e.dxf.center.y - e.dxf.radius, e.dxf.center.y + e.dxf.radius]
        elif t == 'ARC':
            xs += [e.dxf.center.x - e.dxf.radius, e.dxf.center.x + e.dxf.radius]
            ys += [e.dxf.center.y - e.dxf.radius, e.dxf.center.y + e.dxf.radius]
    res = (min(xs), min(ys), max(xs), max(ys)) if xs else None
    _cache[name] = res
    return res


# DXF-примитив -> тег, которым его рисует Illustrator
DXF_TO_SVG = {
    'LWPOLYLINE': ('rect', 'polygon', 'polyline', 'path'),
    'POLYLINE': ('rect', 'polygon', 'polyline', 'path'),
    'LINE': ('line',),
    'CIRCLE': ('circle', 'ellipse'),
    'ARC': ('path',),
    'TEXT': ('text',),
    'MTEXT': ('text',),
}


def block_recipe(doc, name, _cache={}):
    """Из чего состоит значок: {тег SVG: сколько}. Блок знает свой состав —
    это и разрешает спор, когда габариты двух устройств пересеклись."""
    if name in _cache:
        return _cache[name]
    recipe = collections.Counter()
    for e in doc.blocks.get(name):
        tags = DXF_TO_SVG.get(e.dxftype())
        if tags:
            recipe[tags[0]] += 1
    _cache[name] = recipe
    return recipe


def device_box(doc, dev, M, pad):
    """Прямоугольник значка в координатах SVG: габарит блока -> масштаб и поворот
    вставки -> общее преобразование. Никаких «примерно рядом»."""
    ext = block_extents(doc, dev['block'])
    if ext is None:
        return None
    x0, y0, x1, y1 = ext
    ins = doc.modelspace()  # noqa: F841  (габарит уже в единицах блока)
    sx, sy = dev['xscale'], dev['yscale']
    rot = math.radians(dev['rotation'])
    cos_r, sin_r = math.cos(rot), math.sin(rot)
    pts = []
    for bx, by in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        mx, my = bx * sx, by * sy
        rx, ry = mx * cos_r - my * sin_r, mx * sin_r + my * cos_r
        pts.append(apply_m(M, dev['x'] + rx, dev['y'] + ry))
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def inside(box, bbox):
    return (box[0] <= bbox[0] and box[1] <= bbox[1]
            and box[2] >= bbox[2] and box[3] >= bbox[3])


# --------------------------------------------------------------------------- отчёт

def head(title):
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dxf')
    ap.add_argument('svg')
    ap.add_argument('--tolerance', type=float, default=0.5,
                    help='допуск на остаток, px (по умолчанию 0.5)')
    args = ap.parse_args()

    problems = []

    # ---- 1. DXF
    head('1. DXF — данные')
    doc, devices, rooms = read_dxf(args.dxf)
    print(f"версия: {doc.dxfversion}   устройств: {len(devices)}   помещений (XData): {len(rooms)}")
    by_type = collections.Counter(d['type'] for d in devices)
    by_block = collections.Counter(d['block'] for d in devices)
    print(f"по TYPE:  {dict(by_type)}")
    print(f"по блоку: {dict(by_block)}")
    print(f"по слою:  {dict(collections.Counter(d['layer'] for d in devices))}")

    # согласованность NAME <-> TYPE.FLOOR.GROUP.NUMBER (ловит опечатки в чертеже)
    bad_name, floors = [], collections.Counter()
    for d in devices:
        a = d['attrs']
        floors[a.get('FLOOR', '?')] += 1
        m = re.fullmatch(r'([A-Za-z]+)\s+(\d+)\.(\d+)\.(\d+)', d['name'])
        if not m:
            bad_name.append((d['name'], 'не разбирается как "T F.G.N"'))
        elif (m.group(1), m.group(2), m.group(3), m.group(4)) != (
                a.get('TYPE'), a.get('FLOOR'), a.get('GROUP'), a.get('NUMBER')):
            bad_name.append((d['name'], f"расходится с атрибутами {a.get('TYPE')}"
                                        f" {a.get('FLOOR')}.{a.get('GROUP')}.{a.get('NUMBER')}"))
    dups = {n: c for n, c in collections.Counter(d['name'] for d in devices).items() if c > 1}
    print(f"NAME согласован с атрибутами: {len(devices) - len(bad_name)}/{len(devices)}")
    for n, why in bad_name:
        print(f"  ⚠ NAME {n!r}: {why}")
    if dups:
        problems.append(f"дубли NAME: {dups} — одинаковых устройств в проекте не бывает")
    print(f"дубли NAME: {dups or 'нет'}")
    # FLOOR намеренно НЕ проверяется: линии по лестнице проходят через этаж,
    # и на плане они законны. Истина — чертёж.
    print(f"FLOOR (справочно, не проверяется): {dict(floors)}")
    for r in rooms:
        if not r['closed']:
            problems.append(f"помещение {r['name']!r}: полилиния не замкнута")
    print(f"помещения: {', '.join(f'{r['name']}({len(r['points'])} вершин)' for r in rooms) or 'нет'}")

    # ---- 2. SVG
    head('2. SVG — графика')
    root = ET.parse(args.svg).getroot()
    layers = svg_layers(root)
    print(f"viewBox: {root.get('viewBox')}")
    print("слои:")
    for name, g in layers.items():
        tags = collections.Counter(el.tag[len(NS):] for el in g.iter()
                                   if el.tag[len(NS):] in ('rect', 'circle', 'line', 'text', 'polygon', 'path'))
        print(f"  {name:18} {dict(tags)}")
    n_tf = len([1 for el in root.iter() if el.get('transform') and el.tag != NS + 'text'])
    print(f"нетекстовых элементов с transform: {n_tf}"
          f"{'  (координаты абсолютные — схлопывать нечего)' if n_tf == 0 else '  ⚠ есть вложенные матрицы'}")

    # ---- 3. преобразование
    head('3. Преобразование DXF -> SVG')
    device_layer = layers.get('0')
    if device_layer is None:
        sys.exit("в SVG нет слоя '0' — значков устройств не найти")
    shapes = shapes_of(device_layer)
    circles = [(s['cx'], s['cy']) for s in shapes if s['tag'] == 'circle']
    ms_pts = [(d['x'], d['y']) for d in devices if d['type'] == 'MS']
    if len(circles) != len(ms_pts) or len(circles) < 3:
        sys.exit(f"опорные точки не сходятся: MS в DXF {len(ms_pts)}, кружков в SVG {len(circles)}")
    M = fit_transform(ms_pts, circles)
    a, b, c, d_, e, f = M
    sx, sy, rot, shear = matrix_props(M)
    print(f"  X = {a:+.10f}·x {b:+.10f}·y {c:+.4f}")
    print(f"  Y = {d_:+.10f}·x {e:+.10f}·y {f:+.4f}")
    print(f"масштаб X={sx:.8f}  Y={sy:.8f}  (расхождение {abs(sx - sy) / sx * 100:.5f} %)")
    print(f"поворот={rot:+.6f}°   перекос={shear:+.6f}°")
    if abs(rot) > 0.01 or abs(shear) > 0.01:
        problems.append(f"преобразование не подобие: поворот {rot:.4f}°, перекос {shear:.4f}° "
                        "— в Illustrator двигали объекты порознь")
    if abs(sx - sy) / sx > 1e-4:
        problems.append(f"масштабы X и Y разошлись ({sx:.8f} vs {sy:.8f}) — план растягивали неравномерно")

    # ---- 4. матчинг по координате
    head('4. Матчинг устройств: захват значка по габариту блока')
    doc_ms = doc  # габариты блоков берём из того же документа
    boxes = {}
    for i, dev in enumerate(devices):
        boxes[i] = device_box(doc_ms, dev, M, args.tolerance)

    # кто кого накрыл габаритом (текст — по точке вставки, bbox у него нет)
    claims = collections.defaultdict(list)
    for k, sh in enumerate(shapes):
        for i, box in boxes.items():
            if not box:
                continue
            hit = (inside(box, sh['bbox']) if sh['bbox'] is not None
                   else box[0] <= sh['cx'] <= box[2] and box[1] <= sh['cy'] <= box[3])
            if hit:
                claims[k].append(i)

    # проход 1: бесспорное. проход 2: спор решает ожидаемый состав значка
    owner, captured = {}, collections.defaultdict(list)
    recipes = {i: block_recipe(doc, dev['block']) for i, dev in enumerate(devices)}
    filled = {i: collections.Counter() for i in boxes}
    for k, cand in claims.items():
        if len(cand) == 1:
            i = cand[0]
            owner[k] = i
            captured[i].append(k)
            filled[i][shapes[k]['tag']] += 1
    disputed = []
    for k, cand in claims.items():
        if len(cand) == 1:
            continue
        tag = shapes[k]['tag']
        hungry = [i for i in cand if filled[i][tag] < recipes[i].get(tag, 0)]
        if len(hungry) == 1:
            i = hungry[0]
            owner[k] = i
            captured[i].append(k)
            filled[i][tag] += 1
        else:
            disputed.append((k, cand, hungry))

    text_shapes = [k for k, s_ in enumerate(shapes) if s_['bbox'] is None]

    per_type = collections.defaultdict(list)
    for i, dev in enumerate(devices):
        per_type[dev['type']].append(len(captured[i]))
    print(f"{'класс':6} {'DXF':>4} {'значков собрано':>16} {'элементов на значок':>22}")
    for t, counts in sorted(per_type.items()):
        found = sum(1 for c in counts if c)
        shape = dict(collections.Counter(counts))
        print(f"{t:6} {len(counts):>4} {found:>16} {str(shape):>22}")
        if found != len(counts):
            problems.append(f"{t}: {len(counts) - found} устройств не нашли своей графики в SVG")
        for i, dev in enumerate(devices):
            if dev['type'] != t:
                continue
            want, got = recipes[i], collections.Counter(shapes[k]['tag'] for k in captured[i])
            if want and got != want:
                problems.append(f"{dev['name']}: состав значка {dict(got)} "
                                f"не совпал с блоком {dev['block']} {dict(want)}")

    if disputed:
        problems.append(f"{len(disputed)} элементов SVG невозможно приписать однозначно "
                        "(габариты пересеклись, состав значка не разрешает спор)")
    orphan = [k for k in range(len(shapes)) if k not in owner]
    print(f"\nэлементов слоя значков: {len(shapes)} (из них {len(text_shapes)} текстовых)")
    print(f"  захвачено устройствами:  {len(owner)}")
    print(f"  разрешено по составу:    "
          f"{sum(1 for k, c in claims.items() if len(c) > 1) - len(disputed)}")
    print(f"  осталось спорных:        {len(disputed)}")
    print(f"  ничьих:                  {len(orphan)}")
    if orphan:
        print("  ⚠ ничьи элементы останутся в плане как обычная графика")

    # остаток: центр захваченной графики против точки вставки
    print(f"\n{'класс':6} {'остаток med':>12} {'остаток max':>12}")
    for t in sorted(per_type):
        res = []
        idxs = [i for i, d_ in enumerate(devices) if d_['type'] == t]
        centers = {i: apply_m(M, devices[i]['x'], devices[i]['y']) for i in idxs}
        for i in idxs:
            ks = captured[i]
            if not ks:
                continue
            geo = [k for k in ks if shapes[k]['bbox'] is not None]
            if not geo:
                continue
            cx = sum((shapes[k]['bbox'][0] + shapes[k]['bbox'][2]) / 2 for k in geo) / len(geo)
            cy = sum((shapes[k]['bbox'][1] + shapes[k]['bbox'][3]) / 2 for k in geo) / len(geo)
            res.append(math.dist((cx, cy), centers[i]))
        if not res:
            continue
        print(f"{t:6} {sorted(res)[len(res) // 2]:>12.5f} {max(res):>12.5f}")
        if max(res) > args.tolerance:
            problems.append(f"{t}: графика смещена на {max(res):.3f} px от точки вставки")

    print("\nЗахват идёт по габариту блока (единичный квадрат лампы × масштаб вставки),\n"
          "а не по «ближайшему элементу» — размер значка известен точно, гадать не о чем.")

    # ---- 5. кросс-проверка на зонах
    head('5. Кросс-проверка: зоны помещений (в подгонке не участвовали)')
    zone_layer = layers.get('zone_area')
    if zone_layer is None or not rooms:
        print("нечего сверять: нет слоя zone_area или помещений с XData")
    else:
        polys = [s for s in shapes_of(zone_layer) if s['tag'] == 'polygon']
        for r in rooms:
            proj = [apply_m(M, x, y) for x, y in r['points']]
            cx = sum(p[0] for p in proj) / len(proj)
            cy = sum(p[1] for p in proj) / len(proj)
            near = min(polys, key=lambda s: math.dist((cx, cy), (s['cx'], s['cy'])), default=None)
            if near is None:
                continue
            err = max(min(math.dist(p, q) for q in near['pts']) for p in proj)
            flag = '' if err <= args.tolerance else '  ⚠'
            print(f"  {r['name']:18} вершин DXF={len(proj)} SVG={len(near['pts'])}"
                  f"   макс.отклонение={err:.5f} px{flag}")
            if err > args.tolerance:
                problems.append(f"зона {r['name']!r}: отклонение {err:.3f} px превышает допуск")

    # ---- итог
    head('ИТОГ')
    if problems:
        print(f"план НЕ принимается, замечаний: {len(problems)}")
        for p in problems:
            print(f"  ✖ {p}")
        return 1
    print("план принимается: преобразование — подобие, матчинг однозначен, "
          "кросс-проверка сошлась.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
