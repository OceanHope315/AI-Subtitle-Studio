from __future__ import annotations

import re

from .base import DetectedText


def compose_line_candidates(
    candidates: list[DetectedText],
    *,
    roi_bounds: tuple[int, int, int, int] | None = None,
) -> list[DetectedText]:
    """Turn Paddle's same-line fragments into one visual observation.

    Paddle may return both a full line and nested alternatives, or split one
    stylized caption into several overlapping word boxes. This function first
    suppresses contained alternatives, then joins only baseline-compatible,
    left-to-right fragments. It is intentionally text-agnostic.
    """

    if len(candidates) < 2:
        return list(candidates)
    candidates, competition_wins = _suppress_overlapping_alternatives(candidates)
    candidates = _suppress_attached_competitors(candidates, competition_wins)
    if len(candidates) < 2:
        return candidates

    parent = list(range(len(candidates)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for left_index, left in enumerate(candidates):
        for right_index in range(left_index + 1, len(candidates)):
            right = candidates[right_index]
            if _fragments_share_line(left, right, roi_bounds):
                union(left_index, right_index)

    groups: dict[int, list[DetectedText]] = {}
    for index, candidate in enumerate(candidates):
        groups.setdefault(find(index), []).append(candidate)
    composed = [_compose_group(group) for group in groups.values()]
    composed = sorted(composed, key=lambda item: (item.position[1], item.position[0]))
    return _compose_stacked_lines(composed)


def _suppress_overlapping_alternatives(
    candidates: list[DetectedText],
) -> tuple[list[DetectedText], list[tuple[DetectedText, DetectedText]]]:
    removed: set[int] = set()
    competition_wins: list[tuple[DetectedText, DetectedText]] = []
    for left_index, left in enumerate(candidates):
        if left_index in removed:
            continue
        for right_index in range(left_index + 1, len(candidates)):
            if right_index in removed:
                continue
            right = candidates[right_index]
            overlap = _box_overlap_over_smaller(left.position, right.position)
            if overlap < 0.72:
                continue
            contained_text = _text_contained(left.text, right.text)
            if not contained_text and _box_iou(left.position, right.position) < 0.58:
                continue
            if _is_weak_multiline_expansion(left, right):
                removed.add(left_index)
                competition_wins.append((right, left))
                break
            if _is_weak_multiline_expansion(right, left):
                removed.add(right_index)
                competition_wins.append((left, right))
                continue
            preferred = max(
                (left_index, right_index),
                key=lambda index: (
                    len(_tokens(candidates[index].text)),
                    len(_normalized(candidates[index].text)),
                    candidates[index].confidence,
                    _box_area(candidates[index].position),
                ),
            )
            removed.add(right_index if preferred == left_index else left_index)
            if left_index in removed:
                break
    return (
        [candidate for index, candidate in enumerate(candidates) if index not in removed],
        competition_wins,
    )


def _is_weak_multiline_expansion(
    expanded: DetectedText,
    strong_line: DetectedText,
) -> bool:
    """Prefer a very reliable line over a weak OCR box that wraps around it.

    Paddle occasionally emits a tall candidate containing the real caption plus
    an unrelated row. Requiring an explicit extra visual line, near-complete
    containment, and a material confidence gap keeps normal one-line word
    reveals and genuine, similarly confident stacked titles intact.
    """

    expanded_lines = [line for line in expanded.text.splitlines() if _tokens(line)]
    if len(expanded_lines) < 2 or "\n" in strong_line.text:
        return False
    if not _text_contained(expanded.text, strong_line.text):
        return False
    if _box_overlap_over_smaller(expanded.position, strong_line.position) < 0.88:
        return False
    if strong_line.confidence < 0.96 or strong_line.confidence - expanded.confidence < 0.06:
        return False
    expanded_tokens = _tokens(expanded.text)
    strong_tokens = _tokens(strong_line.text)
    return len(expanded_tokens) > len(strong_tokens)


def _suppress_attached_competitors(
    candidates: list[DetectedText],
    competition_wins: list[tuple[DetectedText, DetectedText]],
) -> list[DetectedText]:
    """Remove a lower-confidence HUD attached to a rejected false expansion.

    The winning line would otherwise be paired with the adjacent HUD by the
    stacked-line composer. A real second title line is retained when its text
    belonged to the rejected multiline reading, or when it has comparable OCR
    confidence.
    """

    if not competition_wins:
        return candidates
    removed_ids: set[int] = set()
    for strong_line, rejected_expansion in competition_wins:
        for candidate in candidates:
            if candidate is strong_line or id(candidate) in removed_ids:
                continue
            if strong_line.confidence - candidate.confidence < 0.06:
                continue
            if _text_contained(candidate.text, rejected_expansion.text):
                continue
            if _box_overlap_over_smaller(
                candidate.position, rejected_expansion.position
            ) < 0.08:
                continue
            top, bottom = sorted(
                (strong_line, candidate), key=lambda item: _center_y(item.position)
            )
            if _stacked_line_score(top, bottom) is not None:
                removed_ids.add(id(candidate))
    return [candidate for candidate in candidates if id(candidate) not in removed_ids]


def _fragments_share_line(
    left: DetectedText,
    right: DetectedText,
    roi_bounds: tuple[int, int, int, int] | None,
) -> bool:
    left_box, right_box = left.position, right.position
    left_height = max(1, left_box[3] - left_box[1])
    right_height = max(1, right_box[3] - right_box[1])
    if min(left_height, right_height) / max(left_height, right_height) < 0.68:
        return False
    vertical_overlap = max(0, min(left_box[3], right_box[3]) - max(left_box[1], right_box[1]))
    if vertical_overlap / min(left_height, right_height) < 0.58:
        return False
    if abs(_center_y(left_box) - _center_y(right_box)) > max(left_height, right_height) * 0.38:
        return False
    if roi_bounds is not None:
        roi_width = max(1, roi_bounds[2] - roi_bounds[0])
        edge_margin = max(3, round(roi_width * 0.01))

        def touches_edge(box: tuple[int, int, int, int]) -> bool:
            return min(
                abs(box[0] - roi_bounds[0]),
                abs(roi_bounds[2] - box[2]),
            ) <= edge_margin

        if touches_edge(left_box) != touches_edge(right_box) and (
            abs(_center_y(left_box) - _center_y(right_box))
            > max(left_height, right_height) * 0.25
            or abs(left_box[3] - right_box[3])
            > max(left_height, right_height) * 0.22
        ):
            return False

    first, second = (left_box, right_box) if left_box[0] <= right_box[0] else (right_box, left_box)
    overlap_width = max(0, first[2] - second[0])
    smaller_width = max(1, min(first[2] - first[0], second[2] - second[0]))
    # Heavy horizontal overlap is an alternative detection, not another word.
    if overlap_width / smaller_width > 0.55:
        return False
    gap = max(0, second[0] - first[2])
    return gap <= max(24, round(max(left_height, right_height) * 0.9))


def _compose_group(group: list[DetectedText]) -> DetectedText:
    ordered = sorted(group, key=lambda item: item.position[0])
    text = ordered[0].text.strip()
    for candidate in ordered[1:]:
        text = _join_text(text, candidate.text.strip())
    widths = [max(1, item.position[2] - item.position[0]) for item in ordered]
    confidence = sum(
        item.confidence * width for item, width in zip(ordered, widths)
    ) / sum(widths)
    return DetectedText(
        text=text,
        confidence=round(confidence, 6),
        position=(
            min(item.position[0] for item in ordered),
            min(item.position[1] for item in ordered),
            max(item.position[2] for item in ordered),
            max(item.position[3] for item in ordered),
        ),
    )


def _compose_stacked_lines(candidates: list[DetectedText]) -> list[DetectedText]:
    """Combine an explicit two-line caption while rejecting small HUD bylines."""

    if len(candidates) < 2:
        return candidates
    used: set[int] = set()
    output: list[DetectedText] = []
    for top_index, top in enumerate(candidates):
        if top_index in used:
            continue
        best: tuple[float, int] | None = None
        for bottom_index in range(top_index + 1, len(candidates)):
            if bottom_index in used:
                continue
            score = _stacked_line_score(top, candidates[bottom_index])
            if score is not None and (best is None or score > best[0]):
                best = (score, bottom_index)
        if best is None:
            output.append(top)
            continue
        bottom_index = best[1]
        bottom = candidates[bottom_index]
        used.update((top_index, bottom_index))
        top_width = max(1, top.position[2] - top.position[0])
        bottom_width = max(1, bottom.position[2] - bottom.position[0])
        output.append(
            DetectedText(
                text=f"{top.text.strip()}\n{bottom.text.strip()}",
                confidence=round(
                    (top.confidence * top_width + bottom.confidence * bottom_width)
                    / (top_width + bottom_width),
                    6,
                ),
                position=(
                    min(top.position[0], bottom.position[0]),
                    min(top.position[1], bottom.position[1]),
                    max(top.position[2], bottom.position[2]),
                    max(top.position[3], bottom.position[3]),
                ),
            )
        )
    return sorted(output, key=lambda item: (item.position[1], item.position[0]))


def _stacked_line_score(top: DetectedText, bottom: DetectedText) -> float | None:
    top_box, bottom_box = top.position, bottom.position
    top_height = max(1, top_box[3] - top_box[1])
    bottom_height = max(1, bottom_box[3] - bottom_box[1])
    if min(top_height, bottom_height) / max(top_height, bottom_height) < 0.72:
        return None
    center_delta = _center_y(bottom_box) - _center_y(top_box)
    largest_height = max(top_height, bottom_height)
    if not largest_height * 0.52 <= center_delta <= largest_height * 1.25:
        return None
    horizontal_overlap = max(
        0, min(top_box[2], bottom_box[2]) - max(top_box[0], bottom_box[0])
    )
    smaller_width = max(
        1, min(top_box[2] - top_box[0], bottom_box[2] - bottom_box[0])
    )
    overlap_ratio = horizontal_overlap / smaller_width
    if overlap_ratio < 0.60:
        return None
    center_x_delta = abs(
        (top_box[0] + top_box[2]) / 2
        - (bottom_box[0] + bottom_box[2]) / 2
    )
    if center_x_delta > max(
        top_box[2] - top_box[0], bottom_box[2] - bottom_box[0]
    ) * 0.30:
        return None
    return overlap_ratio - center_x_delta / smaller_width * 0.1


def _join_text(left: str, right: str) -> str:
    left_tokens, right_tokens = left.split(), right.split()
    maximum = min(len(left_tokens), len(right_tokens))
    overlap = 0
    for count in range(1, maximum + 1):
        if [_normalized(token) for token in left_tokens[-count:]] == [
            _normalized(token) for token in right_tokens[:count]
        ]:
            overlap = count
    return " ".join([*left_tokens, *right_tokens[overlap:]]).strip()


def _normalized(value: str) -> str:
    return re.sub(r"[^\w']+", " ", value.casefold()).strip()


def _tokens(value: str) -> list[str]:
    return [token for token in _normalized(value).split() if token]


def _text_contained(left: str, right: str) -> bool:
    left_tokens, right_tokens = _tokens(left), _tokens(right)
    if not left_tokens or not right_tokens:
        return False
    shorter, longer = (
        (left_tokens, right_tokens)
        if len(left_tokens) <= len(right_tokens)
        else (right_tokens, left_tokens)
    )
    return any(
        longer[index:index + len(shorter)] == shorter
        for index in range(len(longer) - len(shorter) + 1)
    )


def _box_iou(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> float:
    intersection = _intersection_area(left, right)
    union = _box_area(left) + _box_area(right) - intersection
    return intersection / max(1, union)


def _box_overlap_over_smaller(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> float:
    return _intersection_area(left, right) / max(1, min(_box_area(left), _box_area(right)))


def _intersection_area(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> int:
    width = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    return width * height


def _box_area(box: tuple[int, int, int, int]) -> int:
    return max(1, box[2] - box[0]) * max(1, box[3] - box[1])


def _center_y(box: tuple[int, int, int, int]) -> float:
    return (box[1] + box[3]) / 2
