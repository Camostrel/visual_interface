#!/usr/bin/env python3
"""
plan_dxf.py — конвертер планов: DXF (данные) + SVG (графика) -> эталонный план.

    python3 plan_dxf.py "5 этаж.dxf" "5 этаж.svg" -o ../www/visual_interface/assets/floors/5_etazh.svg

Смысл берётся из DXF: имя устройства — атрибут блока, помещение — полилиния
с XData. Графика берётся из SVG. Связывает их единое преобразование координат,
вычисленное по опорному классу и проверенное по остаткам.

Ни одного шага «выбрать который поближе». Если план неоднозначен — конвертер
падает, а не выдаёт правдоподобный результат: перепутанное имя лампы на плане
не видно глазом, оно всплывёт через месяц не тем светом в не той комнате.

Проверить пару, ничего не записывая:  python3 plan_probe.py <dxf> <svg>
"""
import argparse
import collections
import re
import sys
import xml.etree.ElementTree as ET

import plan_core as pc

INDENT = '  '


# ------------------------------------------------------------------ стили CSS

def style_widths(root):
    """Толщины линий из <style> Illustrator: {'st1': '0.26', ...}.

    Толщину сохраняем (по ней видна иерархия: несущая стена толще перегородки),
    а цвет выбрасываем — красит тема интерфейса.
    """
    widths = {}
    for style in root.iter(pc.NS + 'style'):
        css = ''.join(style.itertext())
        for sel, body in re.findall(r'([^{}]+)\{([^}]*)\}', css):
            m = re.search(r'stroke-width:\s*([\d.]+)', body)
            if not m:
                continue
            for cls in re.findall(r'\.([A-Za-z0-9_-]+)', sel):
                widths[cls] = m.group(1)
    return widths


def strip_paint(el, widths):
    """Снять с элемента краску чертежа, оставив толщину линии.

    Толщина остаётся (по ней видна иерархия: несущая стена толще перегородки),
    а цвет заменяется на `currentColor` — красит тема интерфейса.

    Атрибуты `stroke`/`fill` ставим намеренно, хотя floor.css их всё равно
    перебивает (CSS сильнее презентационного атрибута): благодаря им план
    остаётся читаемым сам по себе — открыл файл в браузере и видишь чертёж,
    а не чёрные пятна. Для плана, который живёт отдельно от интерфейса и
    ездит по объектам, это важнее экономии двух атрибутов.
    """
    cls = el.get('class')
    if cls and cls in widths:
        el.set('stroke-width', widths[cls])
    for attr in ('class', 'style'):
        if attr in el.attrib:
            del el.attrib[attr]
    el.set('stroke', 'currentColor')
    el.set('fill', 'none')


# ------------------------------------------------------------------- сборка

def flatten_layer(layer):
    """Illustrator заворачивает каждый примитив в свою <g id="LWPOLYLINE17">.
    Обёртки не несут смысла — распускаем, оставляя сами фигуры."""
    out = []
    for el in list(layer.iter()):
        if el is layer or el.tag == pc.NS + 'g':
            continue
        out.append(el)
    return out


def build_walls(layer, widths):
    g = ET.Element(pc.NS + 'g', {'id': 'walls'})
    for el in flatten_layer(layer):
        strip_paint(el, widths)
        el.set('class', 'plan-wall')
        g.append(el)
    return g


def build_devices(doc, devices, shapes, captured, widths):
    """Значок = <g class="device-node …" data-entity="…"> с графикой внутри.

    Класс и data-entity висят на группе, а не на фигуре: датчик — это кружок
    и буква, панель — шесть элементов. Цвет состояния наследуется внутрь,
    поэтому с самих фигур краска снимается.
    """
    g = ET.Element(pc.NS + 'g', {'id': 'devices'})
    for i, dev in enumerate(devices):
        entity = pc.entity_id_for(dev['name'], dev['type'])
        node = ET.SubElement(g, pc.NS + 'g', {
            'id': entity.split('.', 1)[1],
            'class': f"device-node {pc.TYPE_CLASS.get(dev['type'], '')}".strip(),
            'data-entity': entity,
        })
        for k in sorted(captured.get(i, [])):
            el = shapes[k]['el']
            strip_paint(el, widths)
            if shapes[k]['bbox'] is None:        # текст внутри значка («R» у датчика)
                el.set('fill', 'currentColor')
                el.set('stroke', 'none')
                el.attrib.pop('stroke-width', None)
            node.append(el)
    return g


