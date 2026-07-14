#!/usr/bin/env python3
"""
plan_convert.py — приводит SVG-план из CAD/Inkscape к эталону интерфейса.

Что делает (подробно — docs/SVG_PLAN_SPEC.md):
  1. Переносит имя устройства из ТЕКСТОВОЙ ПОДПИСИ («L 1.12.31») в саму геометрию
     светильника/датчика: data-entity="light.l_1_12_31". Подписи затем удаляются.
  2. Снимает захардкоженные цвета → currentColor (план наследует тему интерфейса).
  3. Схлопывает CAD-трансформации (matrix со скейлом и флипом по Y) в абсолютные координаты.
  4. Чистит мусор Inkscape/CAD (sodipodi, inkscape:*, неиспользуемые clipPath).
  5. Отчитывается: сколько привязано, что осталось без пары, есть ли зоны помещений.

ЗОНЫ ПОМЕЩЕНИЙ скрипт НЕ создаёт: стены в CAD — набор несвязанных отрезков, замкнутые
контуры из них не выводятся, а соответствие «полигон ↔ area в HA» машине неоткуда взять.
Их рисуют вручную один раз (слой ROOM_ZONES, id = area_id) — см. §4 спеки.

Запуск:
    python3 tools/plan_convert.py исходник.svg -o assets/floors/2_etazh.svg
    python3 tools/plan_convert.py исходник.svg --dry-run     # только отчёт, файл не пишется
"""

from __future__ import annotations

import argparse
import math
import re
import sys
import xml.etree.ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"
INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape"
SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"

ET.register_namespace("", SVG_NS)

# --- нейминг DALI: префикс подписи → домен сущности HA ---------------------------------
# Датчик движения и освещённости — ОДНО устройство и одна точка на плане (подпись MS).
# Люкс-сущность (sensor.il_*) отдельной подписи не имеет: интерфейс находит её по device_id.
PREFIX_DOMAIN = {
    "l": ("light", "light"),      # (домен HA, вид устройства для CSS)
    "ms": ("sensor", "sensor"),
    "kp": ("event", "panel"),
}

# Слои исходника (inkscape:label). Геометрия и подписи лежат ОТДЕЛЬНО — их и связываем.
GEOMETRY_LAYERS = {"LAMP": "light", "MS": "sensor", "KP": "panel"}
LABEL_LAYERS = {"LAMP_NUMBER", "SENSOR_NUMBER", "PANEL_NUMBER"}
WALL_LAYERS = {"WALLS"}
ZONE_LAYERS = {"ROOM_ZONES"}

# Подпись вида «L 1.12.31» / «MS 1.13.4» / «KP 1.5.2» (регистр и разделители не важны).
LABEL_RE = re.compile(r"^\s*(L|MS|KP)\s*[\s.]?\s*([\d.\s_]+?)\s*$", re.IGNORECASE)

# Насколько далеко от подписи искать её геометрию (в единицах viewBox).
# В CAD подпись стоит НАД/ПОД значком со сдвигом ~40 ед., поэтому радиус заметно больше
# шага между соседними лампами (~21 ед.). Это безопасно: сопоставление идёт 1:1 и по
# возрастанию расстояния, поэтому ближайшая пара забирает друг друга первой.
DEFAULT_MAX_DISTANCE = 60.0

# Привязка дальше этой доли радиуса — повод посмотреть глазами (подпись могла уехать).
SUSPICIOUS_RATIO = 0.8


