#!/usr/bin/env python3
"""
plan_probe.py — проверка пары «DXF + SVG» ДО конвертации.

Отвечает на один вопрос: можно ли этот план принимать в работу? Ничего не
пишет. Код возврата 1, если план не годен.

    python3 plan_probe.py "5 этаж.dxf" "5 этаж.svg"

Считает ровно тем же кодом, что и конвертер (plan_core.py) — иначе пробник
однажды примет план, который конвертер соберёт иначе.
"""
import argparse
import collections
import math
import sys

import plan_core as pc


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

    # ------------------------------------------------------------------ 1. DXF
    head('1. DXF — данные')
    try:
        doc, devices, rooms = pc.read_dxf(args.dxf)
    except pc.PlanError as exc:
        sys.exit(f"DXF не читается: {exc}")
    print(f"версия: {doc.dxfversion}   устройств: {len(devices)}   "
          f"помещений (XData): {len(rooms)}")
    print(f"по TYPE:  {dict(collections.Counter(d['type'] for d in devices))}")
    print(f"по блоку: {dict(collections.Counter(d['block'] for d in devices))}")
    print(f"по слою:  {dict(collections.Counter(d['layer'] for d in devices))}")

    try:
        warnings = pc.check_names(devices)
    except pc.PlanError as exc:
        problems.append(str(exc))
        warnings = []
    print(f"дубли NAME: {'ЕСТЬ — см. итог' if problems else 'нет'}")
    for w in warnings:
        print(f"  ⚠ {w}")
    # FLOOR намеренно не проверяется: линии по лестнице законно приходят
    # на план соседнего этажа. Чертёж — истина.
    print("FLOOR (справочно, не проверяется): "
          f"{dict(collections.Counter(d['attrs'].get('FLOOR', '?') for d in devices))}")

    for r in rooms:
        if not r['closed']:
            problems.append(f"помещение {r['name']!r}: полилиния не замкнута")
    print("помещения: " + (", ".join(f"{r['name']}({len(r['points'])} вершин)"
                                     for r in rooms) or "нет"))

    # ------------------------------------------------------------------ 2. SVG
    head('2. SVG — графика')
    tree, root = pc.read_svg(args.svg)
    layers = pc.svg_layers(root)
    print(f"viewBox: {root.get('viewBox')}")
    print("слои:")
    for name, g in layers.items():
        tags = collections.Counter(el.tag[len(pc.NS):] for el in g.iter()
                                   if el.tag.startswith(pc.NS)
                                   and el.tag[len(pc.NS):] in
                                   ('rect', 'circle', 'line', 'text', 'polygon', 'path'))
        print(f"  {name:18} {dict(tags)}")
    for need in (pc.DEVICE_LAYER, pc.WALL_LAYER):
        if need not in layers:
            problems.append(f"в SVG нет слоя {need!r}")
    n_tf = len([1 for el in root.iter()
                if el.get('transform') and not el.tag.endswith('}text')])
    print(f"нетекстовых элементов с transform: {n_tf}"
          + ("  (координаты абсолютные — схлопывать нечего)" if n_tf == 0
             else "  ⚠ есть вложенные матрицы"))

    if pc.DEVICE_LAYER not in layers:
        head('ИТОГ')
        print("план НЕ принимается: без слоя значков дальше идти некуда")
        return 1

    # -------------------------------------------------------- 3. преобразование
    head('3. Преобразование DXF -> SVG')
    shapes = pc.shapes_of(layers[pc.DEVICE_LAYER])
    try:
        M = pc.build_transform(doc, devices, shapes)
    except pc.PlanError as exc:
        head('ИТОГ')
        print(f"план НЕ принимается: {exc}")
        return 1
    a, b, c, d_, e, f = M
    sx, sy, rot, shear = pc.matrix_props(M)
    print(f"  X = {a:+.10f}·x {b:+.10f}·y {c:+.4f}")
    print(f"  Y = {d_:+.10f}·x {e:+.10f}·y {f:+.4f}")
    print(f"масштаб X={sx:.8f}  Y={sy:.8f}  (расхождение {abs(sx - sy) / sx * 100:.5f} %)")
    print(f"поворот={rot:+.6f}°   перекос={shear:+.6f}°")
    if abs(rot) > 0.01 or abs(shear) > 0.01:
        problems.append(f"преобразование не подобие: поворот {rot:.4f}°, перекос {shear:.4f}° "
                        "— в Illustrator двигали объекты порознь")
    if abs(sx - sy) / sx > 1e-4:
        problems.append(f"масштабы X и Y разошлись ({sx:.8f} vs {sy:.8f}) "
                        "— план растягивали неравномерно")

    # ---------------------------------------------------------------- 4. матчинг
    head('4. Матчинг устройств: захват значка по габариту блока')
    boxes, claims, captured, disputed = pc.match_devices(doc, devices, shapes, M, args.tolerance)

    per_type = collections.defaultdict(list)
    for i, dev in enumerate(devices):
        per_type[dev['type']].append(len(captured.get(i, [])))
    print(f"{'класс':6} {'DXF':>4} {'значков собрано':>16} {'элементов на значок':>22}")
    for t, counts in sorted(per_type.items()):
        found = sum(1 for cnt in counts if cnt)
        print(f"{t:6} {len(counts):>4} {found:>16} "
              f"{str(dict(collections.Counter(counts))):>22}")
        if found != len(counts):
            problems.append(f"{t}: {len(counts) - found} устройств не нашли графики в SVG")
    for i, dev in enumerate(devices):
        want = pc.block_recipe(doc, dev['block'])
        got = collections.Counter(shapes[k]['tag'] for k in captured.get(i, []))
        if want and got != want:
            problems.append(f"{dev['name']}: состав значка {dict(got)} не совпал "
                            f"с блоком {dev['block']} {dict(want)}")

    texts = sum(1 for s in shapes if s['bbox'] is None)
    owned = sum(len(v) for v in captured.values())
    resolved = sum(1 for cand in claims.values() if len(cand) > 1) - len(disputed)
    print(f"\nэлементов слоя значков: {len(shapes)} (из них {texts} текстовых)")
    print(f"  захвачено устройствами:  {owned}")
    print(f"  разрешено по составу:    {resolved}")
    print(f"  осталось спорных:        {len(disputed)}")
    print(f"  ничьих:                  {len(shapes) - len(claims)}")
    if disputed:
        problems.append(f"{len(disputed)} элементов SVG не приписать однозначно "
                        "(габариты пересеклись, состав значка спор не разрешает)")
    if len(shapes) - len(claims):
        print("  ⚠ ничьи элементы останутся в плане обычной графикой")

    print(f"\n{'класс':6} {'остаток med':>12} {'остаток max':>12}")
    for t in sorted(per_type):
        res = pc.residuals(devices, shapes, captured, M, dev_type=t)
        if not res:
            continue
        print(f"{t:6} {sorted(res)[len(res) // 2]:>12.5f} {max(res):>12.5f}")
        if max(res) > args.tolerance:
            problems.append(f"{t}: графика смещена на {max(res):.3f} px от точки вставки")

    print("\nЗахват идёт по габариту блока (единичный квадрат лампы × масштаб вставки),\n"
          "а не по «ближайшему элементу» — размер значка известен точно, гадать не о чем.")

    # ------------------------------------------------------- 5. кросс-проверка
    head('5. Кросс-проверка: зоны помещений (в подгонке не участвовали)')
    if pc.ZONE_LAYER not in layers or not rooms:
        print("нечего сверять: нет слоя zone_area или помещений с XData")
    else:
        polys = [s for s in pc.shapes_of(layers[pc.ZONE_LAYER]) if s['tag'] == 'polygon']
        for r in rooms:
            proj = [pc.apply_matrix(M, x, y) for x, y in r['points']]
            cx = sum(p[0] for p in proj) / len(proj)
            cy = sum(p[1] for p in proj) / len(proj)
            near = min(polys, key=lambda s: math.dist((cx, cy), (s['cx'], s['cy'])), default=None)
            if near is None:
                continue
            err = max(min(math.dist(p, q) for q in near['pts']) for p in proj)
            print(f"  {r['name']:18} вершин DXF={len(proj)} SVG={len(near['pts'])}"
                  f"   макс.отклонение={err:.5f} px" + ('' if err <= args.tolerance else '  ⚠'))
            if err > args.tolerance:
                problems.append(f"зона {r['name']!r}: отклонение {err:.3f} px превышает допуск")

    # -------------------------------------------------------------------- итог
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