def build_rooms(rooms, matrix):
    """Зоны рисуем ИЗ ПОЛИЛИНИИ DXF — это фактическая геометрия стен, а не
    прямоугольник «на глаз». Слой zone_area из SVG не используется вовсе:
    он служил независимой сверкой преобразования (см. plan_probe.py §5)."""
    g = ET.Element(pc.NS + 'g', {'id': 'room-zones'})
    for room in rooms:
        rid = pc.room_id_for(room['name'])
        pts = [pc.apply_matrix(matrix, x, y) for x, y in room['points']]
        d = 'M ' + ' L '.join(f'{x:.2f},{y:.2f}' for x, y in pts) + ' Z'
        ET.SubElement(g, pc.NS + 'path', {
            'id': rid, 'class': 'room-zone', 'data-room-id': rid, 'd': d,
            'fill': 'none', 'stroke': 'currentColor', 'stroke-width': '0.5',
        })
    return g


def content_viewbox(groups, margin=0.02):
    """viewBox по фактическому содержимому плана.

    Illustrator отдаёт холст (1920×1080), в который чертёж вписан с запасом —
    на планшете это значит поля вместо плана. Считаем габарит того, что
    реально нарисовано, и добавляем поле в 2 %.
    """
    xs, ys = [], []
    for g in groups:
        for el in g.iter():
            tag = el.tag[len(pc.NS):] if el.tag.startswith(pc.NS) else el.tag
            try:
                if tag == 'line':
                    xs += [float(el.get('x1')), float(el.get('x2'))]
                    ys += [float(el.get('y1')), float(el.get('y2'))]
                elif tag == 'rect':
                    x, y = float(el.get('x')), float(el.get('y'))
                    xs += [x, x + float(el.get('width'))]
                    ys += [y, y + float(el.get('height'))]
                elif tag == 'circle':
                    cx, cy, r = (float(el.get(a)) for a in ('cx', 'cy', 'r'))
                    xs += [cx - r, cx + r]; ys += [cy - r, cy + r]
                elif tag == 'path':
                    nums = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', el.get('d') or '')]
                    xs += nums[0::2]; ys += nums[1::2]
                elif tag in ('polygon', 'polyline'):
                    pts = pc.parse_points(el.get('points'))
                    xs += [p[0] for p in pts]; ys += [p[1] for p in pts]
            except (TypeError, ValueError):
                continue
    if not xs:
        return None
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    pad = max(w, h) * margin
    return (min(xs) - pad, min(ys) - pad, w + 2 * pad, h + 2 * pad)


def indent(el, level=0):
    pad = '\n' + INDENT * level
    if len(el):
        if not (el.text or '').strip():
            el.text = pad + INDENT
        for child in el:
            indent(child, level + 1)
            if not (child.tail or '').strip():
                child.tail = pad + INDENT
        if not (el[-1].tail or '').strip():
            el[-1].tail = pad
    if level and not (el.tail or '').strip():
        el.tail = pad


