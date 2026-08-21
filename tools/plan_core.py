#!/usr/bin/env python3
"""
plan_core.py — общее ядро конвейера планов: чтение DXF, чтение SVG,
единое преобразование координат и сборка значков устройств.

Здесь живёт всё, что должно считаться ОДИНАКОВО в приёмке (plan_probe.py)
и в конвертации (plan_dxf.py) — иначе пробник однажды примет план, который
конвертер соберёт иначе.

Принцип, на котором всё держится: смысл (имена, помещения) берётся из DXF,
графика — из SVG, связывает их единое преобразование координат. Ни одного
шага «выбрать который поближе»: при неоднозначности поднимается PlanError.
"""
import collections
import math
import re
import xml.etree.ElementTree as ET

try:
    import ezdxf
except ImportError as exc:                                   # pragma: no cover
    raise SystemExit("нужен ezdxf:  pip install ezdxf") from exc

SVG_NS = 'http://www.w3.org/2000/svg'
NS = '{%s}' % SVG_NS

#: appid, которым AutoCAD-LISP помечает полилинии помещений
ROOM_APPID = 'VISUAL_INTERFACE_ROOM'

#: TYPE устройства -> домен сущности Home Assistant.
#: Датчик движения и освещённости — ОДНО устройство: на плане одна точка `ms_`,
#: парную `il_` интерфейс находит сам по общему device_id.
TYPE_DOMAIN = {
    'L': 'light',
    'MS': 'sensor',
    'KP': 'event',
}

#: CSS-класс значка по TYPE (интерфейс красит по нему, см. css/floor.css)
TYPE_CLASS = {
    'L': 'device-light',
    'MS': 'device-sensor',
    'KP': 'device-panel',
}

#: чем Illustrator рисует примитив DXF (первый тег — основной)
DXF_TO_SVG = {
    'LWPOLYLINE': ('rect', 'polygon', 'polyline', 'path'),
    'POLYLINE': ('rect', 'polygon', 'polyline', 'path'),
    'LINE': ('line',),
    'CIRCLE': ('circle', 'ellipse'),
    'ARC': ('path',),
    'TEXT': ('text',),
    'MTEXT': ('text',),
}

#: слой Illustrator, куда попадают значки устройств (слой «0» из AutoCAD)
DEVICE_LAYER = '0'
ZONE_LAYER = 'zone_area'
WALL_LAYER = 'wall'
#: слои подписей: имена теперь в данных, из плана они удаляются
LABEL_LAYERS = ('Lamp_number', 'Sensor_number', 'Panel_number')


class PlanError(Exception):
    """План не годен. Не «взяли что поближе», а честный отказ."""


# ============================================================== имена устройств

def entity_id_for(name, dev_type):
    """`L 5.4.27` + TYPE=L  ->  `light.l_5_4_27`.

    Домен определяется по TYPE (атрибуту чертежа), а не по букве в имени:
    буква — то, как устройство подписано, TYPE — то, что оно есть.
    Незнакомый TYPE — ошибка, а не догадка.
    """
    domain = TYPE_DOMAIN.get(dev_type)
    if domain is None:
        raise PlanError(f"{name!r}: неизвестный TYPE={dev_type!r}, "
                        f"известны {', '.join(sorted(TYPE_DOMAIN))}")
    slug = re.sub(r'[^a-z0-9]+', '_', name.strip().lower()).strip('_')
    if not slug:
        raise PlanError(f"{name!r}: из имени не получается entity_id")
    return f"{domain}.{slug}"


def room_id_for(name):
    """`501_kabinet` -> `501_kabinet`. Совпадение с area_id в Home Assistant —
    зона проектировщика; конвертер к HA не обращается и ничего не сверяет."""
    slug = re.sub(r'[^a-z0-9]+', '_', (name or '').strip().lower()).strip('_')
    if not slug:
        raise PlanError(f"помещение {name!r}: пустое имя в XData")
    return slug


# ========================================================================= DXF

def read_dxf(path):
    """Возвращает (doc, devices, rooms).

    Устройство — INSERT с атрибутом NAME. Помещение — LWPOLYLINE с XData
    VISUAL_INTERFACE_ROOM. Всё остальное в DXF нас не касается: графику
    рисует SVG.
    """
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()

    devices = []
    for ins in msp.query('INSERT'):
        attrs = {a.dxf.tag: a.dxf.text for a in ins.attribs}
        name = (attrs.get('NAME') or '').strip()
        if not name:
            continue
        devices.append({
            'name': name,
            'type': (attrs.get('TYPE') or '').strip(),
            'attrs': attrs,
            'block': ins.dxf.name,
            'layer': ins.dxf.layer,
            'x': float(ins.dxf.insert.x),
            'y': float(ins.dxf.insert.y),
            'xscale': float(ins.dxf.xscale),
            'yscale': float(ins.dxf.yscale),
            'rotation': float(ins.dxf.rotation),
        })

    rooms = []
    for pl in msp.query('LWPOLYLINE'):
        try:
            xdata = pl.get_xdata(ROOM_APPID)
        except Exception:
            continue
        fields = dict(t.value.split('=', 1) for t in xdata if '=' in str(t.value))
        rooms.append({
            'name': fields.get('NAME', ''),
            'floor': fields.get('FLOOR', ''),
            'closed': bool(pl.closed),
            'points': [(float(x), float(y)) for x, y in pl.get_points('xy')],
        })
    return doc, devices, rooms


