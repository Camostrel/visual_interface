#!/usr/bin/env python3
"""
plan_rooms.py — нарезает мини-планы помещений из эталонного плана этажа.

Комната на плане этажа — это зона (`.room-zone[data-room-id]`). Скрипт для каждой зоны
вырезает фрагмент: стены вокруг помещения + устройства внутри него, и кладёт результат
в assets/rooms/<area_id>.svg. Именно этот файл интерфейс грузит при переходе в комнату.

Что важно:
  * Координаты устройств НЕ пересчитываются. Они остаются в системе плана этажа, а рамка
    задаётся через viewBox. Так один и тот же data-entity указывает на одно и то же место
    и на этаже, и в комнате — не надо держать два набора координат.
  * Стены берутся ПО ПЕРЕСЕЧЕНИЮ с рамкой (а не по включению): иначе стена самой комнаты,
    выходящая за рамку, потерялась бы, и помещение осталось бы без контура.
  * Сама зона попадает в мини-план как `.room-zone` — интерфейс подсвечивает по ней помещение.

Запуск:
    python3 tools/plan_rooms.py assets/floors/3_etazh.svg -o assets/rooms/
"""

from __future__ import annotations

import argparse
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plan_convert as pc   # переиспользуем разбор матриц и геометрии

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)

# Поля вокруг помещения (ед. viewBox): чтобы стены и двери не обрезались вплотную.
PADDING = 12.0


def bbox_of(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def intersects(box, frame):
    """Пересекается ли bbox элемента с рамкой комнаты."""
    return not (box[2] < frame[0] or box[0] > frame[2] or
                box[3] < frame[1] or box[1] > frame[3])


def contains_center(box, frame):
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    return frame[0] <= cx <= frame[2] and frame[1] <= cy <= frame[3]


def collect(root):
    """Всё, что есть на плане этажа: зоны, стены, устройства — с абсолютными bbox."""
    matrix = pc.build_matrix_map(root)
    zones, walls, devices = [], [], []

    for el in root.iter():
        mat = matrix.get(id(el))
        if mat is None:
            continue
        pts = pc.element_points(el, mat)
        if not pts:
            continue

        box = bbox_of(pts)
        if el.get("data-room-id"):
            zones.append({"id": el.get("data-room-id"), "el": el, "box": box})
        elif el.get("data-entity"):
            devices.append({"entity": el.get("data-entity"), "el": el, "box": box})
        elif "plan-wall" in (el.get("class") or ""):
            walls.append({"el": el, "box": box})

    return zones, walls, devices


def build_room_svg(zone, walls, devices, padding):
    x0, y0, x1, y1 = zone["box"]
    frame = (x0 - padding, y0 - padding, x1 + padding, y1 + padding)
    width = frame[2] - frame[0]
    height = frame[3] - frame[1]

    svg = ET.Element(f"{{{SVG_NS}}}svg", {
        "version": "1.1",
        "viewBox": f"{frame[0]:.2f} {frame[1]:.2f} {width:.2f} {height:.2f}",
    })

    # 1. Зона помещения — по ней интерфейс подсвечивает комнату и ловит тап.
    zone_layer = ET.SubElement(svg, f"{{{SVG_NS}}}g", {"id": "room-zones"})
    zone_layer.append(zone["el"])

    # 2. Стены: по ПЕРЕСЕЧЕНИЮ с рамкой. По включению стена помещения, уходящая за рамку,
    #    потерялась бы — и комната осталась бы без контура.
    wall_layer = ET.SubElement(svg, f"{{{SVG_NS}}}g", {"id": "walls"})
    for wall in walls:
        if intersects(wall["box"], frame):
            wall_layer.append(wall["el"])

    # 3. Устройства: по ЦЕНТРУ внутри зоны (не рамки) — иначе в комнату попали бы соседские
    #    светильники из коридора, которые в неё не входят ни в HA, ни по смыслу.
    device_layer = ET.SubElement(svg, f"{{{SVG_NS}}}g", {"id": "devices"})
    inside = []
    for dev in devices:
        if contains_center(dev["box"], zone["box"]):
            device_layer.append(dev["el"])
            inside.append(dev["entity"])

    return svg, inside, len([w for w in walls if intersects(w["box"], frame)])


def main():
    parser = argparse.ArgumentParser(description="Мини-планы помещений из плана этажа")
    parser.add_argument("floor", help="эталонный план этажа (после plan_convert.py)")
    parser.add_argument("-o", "--out-dir", required=True, help="куда класть <area_id>.svg")
    parser.add_argument("--padding", type=float, default=PADDING,
                        help=f"поля вокруг помещения, ед. viewBox (по умолчанию {PADDING})")
    args = parser.parse_args()

    tree = ET.parse(args.floor)
    root = tree.getroot()
    zones, walls, devices = collect(root)

    if not zones:
        print("В плане нет зон помещений (.room-zone[data-room-id]) — резать нечего.")
        print("См. docs/SVG_PLAN_SPEC.md §4.")
        return 1

    os.makedirs(args.out_dir, exist_ok=True)
    print(f"План этажа: {args.floor}")
    print(f"  зон: {len(zones)}, стен: {len(walls)}, устройств: {len(devices)}\n")

    for zone in zones:
        # Дерево ElementTree переиспользует объекты элементов, поэтому для каждой комнаты
        # перечитываем план заново: иначе элемент «переехал» бы из одной комнаты в другую.
        fresh = ET.parse(args.floor).getroot()
        z, w, d = collect(fresh)
        target = next(item for item in z if item["id"] == zone["id"])

        svg, inside, wall_count = build_room_svg(target, w, d, args.padding)
        path = os.path.join(args.out_dir, f"{zone['id']}.svg")
        ET.ElementTree(svg).write(path, encoding="utf-8", xml_declaration=True)

        lights = [e for e in inside if e.startswith("light.")]
        sensors = [e for e in inside if e.startswith("sensor.")]
        print(f"  {zone['id']:<10} → {path}")
        print(f"      ламп {len(lights)}, датчиков {len(sensors)}, стен {wall_count}")
        if lights:
            print(f"      {', '.join(sorted(e.split('.')[1] for e in lights))}")

    print("\nГотово. Не забудьте: area с такими id должны существовать в Home Assistant.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