# ---------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dxf')
    ap.add_argument('svg')
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--tolerance', type=float, default=0.5,
                    help='допуск на остаток матчинга, px (по умолчанию 0.5)')
    ap.add_argument('--keep-room-labels', action='store_true',
                    help='оставить текстовые подписи помещений из чертежа')
    ap.add_argument('--keep-viewbox', action='store_true',
                    help='оставить viewBox исходника, не поджимать под содержимое')
    args = ap.parse_args()

    try:
        doc, devices, rooms = pc.read_dxf(args.dxf)
        warnings = pc.check_names(devices)
        tree, root = pc.read_svg(args.svg)
        layers = pc.svg_layers(root)
        for need in (pc.DEVICE_LAYER, pc.WALL_LAYER):
            if need not in layers:
                raise pc.PlanError(f"в SVG нет слоя {need!r}")

        shapes = pc.shapes_of(layers[pc.DEVICE_LAYER])
        matrix = pc.build_transform(doc, devices, shapes)
        sx, sy, rot, shear = pc.matrix_props(matrix)
        if abs(rot) > 0.01 or abs(shear) > 0.01:
            raise pc.PlanError(
                f"преобразование не подобие (поворот {rot:.4f}°, перекос {shear:.4f}°): "
                "в Illustrator слои двигали порознь — единого transform не существует")
        if abs(sx - sy) / sx > 1e-4:
            raise pc.PlanError(f"масштабы осей разошлись ({sx:.8f} vs {sy:.8f}): "
                               "план растягивали неравномерно")

        boxes, claims, captured, disputed = pc.match_devices(
            doc, devices, shapes, matrix, args.tolerance)
        if disputed:
            raise pc.PlanError(
                f"{len(disputed)} элементов графики не приписать однозначно — "
                "габариты значков пересеклись, состав блока спор не разрешает")
        for i, dev in enumerate(devices):
            want = pc.block_recipe(doc, dev['block'])
            got = collections.Counter(shapes[k]['tag'] for k in captured.get(i, []))
            if want and got != want:
                raise pc.PlanError(f"{dev['name']}: собрано {dict(got)}, а блок "
                                   f"{dev['block']} состоит из {dict(want)}")
        for t in sorted({d['type'] for d in devices}):
            res = pc.residuals(devices, shapes, captured, matrix, dev_type=t)
            if res and max(res) > args.tolerance:
                raise pc.PlanError(f"{t}: графика разошлась с точкой вставки на "
                                   f"{max(res):.3f} px (допуск {args.tolerance})")
    except pc.PlanError as exc:
        sys.exit(f"план не годен: {exc}\n"
                 f"подробности:  python3 plan_probe.py {args.dxf!r} {args.svg!r}")

    widths = style_widths(root)
    out = ET.Element(pc.NS + 'svg', {
        'version': '1.1',
        'viewBox': root.get('viewBox') or '0 0 1920 1080',
    })
    out.append(build_walls(layers[pc.WALL_LAYER], widths))
    out.append(build_devices(doc, devices, shapes, captured, widths))
    if args.keep_room_labels and 'Room_number' in layers:
        g = ET.Element(pc.NS + 'g', {'id': 'room-labels'})
        for el in flatten_layer(layers['Room_number']):
            strip_paint(el, widths)
            el.set('class', 'plan-label')
            g.append(el)
        out.append(g)
    if rooms:
        out.append(build_rooms(rooms, matrix))

    if not args.keep_viewbox:
        box = content_viewbox(list(out))
        if box:
            out.set('viewBox', ' '.join(f'{v:.2f}' for v in box))

    indent(out)
    ET.ElementTree(out).write(args.output, encoding='utf-8', xml_declaration=True)

    by_type = collections.Counter(d['type'] for d in devices)
    print(f"план записан: {args.output}")
    print(f"  устройств:  " + ", ".join(f"{t}={n}" for t, n in sorted(by_type.items()))
          + f"  (всего {len(devices)})")
    print(f"  помещений:  {len(rooms)}" + (f" ({', '.join(pc.room_id_for(r['name']) for r in rooms)})" if rooms else ""))
    print(f"  viewBox:    {out.get('viewBox')}"
          + ("" if args.keep_viewbox else f"   (исходный {root.get('viewBox')})"))
    print(f"  масштаб:    {sx:.8f}   поворот {rot:+.6f}°   перекос {shear:+.6f}°")
    print(f"  остаток:    max "
          f"{max(pc.residuals(devices, shapes, captured, matrix), default=0):.5f} px")
    unclaimed = len(shapes) - len(claims)
    if unclaimed:
        print(f"  ⚠ {unclaimed} элементов слоя значков не принадлежат ни одному устройству "
              "— в план они не попали")
    for w in warnings:
        print(f"  ⚠ {w}")
    print("\nСущности в HA конвертер не проверяет: план универсален и самодостаточен,\n"
          "«нет такой сущности/area» — забота интерфейса.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