def check_names(devices):
    """Единственная проверка данных чертежа — дубли NAME: одинаковых устройств
    в проекте не бывает, дубль всегда недосмотр.

    Этаж (FLOOR) НЕ проверяется: линии, идущие по лестнице, законно приходят
    на план соседнего этажа. Чертёж — истина.

    Возвращает список предупреждений; на дубли поднимает PlanError.
    """
    dups = {n: c for n, c in collections.Counter(d['name'] for d in devices).items() if c > 1}
    if dups:
        raise PlanError("дубли NAME: " + ", ".join(f"{n} ×{c}" for n, c in sorted(dups.items())))

    warnings = []
    for d in devices:
        a = d['attrs']
        m = re.fullmatch(r'([A-Za-z]+)\s+(\d+)\.(\d+)\.(\d+)', d['name'])
        if not m:
            warnings.append(f"{d['name']!r}: имя не разбирается как «T F.G.N»")
        elif m.groups() != (a.get('TYPE'), a.get('FLOOR'), a.get('GROUP'), a.get('NUMBER')):
            warnings.append(f"{d['name']!r}: расходится с атрибутами "
                            f"{a.get('TYPE')} {a.get('FLOOR')}.{a.get('GROUP')}.{a.get('NUMBER')}")
    return warnings


# ================================================================ габарит блока

def block_extents(doc, name, _cache=None):
    """Габарит определения блока в его собственных единицах.

    Реальный размер значка = этот габарит × масштаб вставки: лампа нарисована
    единичным квадратом и растягивается вставкой в 182×1198.
    """
    cache = doc.__dict__.setdefault('_arvid_extents', {})
    if name in cache:
        return cache[name]
    xs, ys = [], []
    for e in doc.blocks.get(name):
        t = e.dxftype()
        if t in ('LWPOLYLINE', 'POLYLINE'):
            for pt in e.get_points('xy') if t == 'LWPOLYLINE' else [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]:
                xs.append(pt[0]); ys.append(pt[1])
        elif t == 'LINE':
            xs += [e.dxf.start.x, e.dxf.end.x]
            ys += [e.dxf.start.y, e.dxf.end.y]
        elif t in ('CIRCLE', 'ARC'):
            xs += [e.dxf.center.x - e.dxf.radius, e.dxf.center.x + e.dxf.radius]
            ys += [e.dxf.center.y - e.dxf.radius, e.dxf.center.y + e.dxf.radius]
    cache[name] = (min(xs), min(ys), max(xs), max(ys)) if xs else None
    return cache[name]


def block_recipe(doc, name):
    """Из чего состоит значок: {тег SVG: сколько}.

    Это знание разрешает единственный спорный случай: длинный светильник
    накрывает габаритом текст соседнего датчика. У лампы в составе текста нет —
    значит и претендовать ей не на что.
    """
    cache = doc.__dict__.setdefault('_arvid_recipes', {})
    if name not in cache:
        recipe = collections.Counter()
        for e in doc.blocks.get(name):
            tags = DXF_TO_SVG.get(e.dxftype())
            if tags:
                recipe[tags[0]] += 1
        cache[name] = recipe
    return cache[name]


def device_box(doc, dev, matrix, pad):
    """Прямоугольник значка в координатах SVG.

    Габарит блока -> масштаб и поворот вставки -> общее преобразование.
    Размер значка известен точно, поэтому захват графики — не «что рядом»,
    а «что внутри».
    """
    ext = block_extents(doc, dev['block'])
    if ext is None:
        return None
    x0, y0, x1, y1 = ext
    sx, sy = dev['xscale'], dev['yscale']
    rot = math.radians(dev['rotation'])
    cos_r, sin_r = math.cos(rot), math.sin(rot)
    pts = []
    for bx, by in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        mx, my = bx * sx, by * sy
        pts.append(apply_matrix(matrix,
                                dev['x'] + mx * cos_r - my * sin_r,
                                dev['y'] + mx * sin_r + my * cos_r))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


# ========================================================================= SVG