# ======================================================================================
# Матрицы аффинных преобразований: (a, b, c, d, e, f) как в SVG
# ======================================================================================

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mat_multiply(m1, m2):
    """m1 ∘ m2 — сначала применяется m2, затем m1 (как вложенные transform в SVG)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def mat_apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def parse_transform(value: str):
    """Разбор атрибута transform: matrix/translate/scale/rotate (то, что даёт CAD/Inkscape)."""
    if not value:
        return IDENTITY

    result = IDENTITY
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", value):
        nums = [float(n) for n in re.findall(r"-?[\d.eE+-]+", args)]
        if name == "matrix" and len(nums) == 6:
            m = tuple(nums)
        elif name == "translate":
            tx = nums[0] if nums else 0.0
            ty = nums[1] if len(nums) > 1 else 0.0
            m = (1.0, 0.0, 0.0, 1.0, tx, ty)
        elif name == "scale":
            sx = nums[0] if nums else 1.0
            sy = nums[1] if len(nums) > 1 else sx
            m = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        elif name == "rotate" and nums:
            ang = math.radians(nums[0])
            cos, sin = math.cos(ang), math.sin(ang)
            m = (cos, sin, -sin, cos, 0.0, 0.0)
        else:
            continue
        result = mat_multiply(result, m)

    return result


# ======================================================================================
# Геометрия: bbox элемента в АБСОЛЮТНЫХ координатах (после всех трансформаций)
# ======================================================================================

PATH_CMD_RE = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)")


def path_points(d: str):
    """Опорные точки пути. Кривые аппроксимируем узлами: для bbox значка этого достаточно
    (значки CAD — прямоугольники и окружности-из-кривых, точность до пикселя не нужна)."""
    points = []
    cx = cy = 0.0
    start_x = start_y = 0.0

    for cmd, raw in PATH_CMD_RE.findall(d or ""):
        nums = [float(n) for n in re.findall(r"-?\d*\.?\d+(?:[eE][+-]?\d+)?", raw)]
        upper = cmd.upper()
        rel = cmd.islower()

        if upper == "Z":
            cx, cy = start_x, start_y
            continue

        step = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}[upper]
        if step == 0 or len(nums) < step:
            continue

        for i in range(0, len(nums) - step + 1, step):
            chunk = nums[i:i + step]
            if upper in ("M", "L", "T"):
                nx, ny = chunk[0], chunk[1]
                if rel:
                    nx, ny = cx + nx, cy + ny
            elif upper == "H":
                nx, ny = (cx + chunk[0]) if rel else chunk[0], cy
            elif upper == "V":
                nx, ny = cx, (cy + chunk[0]) if rel else chunk[0]
            elif upper in ("C", "S", "Q", "A"):
                nx, ny = chunk[-2], chunk[-1]
                if rel:
                    nx, ny = cx + nx, cy + ny
            else:
                continue

            points.append((nx, ny))
            cx, cy = nx, ny
            if upper == "M" and i == 0:
                start_x, start_y = nx, ny

    return points


def element_points(el, matrix):
    """Опорные точки элемента в абсолютных координатах.
    `matrix` — ПОЛНАЯ матрица элемента из build_matrix_map (собственный transform уже учтён,
    повторно его применять нельзя)."""
    tag = el.tag.split("}")[-1]
    local = matrix
    pts = []

    if tag == "path":
        pts = path_points(el.get("d", ""))
    elif tag == "rect":
        x = float(el.get("x", 0))
        y = float(el.get("y", 0))
        w = float(el.get("width", 0))
        h = float(el.get("height", 0))
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    elif tag in ("circle", "ellipse"):
        cx = float(el.get("cx", 0))
        cy = float(el.get("cy", 0))
        rx = float(el.get("r", el.get("rx", 0)))
        ry = float(el.get("r", el.get("ry", 0)))
        pts = [(cx - rx, cy - ry), (cx + rx, cy + ry)]
    elif tag in ("polygon", "polyline"):
        nums = [float(n) for n in re.findall(r"-?\d*\.?\d+", el.get("points", ""))]
        pts = list(zip(nums[0::2], nums[1::2]))
    elif tag in ("text", "tspan"):
        # У текста CAD координаты сидят в самой матрице (x/y = 0), поэтому берём её сдвиг.
        pts = [(float(el.get("x", 0)), float(el.get("y", 0)))]

    return [mat_apply(local, x, y) for x, y in pts]


def bbox_center(points):
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)


# ======================================================================================
# Разбор исходника
# ======================================================================================

def layer_label(el):
    return el.get(f"{{{INKSCAPE_NS}}}label") or ""


def iter_layers(root):
    """Слои Inkscape (могут быть вложенными: SENSOR_NUMBER внутри LAMP_NUMBER)."""
    for el in root.iter(f"{{{SVG_NS}}}g"):
        if el.get(f"{{{INKSCAPE_NS}}}groupmode") == "layer":
            yield el


def normalize_name(prefix: str, digits: str) -> str:
    """«L 1.12.31» → l_1_12_31 (нейминг ядра DALI)."""
    parts = re.split(r"[.\s_]+", digits.strip())
    parts = [p for p in parts if p]
    return f"{prefix.lower()}_{'_'.join(parts)}"


def element_text(el) -> str:
    return "".join(el.itertext()).strip()


def collect_labels(root, matrix_of):
    """Подписи устройств: имя + позиция в абсолютных координатах."""
    labels = []
    for el in root.iter(f"{{{SVG_NS}}}text"):
        raw = element_text(el)
        m = LABEL_RE.match(raw)
        if not m:
            continue

        name = normalize_name(m.group(1), m.group(2))
        pos = bbox_center(element_points(el, matrix_of.get(id(el), IDENTITY)))
        if pos is None:
            continue

        labels.append({"name": name, "pos": pos, "element": el, "raw": raw})

    return labels


def collect_geometry(root, matrix_of):
    """Значки устройств из слоёв LAMP/MS/KP: центр + элемент."""
    items = []
    for layer in iter_layers(root):
        kind = GEOMETRY_LAYERS.get(layer_label(layer))
        if not kind:
            continue

        for el in layer.iter():
            tag = el.tag.split("}")[-1]
            if tag not in ("path", "rect", "circle", "ellipse", "polygon"):
                continue
            # Текстовые слои MS содержат и значок, и подпись «MS» — подписи пропускаем.
            pts = element_points(el, matrix_of.get(id(el), IDENTITY))
            center = bbox_center(pts)
            if center is None:
                continue

            items.append({"kind": kind, "pos": center, "element": el, "layer": layer})

    return items


def build_matrix_map(root):
    """Абсолютная матрица для каждого элемента (CAD вкладывает transform на каждом уровне)."""
    matrix_of = {}

    def walk(el, parent_matrix):
        local = mat_multiply(parent_matrix, parse_transform(el.get("transform", "")))
        matrix_of[id(el)] = local
        for child in el:
            walk(child, local)

    for child in root:
        walk(child, IDENTITY)

    return matrix_of


# ======================================================================================
# Привязка подпись → геометрия (жадно, ближайшая пара, 1:1)
# ======================================================================================

def match_labels_to_geometry(labels, geometry, max_distance):
    pairs = []
    for label in labels:
        for geo in geometry:
            # Подпись MS ищет значок в слое MS, L — в LAMP: это отсекает половину ошибок.
            expected = PREFIX_DOMAIN.get(label["name"].split("_")[0], (None, None))[1]
            if expected and geo["kind"] != expected:
                continue

            dx = label["pos"][0] - geo["pos"][0]
            dy = label["pos"][1] - geo["pos"][1]
            dist = math.hypot(dx, dy)
            if dist <= max_distance:
                pairs.append((dist, label, geo))

    pairs.sort(key=lambda p: p[0])

    used_labels, used_geo, matched = set(), set(), []
    for dist, label, geo in pairs:
        if id(label) in used_labels or id(geo["element"]) in used_geo:
            continue
        used_labels.add(id(label))
        used_geo.add(id(geo["element"]))
        matched.append((label, geo, dist))

    unmatched_labels = [l for l in labels if id(l) not in used_labels]
    return matched, unmatched_labels


# ======================================================================================
# Сборка эталонного SVG
# ======================================================================================

def entity_id_for(name: str):
    prefix = name.split("_")[0]
    domain = PREFIX_DOMAIN.get(prefix, (None, None))[0]
    return f"{domain}.{name}" if domain else None


def flatten_path_d(d: str, matrix):
    """Пересчитать путь в абсолютные координаты, СОХРАНИВ типы команд.

    Наивный подход «взять узлы и соединить прямыми» ломает геометрию: значок датчика —
    окружность из кривых (`c`), и по узлам он превращается в ромб. Поэтому кривые
    трансформируем целиком, вместе с контрольными точками.

    Дуги (A/a) и сокращённые кривые (S/T) не поддерживаем — они требуют пересчёта радиусов
    и хвостовых контрольных точек. Если встретились, возвращаем None: элемент останется
    со своим transform (отрисуется верно, просто не «схлопнется»).
    """
    out = []
    cx = cy = start_x = start_y = 0.0

    for cmd, raw in PATH_CMD_RE.findall(d or ""):
        upper = cmd.upper()
        rel = cmd.islower()
        nums = [float(n) for n in re.findall(r"-?\d*\.?\d+(?:[eE][+-]?\d+)?", raw)]

        if upper in ("S", "T", "A"):
            return None

        if upper == "Z":
            out.append("Z")
            cx, cy = start_x, start_y
            continue

        step = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "Q": 4}[upper]
        if len(nums) < step:
            continue

        for i in range(0, len(nums) - step + 1, step):
            chunk = nums[i:i + step]

            # Приводим к абсолютным точкам в системе ИСХОДНИКА.
            if upper in ("M", "L"):
                pts = [(chunk[0], chunk[1])]
            elif upper == "H":
                pts = [(chunk[0], 0.0 if rel else cy)]
                if rel:
                    pts = [(cx + chunk[0], cy)]
            elif upper == "V":
                pts = [(cx, cy + chunk[0])] if rel else [(cx, chunk[0])]
            elif upper == "C":
                pts = [(chunk[0], chunk[1]), (chunk[2], chunk[3]), (chunk[4], chunk[5])]
            else:  # Q
                pts = [(chunk[0], chunk[1]), (chunk[2], chunk[3])]

            if rel and upper in ("M", "L", "C", "Q"):
                pts = [(cx + px, cy + py) for px, py in pts]

            # H/V после абсолютизации становятся обычной точкой → пишем как L.
            out_cmd = {"M": "M", "L": "L", "H": "L", "V": "L", "C": "C", "Q": "Q"}[upper]

            abs_pts = [mat_apply(matrix, px, py) for px, py in pts]
            coords = " ".join(f"{px:.2f},{py:.2f}" for px, py in abs_pts)
            out.append(f"{out_cmd} {coords}")

            cx, cy = pts[-1]
            if upper == "M" and i == 0:
                start_x, start_y = cx, cy
                # Последующие пары после M — это неявные L.
                upper = "L"
                cmd = "l" if rel else "L"

    return " ".join(out) if out else None


def set_absolute_transform(el, matrix):
    """Элемент не схлопнулся (дуга / не-path) — вешаем на него ПОЛНУЮ матрицу.

    Это обязательно: transform со слоёв мы снимаем, и без своей полной матрицы такой
    элемент уехал бы с места (потерял бы вклад родителей).
    """
    a, b, c, d, e, f = matrix
    el.set("transform", f"matrix({a:.6g},{b:.6g},{c:.6g},{d:.6g},{e:.6g},{f:.6g})")


def flatten_geometry(el, matrix):
    """Пересчитать элемент в абсолютные координаты и снять transform."""
    tag = el.tag.split("}")[-1]

    if tag == "path":
        d = flatten_path_d(el.get("d", ""), matrix)
        if d:
            el.set("d", d)
            el.attrib.pop("transform", None)
            return

    # rect/circle/polygon и пути с дугами: геометрию не трогаем, но матрицу фиксируем.
    set_absolute_transform(el, matrix)


def strip_style(el, css_class):
    """Снимаем цвета — красит тема (currentColor). Толщину линии сохраняем: по ней видна
    иерархия стен (несущая толще перегородки)."""
    style = el.get("style", "")
    width = None
    m = re.search(r"stroke-width\s*:\s*([\d.]+)", style)
    if m:
        width = float(m.group(1))

    for attr in ("style", "fill", "stroke", "stroke-opacity", "fill-opacity"):
        el.attrib.pop(attr, None)

    el.set("class", css_class)
    if width is not None:
        # Толщина была в системе координат CAD — приводим к viewBox (масштаб 0.16).
        el.set("stroke-width", f"{width * 0.16:.2f}")


def clean_attrs(el):
    for key in list(el.attrib):
        if key.startswith(f"{{{INKSCAPE_NS}}}") or key.startswith(f"{{{SODIPODI_NS}}}"):
            del el.attrib[key]


def convert(tree, max_distance, verbose=False):
    root = tree.getroot()
    matrix_of = build_matrix_map(root)

    labels = collect_labels(root, matrix_of)
    geometry = collect_geometry(root, matrix_of)
    matched, unmatched = match_labels_to_geometry(labels, geometry, max_distance)

    report = {
        "labels": len(labels),
        "geometry": len(geometry),
        "matched": len(matched),
        "unmatched": unmatched,
        "by_kind": {},
        "zones": 0,
        "duplicates": [],
        "suspicious": [(l["name"], d) for l, _g, d in matched
                       if d > max_distance * SUSPICIOUS_RATIO],
        "orphan_geometry": 0,
    }
    report["orphan_geometry"] = len(geometry) - len(matched)

    # --- 1. Устройства: имя из подписи → data-entity на геометрии --------------------
    seen_names = {}
    for label, geo, dist in matched:
        name = label["name"]
        entity_id = entity_id_for(name)
        if not entity_id:
            continue

        if name in seen_names:
            report["duplicates"].append(name)
            continue
        seen_names[name] = True

        el = geo["element"]
        flatten_geometry(el, matrix_of.get(id(el), IDENTITY))
        strip_style(el, f"device-node device-{geo['kind']}")
        el.set("data-entity", entity_id)
        el.set("id", name)
        clean_attrs(el)

        report["by_kind"][geo["kind"]] = report["by_kind"].get(geo["kind"], 0) + 1
        if verbose:
            print(f"  {name:<14} → {entity_id:<24} (значок в {dist:.1f} ед.)")

    # --- 2. Стены, зоны; удаление слоёв подписей ------------------------------------
    for layer in list(iter_layers(root)):
        label = layer_label(layer)

        if label in LABEL_LAYERS:
            # Имена переехали в data-entity — подписи на плане больше не нужны.
            root.remove(layer) if layer in list(root) else _remove_nested(root, layer)
            continue

        if label in WALL_LAYERS:
            for el in layer.iter():
                if el.tag.split("}")[-1] == "path":
                    flatten_geometry(el, matrix_of.get(id(el), IDENTITY))
                    strip_style(el, "plan-wall")
                    clean_attrs(el)

        if label in ZONE_LAYERS:
            for el in layer.iter():
                tag = el.tag.split("}")[-1]
                if tag not in ("path", "rect", "polygon"):
                    continue
                area_id = el.get("id", "")
                if not area_id:
                    continue
                flatten_geometry(el, matrix_of.get(id(el), IDENTITY))
                el.attrib.pop("style", None)
                el.set("class", "room-zone")
                el.set("data-room-id", area_id)
                clean_attrs(el)
                report["zones"] += 1

        clean_attrs(layer)
        layer.attrib.pop("transform", None)   # координаты уже абсолютные

    # --- 3. Чистка мусора CAD/Inkscape ----------------------------------------------
    for tag in ("namedview", "metadata"):
        for el in root.findall(f"{{{SODIPODI_NS}}}{tag}") + root.findall(f"{{{SVG_NS}}}{tag}"):
            root.remove(el)

    for defs in root.findall(f"{{{SVG_NS}}}defs"):
        root.remove(defs)   # clipPath из CAD не нужны: координаты схлопнуты

    for el in root.iter():
        clean_attrs(el)

    # --- 4. Нормализация viewBox ------------------------------------------------------
    view_box = root.get("viewBox")
    if view_box:
        nums = [float(n) for n in view_box.split()]
        if len(nums) == 4:
            root.set("viewBox", f"0 0 {nums[2]:.2f} {nums[3]:.2f}")
    root.attrib.pop("width", None)
    root.attrib.pop("height", None)

    return report


def _remove_nested(root, target):
    for parent in root.iter():
        if target in list(parent):
            parent.remove(target)
            return


# ======================================================================================
# CLI
# ======================================================================================

def main():
    parser = argparse.ArgumentParser(description="SVG-план из CAD → эталон интерфейса")
    parser.add_argument("source", help="исходный SVG (из CAD/Inkscape)")
    parser.add_argument("-o", "--output", help="куда записать эталонный SVG")
    parser.add_argument("--max-distance", type=float, default=DEFAULT_MAX_DISTANCE,
                        help=f"радиус поиска значка от подписи, ед. viewBox (по умолчанию {DEFAULT_MAX_DISTANCE})")
    parser.add_argument("--dry-run", action="store_true", help="только отчёт, файл не писать")
    parser.add_argument("-v", "--verbose", action="store_true", help="печатать каждую привязку")
    args = parser.parse_args()

    tree = ET.parse(args.source)
    report = convert(tree, args.max_distance, args.verbose)

    print(f"\nПлан: {args.source}")
    print(f"  подписей найдено:   {report['labels']}")
    print(f"  значков найдено:    {report['geometry']}")
    print(f"  ПРИВЯЗАНО:          {report['matched']}")
    for kind, count in sorted(report["by_kind"].items()):
        print(f"      {kind:<8} {count}")

    if report["duplicates"]:
        print(f"\n  ⚠ ДУБЛИ ИМЁН ({len(report['duplicates'])}): {', '.join(report['duplicates'][:10])}")
        print("     Одно имя = одно устройство. Проверьте план.")

    if report["unmatched"]:
        print(f"\n  ⚠ БЕЗ ЗНАЧКА ({len(report['unmatched'])}):")
        for label in report["unmatched"][:10]:
            print(f"      {label['name']:<14} подпись «{label['raw']}» — значок дальше "
                  f"{args.max_distance} ед. или не в своём слое")
        print("     Увеличьте --max-distance или проверьте слои (LAMP / MS / KP).")

    if report["orphan_geometry"] > 0:
        print(f"\n  ⚠ ЗНАЧКОВ БЕЗ ПОДПИСИ: {report['orphan_geometry']}")
        print("     Устройство есть на плане, но имени у него нет — в интерфейс оно не попадёт.")

    if report["suspicious"]:
        print(f"\n  ⚠ ДАЛЁКИЕ ПРИВЯЗКИ ({len(report['suspicious'])}) — проверьте глазами:")
        for name, dist in report["suspicious"][:10]:
            print(f"      {name:<14} значок в {dist:.1f} ед. (близко к пределу {args.max_distance})")

    if report["zones"]:
        print(f"\n  зон помещений:      {report['zones']}")
    else:
        print("\n  ⚠ ЗОН ПОМЕЩЕНИЙ НЕТ (слой ROOM_ZONES).")
        print("     Без них план — только подложка: не будет ни подсветки по свету, ни тапа")
        print("     по помещению, ни режимов карты. Обведите помещения вручную, id = area_id.")
        print("     См. docs/SVG_PLAN_SPEC.md §4.")

    if args.dry_run:
        print("\n--dry-run: файл не записан.")
        return 0

    if not args.output:
        print("\nНе задан -o: файл не записан (используйте --dry-run, если так и задумано).")
        return 1

    tree.write(args.output, encoding="utf-8", xml_declaration=True)
    print(f"\nЗаписано: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