def decode_id(raw):
    """Illustrator кодирует спецсимволы в id: `_x5F_` -> `_`, `_x30_` -> `0`."""
    return re.sub(r'_x([0-9A-Fa-f]{2})_', lambda m: chr(int(m.group(1), 16)), raw or '')


def parse_points(raw):
    """`points` у polygon приходит без запятых: «x y x y»."""
    nums = [float(v) for v in re.split(r'[\s,]+', (raw or '').strip()) if v]
    return list(zip(nums[0::2], nums[1::2]))


def read_svg(path):
    ET.register_namespace('', SVG_NS)
    tree = ET.parse(path)
    return tree, tree.getroot()


def svg_layers(root):
    """Верхнеуровневые <g> — это слои Illustrator (декодированное имя -> элемент)."""
    return {decode_id(g.get('id')): g for g in root if g.tag == NS + 'g'}


def shapes_of(layer):
    """Плоский список фигур слоя: центр, габарит, родитель.

    Групп устройства в Illustrator-SVG нет — значок распадается на примитивы,
    поэтому собирать группу приходится конвертеру.
    """
    out = []
    for parent in layer.iter():
        for el in list(parent):
            tag = el.tag[len(NS):] if el.tag.startswith(NS) else el.tag
            shape = {'el': el, 'parent': parent, 'tag': tag, 'bbox': None}
            try:
                if tag == 'rect':
                    x, y, w, h = (float(el.get(a)) for a in ('x', 'y', 'width', 'height'))
                    shape.update(cx=x + w / 2, cy=y + h / 2, bbox=(x, y, x + w, y + h))
                elif tag == 'circle':
                    cx, cy, r = (float(el.get(a)) for a in ('cx', 'cy', 'r'))
                    shape.update(cx=cx, cy=cy, bbox=(cx - r, cy - r, cx + r, cy + r))
                elif tag == 'ellipse':
                    cx, cy, rx, ry = (float(el.get(a)) for a in ('cx', 'cy', 'rx', 'ry'))
                    shape.update(cx=cx, cy=cy, bbox=(cx - rx, cy - ry, cx + rx, cy + ry))
                elif tag == 'line':
                    x1, y1, x2, y2 = (float(el.get(a)) for a in ('x1', 'y1', 'x2', 'y2'))
                    shape.update(cx=(x1 + x2) / 2, cy=(y1 + y2) / 2,
                                 bbox=(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))
                elif tag in ('polygon', 'polyline'):
                    pts = parse_points(el.get('points'))
                    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                    shape.update(pts=pts, cx=sum(xs) / len(xs), cy=sum(ys) / len(ys),
                                 bbox=(min(xs), min(ys), max(xs), max(ys)))
                elif tag == 'text':
                    m = re.search(r'translate\(([-\d.]+)[\s,]+([-\d.]+)\)', el.get('transform') or '')
                    if not m:
                        continue
                    # у текста габарита нет — только точка вставки
                    shape.update(cx=float(m.group(1)), cy=float(m.group(2)),
                                 text=''.join(el.itertext()).strip())
                else:
                    continue
            except (TypeError, ValueError, ZeroDivisionError):
                continue
            out.append(shape)
    return out


# =============================================================== преобразование

def solve_affine(pairs):
    """МНК: (x,y) -> (X,Y), все 6 параметров.

    Подобие НЕ навязываем: пусть поворот и перекос проявятся в матрице, где их
    видно, а не спрячутся в остатки.
    """
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
        if abs(A[c][c]) < 1e-30:
            raise PlanError("опорные точки вырождены (лежат на одной прямой)")
        pivot = A[c][c]
        A[c] = [v / pivot for v in A[c]]
        for r in range(3):
            if r != c and A[r][c]:
                f = A[r][c]
                A[r] = [u - f * w for u, w in zip(A[r], A[c])]
    return (A[0][3], A[1][3], A[2][3], A[0][4], A[1][4], A[2][4])


def apply_matrix(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + b * y + c, d * x + e * y + f)


def matrix_props(m):
    """Масштабы, поворот и перекос. Перекос — отклонение угла между образами
    осей от прямого; флип Y (отрицательный определитель) на него не влияет."""
    a, b, c, d, e, f = m
    sx, sy = math.hypot(a, d), math.hypot(b, e)
    rot = math.degrees(math.atan2(d, a))
    cos_between = (a * b + d * e) / (sx * sy)
    shear = 90.0 - math.degrees(math.acos(max(-1.0, min(1.0, cos_between))))
    return sx, sy, rot, shear


def fit_transform(dxf_pts, svg_pts, rounds=4):
    """Единое преобразование по опорному классу равной мощности.

    Стартуем от габаритной оценки (масштаб + флип Y), уточняем ближайшим
    соседом. Опорный класс — датчики: их немного, они разбросаны по плану и
    стоят поодиночке, поэтому первая же итерация попадает в цель.
    """
    if len(dxf_pts) < 3:
        raise PlanError(f"опорных точек мало ({len(dxf_pts)}), нужно хотя бы 3")
    dx = [p[0] for p in dxf_pts]; dy = [p[1] for p in dxf_pts]
    sx = [p[0] for p in svg_pts]; sy = [p[1] for p in svg_pts]
    if max(dx) == min(dx) or max(dy) == min(dy):
        raise PlanError("опорные точки вытянуты в линию — преобразование не определить")
    ax = (max(sx) - min(sx)) / (max(dx) - min(dx))
    ay = (max(sy) - min(sy)) / (max(dy) - min(dy))
    m = (ax, 0.0, min(sx) - min(dx) * ax, 0.0, -ay, max(sy) + min(dy) * ay)
    for _ in range(rounds):
        pairs = []
        for p in dxf_pts:
            q = apply_matrix(m, *p)
            best = min(svg_pts, key=lambda s: (s[0] - q[0]) ** 2 + (s[1] - q[1]) ** 2)
            pairs.append((p, best))
        m = solve_affine(pairs)
    return m


def build_transform(doc, devices, shapes, anchor_type='MS'):
    """Опорный класс -> matrix. Требует равной мощности: столько же значков
    в SVG, сколько устройств в DXF, иначе опоры недостоверны."""
    anchors = [(d['x'], d['y']) for d in devices if d['type'] == anchor_type]
    tag = DXF_TO_SVG.get('CIRCLE')[0] if anchor_type == 'MS' else None
    targets = [(s['cx'], s['cy']) for s in shapes if s['tag'] == tag]
    if not anchors:
        raise PlanError(f"в DXF нет устройств типа {anchor_type} — не от чего плясать")
    if len(anchors) != len(targets):
        raise PlanError(f"опоры не сходятся: {anchor_type} в DXF {len(anchors)}, "
                        f"<{tag}> в SVG {len(targets)}")
    return fit_transform(anchors, targets)


# ===================================================================== матчинг

def inside(box, bbox):
    return (box[0] <= bbox[0] and box[1] <= bbox[1]
            and box[2] >= bbox[2] and box[3] >= bbox[3])


def match_devices(doc, devices, shapes, matrix, tolerance):
    """Кто из фигур SVG кому принадлежит.

    Проход 1 — бесспорное (фигура попала в габарит ровно одного устройства).
    Проход 2 — спор решает состав блока: претендует тот, у кого место под такой
    примитив ещё не занято.

    Возвращает (captured, disputed): captured[i] — индексы фигур устройства i.
    Ни одного «выберем поближе»: неразрешённый спор возвращается как есть,
    вызывающий решает — предупредить (пробник) или упасть (конвертер).
    """
    boxes = {i: device_box(doc, d, matrix, tolerance) for i, d in enumerate(devices)}
    claims = collections.defaultdict(list)
    for k, sh in enumerate(shapes):
        for i, box in boxes.items():
            if not box:
                continue
            hit = (inside(box, sh['bbox']) if sh['bbox'] is not None
                   else box[0] <= sh['cx'] <= box[2] and box[1] <= sh['cy'] <= box[3])
            if hit:
                claims[k].append(i)

    captured = collections.defaultdict(list)
    filled = {i: collections.Counter() for i in boxes}
    for k, cand in claims.items():
        if len(cand) == 1:
            captured[cand[0]].append(k)
            filled[cand[0]][shapes[k]['tag']] += 1

    disputed = []
    for k, cand in claims.items():
        if len(cand) == 1:
            continue
        tag = shapes[k]['tag']
        hungry = [i for i in cand
                  if filled[i][tag] < block_recipe(doc, devices[i]['block']).get(tag, 0)]
        if len(hungry) == 1:
            captured[hungry[0]].append(k)
            filled[hungry[0]][tag] += 1
        else:
            disputed.append((k, cand))
    return boxes, claims, captured, disputed


def residuals(devices, shapes, captured, matrix, dev_type=None):
    """Насколько центр собранной графики разошёлся с точкой вставки блока.
    Текст в центроид не берём: у него точка — базовая линия, а не центр."""
    out = []
    for i, dev in enumerate(devices):
        if dev_type and dev['type'] != dev_type:
            continue
        geo = [k for k in captured.get(i, []) if shapes[k]['bbox'] is not None]
        if not geo:
            continue
        cx = sum((shapes[k]['bbox'][0] + shapes[k]['bbox'][2]) / 2 for k in geo) / len(geo)
        cy = sum((shapes[k]['bbox'][1] + shapes[k]['bbox'][3]) / 2 for k in geo) / len(geo)
        out.append(math.dist((cx, cy), apply_matrix(matrix, dev['x'], dev['y'])))
    return out
