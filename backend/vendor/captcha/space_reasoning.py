# -*- coding: utf-8 -*-
"""易盾点选验证码（空间推理 type=11）—— 纯本地自动识别。

覆盖题型：文字点选、字母朝向匹配、同色匹配、空间方位、姿态。

思路：
    * 背景是纯色，用「背景差分 + 连通域」切出每个字符（比 YOLO 更省事，无需模型）
    * 每个字符多角度送 ddddocr，拿到「字符 + 置信度」；朝向另用「逐行质心斜率」估计，
      因为 3D 立体字会把字形填实，模板匹配 / 投影方差 / Hough 都会被带偏
    * 解析提示语得到 (颜色, 大小写, 字符, 关系)，再按语义给候选元素打分选点

对外接口：
    solve(notice, png, ocr=None, verbose=False) -> list[tuple[int, int]]
    solve(..., detail=True)                      -> (points, elements, instruction)
    SolveError        识别/解析失败，调用方应换图或回退手动
"""

from __future__ import annotations

import math
import os
import re
import string
import sys
from dataclasses import dataclass, field

import cv2
import numpy as np


class SolveError(RuntimeError):
    pass


# ---------------------------------------------------------------- 数据结构

COLOR_WORDS = ("红色", "橙色", "黄色", "绿色", "蓝色", "紫色", "灰色", "黑色", "白色")


@dataclass
class Observation:
    """某个旋转角度下的一次 OCR 结果。"""

    angle: int      # 字符自身相对「正向」顺时针偏转的度数，(-180, 180]
    text: str
    conf: float


@dataclass
class Element:
    """图上切出来的一个字符块。"""

    box: tuple[int, int, int, int]      # x1, y1, x2, y2
    color: str
    bgr: tuple[float, float, float]
    area: int
    obs: list[Observation] = field(default_factory=list)
    tilt: int | None = None             # 逐行质心拟合出的倾斜角，比 OCR 角度稳
    tilt_len: int = 0                   # 参与拟合的行数，太少就不信这个值
    tall: bool = True                   # 高度接近中位数=大写/带升部的小写
    shape: str | None = None            # 球/立方体/圆柱：OCR 对立体物只能输出乱码
    mask: np.ndarray | None = field(default=None, repr=False, compare=False)
    # 约束重排用的概率表：prob[i] = 第 i 个候选字符在这个元素上出现过的最高概率，
    # prob_angle[i] = 达到该概率时的旋转角（= 这个字符最端正时的朝向）。
    # 比 top-1 文本可靠得多：3D 字体会把 L 认成 –、把 v 认成「小」，
    # 但正确字符的概率往往仍排在前面（实测 P(L)=0.77 而 P(7)=P(h)=0.0）。
    prob: np.ndarray | None = field(default=None, repr=False, compare=False)
    prob_angle: np.ndarray | None = field(default=None, repr=False, compare=False)
    _aligned_cache: np.ndarray | None = field(default=None, repr=False, compare=False)

    @property
    def _aligned(self) -> np.ndarray | None:
        """归一化后的掩膜，供朝向对齐比较用；结果缓存，只算一次。"""
        if self._aligned_cache is None:
            self._aligned_cache = _norm_mask(self.mask)
        return self._aligned_cache

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.box
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def best(self) -> Observation:
        return max(self.obs, key=lambda o: o.conf)

    @property
    def orientation(self) -> int:
        """统一朝向口径：优先几何倾斜，退化到 OCR 角度。"""
        if self.tilt is not None and self.tilt_len >= 12:
            return self.tilt
        return self.best.angle

    def __str__(self) -> str:
        b = self.best
        return "%s%s@(%d,%d) 倾斜%s 置信%.2f" % (
            self.color, b.text or "?", self.center[0], self.center[1],
            self.orientation, b.conf)


@dataclass
class Target:
    """提示语里的一个描述，如「绿色大写E」。"""

    color: str | None = None
    char: str | None = None
    upper: bool | None = None       # True=大写, False=小写, None=不限制
    shape: str | None = None        # 球/立方体/圆柱：目标不是字符

    def __str__(self) -> str:
        what = self.shape or self.char or "?"
        return "%s%s%s" % (self.color or "", "大写" if self.upper else ("小写" if self.upper is False else ""),
                           what)


@dataclass
class Instruction:
    kind: str                        # sequence / same_orientation / spatial
    targets: list[Target]
    ref: Target | None = None
    relation: str | None = None      # up / down / left / right
    text: str = ""


# ---------------------------------------------------------------- 切图

def _decode(png: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SolveError("图片解码失败")
    return img


SHAPE_WORDS = ("球", "立方体", "正方体", "长方体", "方块", "圆柱")


def _shape_of(mask: np.ndarray) -> str | None:
    """给非字符的立体物分类。

    提示语里会出现「球」「立方体」这类目标，它们没有字形，OCR 只能给出
    “小”“–”之类的乱码，纯靠 OCR 这道题必然选错（实测样本里就是这么错的），
    所以改用轮廓几何来判断。判据不够明确时返回 None，由上层当作“认不出来”
    处理（换图），不硬猜。
    """
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    area = float(cv2.contourArea(c))
    peri = float(cv2.arcLength(c, True))
    if area < 140 or peri < 32:
        return None
    circularity = 4.0 * math.pi * area / (peri * peri)
    hull_area = float(cv2.contourArea(cv2.convexHull(c)))
    solidity = area / hull_area if hull_area > 0 else 0.0
    _, _, w, h = cv2.boundingRect(c)
    ratio = w / float(h) if h else 0.0
    corners = len(cv2.approxPolyDP(c, 0.04 * peri, True))

    if circularity >= 0.78 and 0.74 <= ratio <= 1.36 and solidity >= 0.90:
        return "球"
    if corners <= 6 and solidity >= 0.90:
        return "立方体" if ratio >= 0.70 else "圆柱"
    return None


def _color_name(bgr: np.ndarray) -> str:
    px = np.uint8([[list(bgr)]])
    h, s, v = (int(x) for x in cv2.cvtColor(px, cv2.COLOR_BGR2HSV)[0][0])
    if s < 45:
        if v >= 205:
            return "白色"
        if v >= 90:
            return "灰色"
        return "黑色"
    if h <= 8 or h >= 160:
        return "红色"
    if h <= 22:
        return "橙色"
    if h <= 34:
        return "黄色"
    if h <= 85:
        return "绿色"
    if h <= 130:
        return "蓝色"
    return "紫色"


def _tilt(mask: np.ndarray) -> tuple[int | None, int]:
    """逐行质心线性拟合，得到字符竖笔的倾斜角（度）。

    3D 立体字会把字内部填实，投影方差/Hough/模板匹配都被形状噪声带偏；
    而「每一行前景的质心」随行号的变化几乎只由整体旋转决定，对阴影不敏感。
    返回 (角度, 参与拟合的行数)；行数太少时调用方应忽略该角度。
    """
    rows: list[tuple[int, float]] = []
    for y in range(mask.shape[0]):
        xs = np.where(mask[y] > 0)[0]
        if len(xs) >= 3:
            rows.append((y, float(xs.mean())))
    if len(rows) < 12:
        return None, len(rows)
    arr = np.array(rows, dtype=np.float64)
    cut = max(8, int(len(arr) * 0.7))       # 只用上部 70%，避开 J 的钩、E 的底部收笔
    k = float(np.polyfit(arr[:cut, 0], arr[:cut, 1], 1)[0])
    return int(round(np.degrees(np.arctan(k)))), len(rows)


def _color_masks(hsv_sub: np.ndarray, mask: np.ndarray, min_frac: float = 0.22) -> list[np.ndarray]:
    """连通块里若粘着两种以上颜色，按色相直方图的峰把它拆成几块。"""
    h = hsv_sub[..., 0][mask].astype(np.int32)
    s = hsv_sub[..., 1][mask].astype(np.int32)
    if h.size == 0 or float((s > 70).mean()) < 0.6:
        return [mask]           # 灰/白字没有色相可分，原样返回

    # 同一种颜色的色相会在相邻几个 bin 上摊开，先做环形滑动求和再找峰，
    # 否则单个 bin 的占比永远达不到阈值。
    hist = np.bincount(h, minlength=180).astype(np.float64)
    smooth = np.convolve(np.concatenate([hist[-8:], hist, hist[:8]]),
                         np.ones(17), mode="same")[8:188]
    peaks: list[int] = []
    for _ in range(3):
        idx = int(smooth.argmax())
        if smooth[idx] < min_frac * h.size:
            break
        peaks.append(idx)
        lo, hi = (idx - 14) % 180, (idx + 14) % 180
        if lo <= hi:
            smooth[lo:hi + 1] = 0.0
        else:
            smooth[lo:] = 0.0
            smooth[:hi + 1] = 0.0
    if len(peaks) < 2:
        return [mask]
    # 两个峰挨得太近说明只是同一种颜色的亮度差异，不算两种颜色
    d0 = abs(peaks[0] - peaks[1])
    if min(d0, 180 - d0) < 25:
        return [mask]

    out: list[np.ndarray] = []
    for p in peaks:
        d = np.abs(h - p)
        d = np.minimum(d, 180 - d)
        m = np.zeros_like(mask)
        m[mask] = d <= 14
        if m.sum() >= 0.05 * mask.sum():
            out.append(m)
    return out or [mask]


def segment(png: bytes) -> tuple[np.ndarray, list[Element]]:
    """背景差分切字符块。验证码背景是纯色，这一步很稳。"""
    img = _decode(png)
    bg = np.median(img.reshape(-1, 3), axis=0)
    diff = np.abs(img.astype(np.int16) - bg.astype(np.int16)).sum(2)
    mask = (diff > 40).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    raw: list[dict] = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if area < 120 or w < 10 or h < 12 or w > img.shape[1] * 0.8:
            continue
        px = img[y:y + h, x:x + w][lab[y:y + h, x:x + w] == i]
        raw.append({"box": [x, y, x + w, y + h],
                    "color": np.array(px.mean(axis=0), dtype=np.float32)})

    # 断笔（同一字符被拆成两块）时合并：位置要挨着，且颜色必须一致，
    # 否则会把相邻两个不同颜色的字符合成一个，中心点就落到两字之间。
    raw.sort(key=lambda r: r["box"])
    merged: list[dict] = []
    for item in raw:
        box = item["box"]
        for m in merged:
            mb = m["box"]
            gap_x = max(box[0] - mb[2], mb[0] - box[2])
            overlap_y = min(box[3], mb[3]) - max(box[1], mb[1])
            same_color = float(np.abs(m["color"] - item["color"]).sum()) < 60
            if (gap_x <= 6 and same_color
                    and overlap_y > 0.5 * min(box[3] - box[1], mb[3] - mb[1])):
                mb[0], mb[1] = min(mb[0], box[0]), min(mb[1], box[1])
                mb[2], mb[3] = max(mb[2], box[2]), max(mb[3], box[3])
                break
        else:
            merged.append({"box": list(box), "color": item["color"].copy()})

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    elements: list[Element] = []
    for item in merged:
        x1, y1, x2, y2 = item["box"]
        sub_mask = lab[y1:y2, x1:x2] > 0
        if not sub_mask.any():
            continue
        # 两个不同颜色的字有时是连通的，按色相再拆一次
        for piece in _color_masks(hsv[y1:y2, x1:x2], sub_mask):
            num, _, st, _ = cv2.connectedComponentsWithStats(piece.astype(np.uint8), 8)
            if num <= 1:
                continue
            k = 1 + int(np.argmax(st[1:, 4]))
            if int(st[k, 4]) < 100:
                continue
            px, py, pw, ph = (int(v) for v in st[k][:4])
            box = (x1 + px, y1 + py, x1 + px + pw, y1 + py + ph)
            pm = piece[py:py + ph, px:px + pw]
            pixels = img[box[1]:box[3], box[0]:box[2]][pm]
            if not len(pixels):
                continue
            bgr = tuple(float(v) for v in pixels.mean(axis=0))
            tilt, rows = _tilt(pm.astype(np.uint8))
            piece_mask = pm.astype(np.uint8)
            elements.append(Element(box=box, color=_color_name(np.array(bgr)),
                                    bgr=bgr, area=int(pm.sum()), tilt=tilt, tilt_len=rows,
                                    shape=_shape_of(piece_mask), mask=piece_mask))
    if not elements:
        raise SolveError("没有切出任何字符块")

    # 拆色可能对同一块重复产出，按「同色 + 中心接近」去重
    uniq: list[Element] = []
    for el in elements:
        cx, cy = el.center
        if any(u.color == el.color and abs(u.center[0] - cx) <= 6 and abs(u.center[1] - cy) <= 6
               for u in uniq):
            continue
        uniq.append(el)
    return img, uniq


# ---------------------------------------------------------------- 识别（含朝向）

def _normalize_angle(deg: int) -> int:
    deg = (-deg) % 360
    return deg - 360 if deg > 180 else deg


def _rotate(img: np.ndarray, deg: float, bg_bgr) -> np.ndarray:
    if not deg:
        return img
    h, w = img.shape[:2]
    diag = int(np.ceil(np.hypot(h, w)))
    pad = cv2.copyMakeBorder(img, (diag - h) // 2, diag - h - (diag - h) // 2,
                             (diag - w) // 2, diag - w - (diag - w) // 2,
                             cv2.BORDER_CONSTANT, value=bg_bgr)
    m = cv2.getRotationMatrix2D((pad.shape[1] / 2, pad.shape[0] / 2), deg, 1.0)
    return cv2.warpAffine(pad, m, (pad.shape[1], pad.shape[0]),
                          flags=cv2.INTER_CUBIC, borderValue=bg_bgr)


def _binary_variant(img: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray | None:
    """把 3D 立体字压成「白底黑字」，去掉阴影和描边，OCR 会稳一截。"""
    x1, y1, x2, y2 = box
    sub = img[y1:y2, x1:x2]
    if sub.size == 0:
        return None
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    v = hsv[..., 2].astype(np.int32)
    s = hsv[..., 1].astype(np.int32)
    if int(s.max()) > 80:                       # 彩色字：只留最亮的正面
        mask = ((s > 60) & (v >= int(v.max() * 0.82))).astype(np.uint8)
    else:                                       # 灰字：比背景暗的就是笔画
        mask = (v < int(np.median(v)) - 40).astype(np.uint8)
    if int(mask.sum()) < 50:
        return None
    ys, xs = np.where(mask > 0)
    mask = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    canvas = np.full((mask.shape[0] + 24, mask.shape[1] + 24), 255, np.uint8)
    canvas[12:12 + mask.shape[0], 12:12 + mask.shape[1]] = 255 - mask * 255
    scale = max(1, int(round(160 / max(12, min(canvas.shape[:2])))))
    return cv2.resize(canvas, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


# 候选字符全集（题目里只可能出现字母和数字）。概率表按这个顺序存，
# 用 numpy 向量化维护，避免每次 OCR 都做一遍 Python 字典循环。
_ALNUM_ORDER = string.digits + string.ascii_uppercase + string.ascii_lowercase
_ALNUM_POS = {ch: i for i, ch in enumerate(_ALNUM_ORDER)}
_ALNUM_N = len(_ALNUM_ORDER)


def _charset_slots(charset) -> np.ndarray | None:
    """字符集下标 -> 概率表槽位。只认字母数字，中文一律丢掉。"""
    if not charset:
        return None
    try:
        return np.array([_ALNUM_POS.get(ch, -1) for ch in charset], dtype=np.int64)
    except TypeError:
        return None


def recognize(ocr, img: np.ndarray, elements: list[Element], step: int = 30) -> None:
    """每个字符块跑「原图 + 亮面二值」两种输入的多角度 OCR，合并结果。

    除了 top-1 文本，还把每个候选字母数字的**最高出现概率**和对应角度记到
    ``el.prob`` / ``el.prob_angle`` 上。后续匹配不靠「OCR 说了什么」，
    而是靠「这个元素有多像题目要的字」，绕开 3D 字体的 top-1 误认。
    """
    bg_bgr = np.median(img.reshape(-1, 3), axis=0)
    slots = None
    slots_size = -1
    for el in elements:
        x1, y1, x2, y2 = el.box
        pad = 6
        crop = img[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
        if crop.size == 0:
            continue
        # 放大到短边约 160px：验证码字号只有 40px 上下，原尺寸送 OCR 几乎全错
        scale = max(1, int(round(160 / max(12, min(crop.shape[:2])))))
        variants = [(cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC),
                     bg_bgr)]
        binary = _binary_variant(img, el.box)
        if binary is not None:
            variants.append((binary, 255))

        prob = np.zeros(_ALNUM_N, dtype=np.float32)
        prob_angle = np.full(_ALNUM_N, -999, dtype=np.int32)
        found: dict[tuple[int, str], Observation] = {}
        for base, border in variants:
            for rot in range(0, 360, step):
                frame = _rotate(base, rot, border)
                ok, buf = cv2.imencode(".png", frame)
                if not ok:
                    continue
                try:
                    r = ocr.classification(buf.tobytes(), probability=True)
                except Exception:  # noqa: BLE001
                    continue
                angle = _normalize_angle(rot)
                # 老版本 ddddocr 的 probability=True 返回的是字符串而不是 dict，
                # 这里做一次类型判断：拿不到概率就退回纯 top-1 匹配，别让整轮崩掉。
                if not isinstance(r, dict):
                    text = str(r or "").strip()
                    if text:
                        obs = Observation(angle=angle, text=text, conf=0.5)
                        key = (angle, text)
                        if key not in found or obs.conf > found[key].conf:
                            found[key] = obs
                    continue

                probs = r.get("probabilities")
                if probs:
                    charset = r.get("charset") or []
                    if slots is None or slots_size != len(charset):
                        slots = _charset_slots(charset)
                        slots_size = len(charset)
                    if slots is not None:
                        arr = np.asarray(probs, dtype=np.float32)
                        # (时间步, 类别) 上按时间取最大：CTC 只在某一帧发出这个字符
                        per_class = arr.reshape(-1, arr.shape[-1]).max(axis=0)
                        # per_class 按 charset 下标索引，slots 是 charset 下标 -> 概率表槽位
                        keep = slots >= 0
                        if keep.any():
                            dest = slots[keep]
                            vals = per_class[keep]
                            better = vals > prob[dest]
                            if better.any():
                                hit = dest[better]
                                prob[hit] = vals[better]
                                prob_angle[hit] = angle

                text = (r.get("text") or "").strip()
                if not text:
                    continue
                obs = Observation(angle=angle, text=text,
                                  conf=float(r.get("confidence") or 0.0))
                key = (obs.angle, obs.text)
                if key not in found or obs.conf > found[key].conf:
                    found[key] = obs
        el.prob = prob
        el.prob_angle = prob_angle
        el.obs = sorted(found.values(), key=lambda o: -o.conf)
        if not el.obs:
            raise SolveError("字符块 (%d,%d) 在所有角度都没识别出内容" % el.center)


# ---------------------------------------------------------------- 提示语解析

_DESC_CHAR = re.compile(r"[A-Za-z0-9\u4e00-\u9fff]")


def _parse_target(text: str) -> Target:
    t = Target()
    for word in COLOR_WORDS:
        if word in text:
            t.color = word
            break
    if "大写" in text:
        t.upper = True
    elif "小写" in text:
        t.upper = False

    cleaned = text
    for word in COLOR_WORDS:
        cleaned = cleaned.replace(word, " ")
    # 形状词要先摘出来：它们是中文，会被 _DESC_CHAR 当成字符抽走，
    # 变成 OCR 去认一个根本不存在的字。
    for word in SHAPE_WORDS:
        if word in cleaned:
            t.shape = word
            cleaned = cleaned.replace(word, " ")
            break
    if t.shape:
        return t
    for word in ("大写", "小写", "字母", "字符", "文字", "图形", "的", "请", "点击", "选择"):
        cleaned = cleaned.replace(word, " ")
    chars = _DESC_CHAR.findall(cleaned)
    if chars:
        t.char = chars[-1]
    return t


def _target_ok(t: Target) -> bool:
    """目标描述里是否抓到了可匹配的东西（字符，或“球”这类形状词）。"""
    return bool(t.char or t.shape)


def parse_instruction(notice: str) -> Instruction:
    text = re.sub(r"\s+", "", notice or "")
    if not text:
        raise SolveError("提示语为空")

    # 1) 依次点击多个字符
    m = re.search(r"依次点击[:：]?(.*)$", text)
    if m:
        body = m.group(1)
        quoted = re.findall(r"['‘\"“「『]([^'’”\"」』]{1,4})['’”\"」』]", body)
        if quoted:
            return Instruction("sequence", [_parse_target(q) for q in quoted], text=text)
        chars = [c for c in _DESC_CHAR.findall(body)]
        if chars:
            return Instruction("sequence", [Target(char=c) for c in chars], text=text)

    # 2) 朝向/方向一样
    m = re.search(r"(.+?)(?:朝向|方向|角度)(?:一样|相同|一致)的?(.*)$", text)
    if m:
        ref = _parse_target(m.group(1))
        tgt = _parse_target(m.group(2))
        if _target_ok(ref) and _target_ok(tgt):
            return Instruction("same_orientation", [tgt], ref=ref, relation="same", text=text)

    # 2.5) 颜色一样：请点击大写K颜色一样的大写A
    m = re.search(r"(.+?)颜色(?:一样|相同|一致)的?(.*)$", text)
    if m:
        ref = _parse_target(m.group(1))
        tgt = _parse_target(m.group(2))
        if _target_ok(ref) and _target_ok(tgt):
            return Instruction("same_color", [tgt], ref=ref, relation="color", text=text)

    # 3) 空间方位
    m = re.search(r"(.+?)(正?上[方边]?|正?下[方边]?|正?左[边侧方]?|正?右[边侧方]?)(?:的)?(.+)$", text)
    if m:
        rel = {"上": "up", "下": "down", "左": "left", "右": "right"}
        direction = next(rel[k] for k in rel if k in m.group(2))
        ref = _parse_target(m.group(1))
        tgt = _parse_target(m.group(3))
        if _target_ok(ref) and _target_ok(tgt):
            return Instruction("spatial", [tgt], ref=ref, relation=direction, text=text)

    # 4) 姿态：侧向 / 倒置 / 正向（请点击侧向的小写o、请点击正向的大写G）
    for pose in ("侧向", "侧躺", "横躺", "躺倒", "倒置", "倒着", "正向"):
        if pose in text:
            body = text.split(pose, 1)[1].lstrip("的")
            tgt = _parse_target(body)
            if _target_ok(tgt):
                return Instruction("attitude", [tgt], relation=pose, text=text)

    # 5) 单个目标
    m = re.search(r"(?:点击|选择)(.+)$", text)
    if m:
        tgt = _parse_target(m.group(1))
        if _target_ok(tgt):
            # “正向”也可能以「请点击正向的大写G」这种形式落到这里，relation 带上，
            # _pick 才知道要按朝向而不是按置信度挑
            relation = "upright" if "正向" in m.group(1) else None
            return Instruction("single", [tgt], relation=relation, text=text)

    raise SolveError("提示语暂时无法解析：%s" % notice)


# ---------------------------------------------------------------- 匹配

# 这个 3D 字体在 OCR 眼里经常「变形」，把易混字符归组，
# 精确匹配失败时按组兜一次，置信度打折以免压过真正的精确命中。
# e/o、D/G、i/l、l/u 是这类立体字最常见的误认组合（实测样本里都出现过）。
_CONFUSE_GROUPS = ["0OoD", "1lI7", "2Z", "5S", "69", "8B", "dpqb", "unh", "ce",
                   "vuy", "mn", "MNW", "EF", "tfl", "G6", "AQ", "PR", "HV", "KY", "xz",
                   "eo", "DG", "il", "lu"]
_CONFUSE: dict[str, set[str]] = {}
for _g in _CONFUSE_GROUPS:
    for _c in _g:
        _CONFUSE.setdefault(_c, set()).update(_g)
_CONFUSE_PENALTY = 0.85


def _prob_at(el: Element, ch: str) -> float:
    """某个候选字符在这个元素上出现过的最高概率（0 表示从未出现）。"""
    if el.prob is None or not ch:
        return 0.0
    i = _ALNUM_POS.get(ch)
    return float(el.prob[i]) if i is not None else 0.0


def _prob_angle_of(el: Element, ch: str, default: int) -> int:
    """该字符概率最高时的旋转角，也就是「把它转成这个朝向」的角。

    这是比元素级 orientation 更好的朝向估计：orientation 是整个元素一个值，
    而这里是把元素转成**目标字符**最认得出来的那个角，两者天然可比。
    """
    if el.prob_angle is None:
        return default
    i = _ALNUM_POS.get(ch)
    if i is None:
        return default
    ang = int(el.prob_angle[i])
    return ang if ang > -900 else default


def _case_variants(char: str, upper: bool | None) -> tuple[str, ...]:
    if upper is True:
        return (char.upper(),)
    if upper is False:
        return (char.lower(),)
    return (char.lower(), char.upper())


# 概率地板：目标字符在这个元素上的最高概率低于它，就认为「这个元素不是它」。
# 宁可判定为认不出来换一张，也不要拿着一个 0.02 的匹配硬点——换图不到 1 秒，
# 点错则必然浪费一整轮。
_PROB_FLOOR = 0.08


def _obs_for(el: Element, char: str, upper: bool | None,
             allow_confuse: bool = True) -> tuple[Observation, bool] | None:
    """在这个元素里找目标字符，返回 (结果, 是否精确)。

    优先走**概率重排**：不问 top-1「这是什么字」，直接读目标字符在这个元素上的
    概率。这个 3D 字体经常把 L 认成 –、把 v 认成「小」、把大写 P 认成 d，
    top-1 错得离谱；但正确字符的概率往往仍排在前面（实测 P(L)=0.77，
    而 P(7)=P(h)=P(0)=0.0），区分度比 top-1 文本强得多。

    ``allow_confuse=False`` 时只认精确字形：形近组会把 9 当 6、7 当 L 混进候选，
    混进来必然点错（实测「黄色大写L朝向一样的数字6」就是这么点了灰色的 9）。
    """
    best_p = 0.0
    best_ch = ""
    for ch in _case_variants(char, upper):
        p = _prob_at(el, ch)
        if p > best_p:
            best_p, best_ch = p, ch
    if best_ch and best_p >= _PROB_FLOOR:
        angle = _prob_angle_of(el, best_ch, el.best.angle)
        return Observation(angle=angle, text=best_ch, conf=min(1.0, best_p)), True

    # 概率表不可用（老接口 / 取不到概率）时退回 top-1 文本匹配
    if upper is True:
        cands = [o for o in el.obs if o.text == char.upper()]
        if not cands:
            cands = [o for o in el.obs if o.text.upper() == char.upper()]
    elif upper is False:
        cands = [o for o in el.obs if o.text == char.lower()]
        if not cands:
            cands = [o for o in el.obs if o.text.lower() == char.lower()]
    else:
        cands = [o for o in el.obs if o.text.lower() == char.lower()]
    if cands:
        return max(cands, key=lambda o: o.conf), True

    if not allow_confuse:
        return None
    fam = _CONFUSE.get(char.upper())
    if not fam:
        return None
    loose = [o for o in el.obs if o.text and o.text.upper() in fam]
    if not loose:
        return None
    o = max(loose, key=lambda x: x.conf)
    return Observation(angle=o.angle, text=o.text, conf=o.conf * _CONFUSE_PENALTY), False


def _match(el: Element, t: Target, allow_confuse: bool) -> tuple[Observation, bool] | None:
    """把一个元素和目标描述对上；返回 (OCR 结果, 是否精确)。"""
    if t.shape:
        return (el.best, True) if el.shape == t.shape else None
    if not t.char:
        return None
    return _obs_for(el, t.char, t.upper, allow_confuse)


def _color_match(actual: str, want: str) -> bool:
    """颜色容差比较。

    立体字受高光/阴影影响，同一块的颜色落点会在阈值附近抖动（实测有黄色 8 被
    判成别的色，直接导致「找不到参考字符」）。严格相等会白白丢候选：
    黄↔橙、紫↔蓝互放，灰色系三档明度互通。
    """
    if actual == want:
        return True
    pair = {actual, want}
    if pair <= {"黄色", "橙色", "红色"}:
        return True
    if pair <= {"蓝色", "紫色"}:
        return True
    return pair <= {"灰色", "白色", "黑色"}


def _find(elements: list[Element], t: Target, strict: bool = False):
    """找元素来当参照；返回 (元素, 结果, 是否精确) 或 None。"""
    best = None
    best_score = -1.0
    for el in elements:
        if t.color and not _color_match(el.color, t.color):
            continue
        hit = _match(el, t, allow_confuse=True)
        if hit is None:
            continue
        obs, exact = hit
        # 精确命中加权，避免同分时被一个高置信度的混淆命中压过去
        score = obs.conf + (0.10 if exact else 0.0)
        if score > best_score:
            best, best_score = (el, obs, exact), score
    if best is None and t.color and not strict:
        # 颜色实在没命中才放宽颜色。字符仍是精确命中的，只是颜色落点抖了，
        # 所以保留原来的 exact 标记，不因为放宽颜色就贬低它。
        return _find(elements, Target(char=t.char, shape=t.shape, upper=t.upper), strict=True)
    return best


def _agree_colors(elements: list[Element], t: Target) -> list[tuple[Element, Observation]]:
    """目标候选：颜色匹配 + **精确**字符 / 形状匹配。

    这里绝不放宽字符：放宽等于往候选里掺必然点错的答案。宁可返回空列表，
    让调用方抛错换图（换一张不到 1 秒，比点错再换图划算得多）。
    """
    out = []
    for el in elements:
        if t.color and not _color_match(el.color, t.color):
            continue
        hit = _match(el, t, allow_confuse=False)
        if hit is not None:
            out.append((el, hit[0]))
    return out


def _resolve_ref(elements: list[Element], t: Target, verbose: bool = False):
    """解析参照元素；返回 (元素, 结果, 是否精确)，认不出返回 None。

    找不到时不再退到「按颜色+大小写硬猜」——猜出来的参照几乎必然点错，
    交出 None 让上层换图更划算。
    """
    hit = _find(elements, t, strict=True)
    if hit is not None and verbose and not hit[2]:
        print("[warn] 参照 %s 靠形近组硬凑到 %s，可靠性低" % (t, hit[0]))
    return hit


def _same_glyph(a: Element, b: Element) -> bool:
    """两个元素是不是同一个字（比 IoU 前置判断用）。"""
    ta, tb = (a.best.text or "").lower(), (b.best.text or "").lower()
    if not ta or not tb:
        return False
    if ta == tb:
        return True
    fam = _CONFUSE.get(ta.upper())
    return bool(fam and tb.upper() in fam)


def _angle_diff(a: int, b: int) -> int:
    d = abs(a - b) % 360
    return min(d, 360 - d)


# ------------------------------------------------------------ 朝向对齐度量
#
# orientation（逐行质心斜率）遇到 h / f / k 这种带升部的字符会被升部带偏，
# 实测样本里出现过「参照与两个候选的角度差都是 0，但只有一个是答案」的情况，
# 光靠角度数字根本区分不开。所以再补一套形状级的度量：把候选掩膜旋转，
# 看与参照掩膜的最大重合度（IoU），直接回答「这两个字转到一起像不像」。

_ALIGN_SIZE = 48


def _norm_mask(mask: np.ndarray) -> np.ndarray | None:
    """掩膜缩放到定长正方形画布，消掉大小差异，只留形状与朝向。"""
    if mask is None:
        return None
    ys, xs = np.where(mask > 0)
    if not len(ys):
        return None
    sub = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8)
    h, w = sub.shape[:2]
    if h < 5 or w < 5:
        return None
    scale = _ALIGN_SIZE / float(max(h, w))
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    small = cv2.resize(sub * 255, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((_ALIGN_SIZE, _ALIGN_SIZE), np.uint8)
    oy, ox = (_ALIGN_SIZE - nh) // 2, (_ALIGN_SIZE - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = small
    return (canvas > 110).astype(np.uint8)


def _rot_iou(a: np.ndarray, b: np.ndarray, deg: float) -> float:
    """a 绕中心旋转 deg 度后与 b 的 IoU。"""
    if abs(deg) < 1e-6:
        r = a
    else:
        m = cv2.getRotationMatrix2D((_ALIGN_SIZE / 2 - 0.5, _ALIGN_SIZE / 2 - 0.5), deg, 1.0)
        warped = cv2.warpAffine(a * 255, m, (_ALIGN_SIZE, _ALIGN_SIZE),
                                flags=cv2.INTER_NEAREST, borderValue=0)
        r = (warped > 110).astype(np.uint8)
    union = int(np.count_nonzero(r | b))
    return (int(np.count_nonzero(r & b)) / union) if union else 0.0


def _align_score(ref: Element, cand: Element) -> tuple[float, int]:
    """候选相对参照的朝向一致度，返回 (最大 IoU, 对应旋转角)。

    IoU 越接近 1 表示「把候选转个角度就和参照重合」，也就是朝向一样。
    掩膜不可用时返回 (0, 0)，由调用方退回角度比较。
    """
    a, b = ref._aligned, cand._aligned
    if a is None or b is None:
        return 0.0, 0
    best_iou, best_deg = -1.0, 0
    for deg in range(-90, 91, 6):
        s = _rot_iou(a, b, deg)
        if s > best_iou:
            best_iou, best_deg = s, deg
    return best_iou, best_deg


def _spatial_pick(elements: list[Element], ins: Instruction):
    ref = _find(elements, ins.ref)
    if ref is None or not ref[2]:
        raise SolveError("参照元素 %s 没认准（认错参照必然点错），换一张重试" % ins.ref)
    rx, ry = ref[0].center
    cands = [(el, o) for el, o in _agree_colors(elements, ins.targets[0]) if el is not ref[0]]
    if not cands:
        raise SolveError("找不到目标字符 %s" % ins.targets[0])

    def dist(item):
        cx, cy = item[0].center
        return (cx - rx) ** 2 + (cy - ry) ** 2

    if ins.relation == "up":
        cands = [c for c in cands if c[0].center[1] < ry] or cands
        cands.sort(key=lambda c: (abs(c[0].center[0] - rx), ry - c[0].center[1]))
    elif ins.relation == "down":
        cands = [c for c in cands if c[0].center[1] > ry] or cands
        cands.sort(key=lambda c: (abs(c[0].center[0] - rx), c[0].center[1] - ry))
    elif ins.relation == "left":
        cands = [c for c in cands if c[0].center[0] < rx] or cands
        cands.sort(key=lambda c: (abs(c[0].center[1] - ry), rx - c[0].center[0]))
    else:
        cands = [c for c in cands if c[0].center[0] > rx] or cands
        cands.sort(key=lambda c: (abs(c[0].center[1] - ry), c[0].center[0] - rx))
    return [cands[0][0]]


# ---------------------------------------------------------------- 主流程

def _pick(ins: Instruction, elements: list[Element], verbose: bool = False):
    """按解析出来的题型挑点，solve 与调试明细共用。"""
    if ins.kind == "sequence":
        out = []
        for t in ins.targets:
            hit = _find(elements, t)
            if hit is None:
                raise SolveError("依次点击：找不到 %s" % t)
            out.append(hit[0].center)
        return out

    if ins.kind == "same_orientation":
        ref = _resolve_ref(elements, ins.ref, verbose=verbose)
        if ref is None or not ref[2]:
            # 参照是整个判断的基准，靠形近硬凑的参照会让角度排序整体带偏，
            # 与其点错不如换图（换图不到 1 秒）。
            raise SolveError("参照字符 %s 没认准，换一张重试" % ins.ref)
        ref_el, ref_obs, _exact = ref
        cands = [(el, o) for el, o in _agree_colors(elements, ins.targets[0]) if el is not ref_el]
        if not cands:
            raise SolveError("目标 %s 没认出来，换一张重试" % ins.targets[0])
        # 朝向比较改用「目标字符各自最认得的旋转角」：参照是 0 就取 0 的角度，
        # 候选是 h 就取 h 的角度，语义一致可直接相比。元素级的 orientation
        # （逐行质心斜率）对 h/f/k 这类带升部的字会被带偏，样本里出现过
        # 「参照与两个候选角度差都是 0，但只有一个是答案」的情况。
        ref_angle = ref_obs.angle

        def cost(item):
            el, obs = item
            ang = _angle_diff(obs.angle, ref_angle)
            # 旋转 IoU 只有在两个字形相同的时候才有意义（比的是同一个字的姿态）。
            # 「朝向一样」的参照与目标几乎总是不同字形（如「红色数字0 朝向一样的 小写h」），
            # 那种情况下 IoU 比的是两个字的形状相似度，噪声极大，所以只用角度差。
            if _same_glyph(ref_el, el) and ref_el._aligned is not None:
                iou, _ = _align_score(ref_el, el)
                return (round((1.0 - iou) * 180.0, 2), ang, -obs.conf)
            return (float(ang), ang, -obs.conf)

        cands.sort(key=cost)
        if verbose:
            print("[pick] ref=%s(%s) 朝向%d；候选（朝向差,目标概率）%s -> %s" % (
                ref_el, ref_obs.text, ref_angle,
                [(el.center, _angle_diff(o.angle, ref_angle), round(o.conf, 3))
                 for el, o in cands],
                cands[0][0].center))
        return [cands[0][0].center]

    if ins.kind == "same_color":
        ref = _resolve_ref(elements, ins.ref, verbose=verbose)
        if ref is None or not ref[2]:
            raise SolveError("参照字符 %s 没认准，换一张重试" % ins.ref)
        ref_el = ref[0]
        want = Target(char=ins.targets[0].char, shape=ins.targets[0].shape,
                      upper=ins.targets[0].upper, color=ref_el.color)
        hits = [(el, o) for el, o in _agree_colors(elements, want) if el is not ref_el]
        if len(hits) != 1:
            # 0 个是没认出来；多个说明同色同字符不止一个、无法区分。
            # 两种情况猜哪个都是错，直接换图。
            raise SolveError("与 %s 同色（%s）的 %s 匹配到 %d 个，无法确定，换一张重试"
                             % (ins.ref, ref_el.color, ins.targets[0], len(hits)))
        if verbose:
            print("[pick] ref=%s（%s）同色目标 -> %s" % (ref_el, ref_el.color, hits[0][0]))
        return [hits[0][0].center]

    if ins.kind == "spatial":
        picked = _spatial_pick(elements, ins)
        return [p.center for p in picked]

    if ins.kind == "attitude":
        cands = _agree_colors(elements, ins.targets[0])
        if not cands:
            # 认不出来就别硬凑：侧躺的 3D 字 OCR 经常崩，硬凑等于随机点，
            # 换一张重来的期望收益高得多。
            raise SolveError("目标 %s 没认出来，换一张重试" % ins.targets[0])
        if ins.relation in ("倒置", "倒着"):
            # 倒置：竖笔的倾斜没变化，只能靠 OCR 在 180° 附近认出来
            cands.sort(key=lambda c: _angle_diff(c[1].angle, 180))
        elif ins.relation == "正向":
            # 正向：挑转正目标字符所需角度最小的那个
            cands.sort(key=lambda c: (abs(c[1].angle), -c[1].conf))
        else:
            # 侧向：需要转约 ±90° 才认得出，即躺平
            cands.sort(key=lambda c: abs(abs(c[1].angle) - 90))
        if verbose:
            print("[pick] %s 候选（角度,概率）%s -> %s" % (
                ins.relation,
                [(c[0].center, c[1].angle, round(c[1].conf, 3)) for c in cands],
                cands[0][0].center))
        return [cands[0][0].center]

    if ins.kind == "single":
        hits = _agree_colors(elements, ins.targets[0])
        if not hits:
            raise SolveError("找不到 %s" % ins.targets[0])
        if ins.relation == "upright":
            # 「请点击正向的大写G」：同字符有多个时，端正的才是答案
            hits.sort(key=lambda c: (abs(c[1].angle), -c[1].conf))
        else:
            hits.sort(key=lambda c: -c[1].conf)
        if verbose:
            print("[pick] single 候选 %s -> %s" % (
                [(c[0].center, c[1].conf) for c in hits], hits[0][0].center))
        return [hits[0][0].center]

    raise SolveError("未支持的题型：%s" % notice)


def solve(
    notice: str, png: bytes, ocr=None, verbose: bool = False, detail: bool = False
):
    """识别并返回点选坐标；detail=True 时附带元素明细与解析结果（调试用）。"""
    img, elements = segment(png)

    heights = [el.box[3] - el.box[1] for el in elements]
    med = float(np.median(heights)) if heights else 0.0
    for el in elements:
        el.tall = (el.box[3] - el.box[1]) >= 0.86 * med

    if ocr is None:
        import ddddocr

        ocr = ddddocr.DdddOcr(show_ad=False)
    recognize(ocr, img, elements)
    ins = parse_instruction(notice)
    if verbose:
        print("[seg] " + " | ".join(str(e) for e in elements))
        print("[parse] kind=%s ref=%s targets=%s rel=%s" % (
            ins.kind, ins.ref, [str(t) for t in ins.targets], ins.relation))
    points = _pick(ins, elements, verbose)
    if detail:
        return points, elements, ins
    return points


def annotate(png: bytes, points: list[tuple[int, int]]) -> bytes:
    """把识别结果画到放大 2 倍的图上，便于肉眼核对点得对不对。"""
    img = _decode(png)
    canvas = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    for i, (x, y) in enumerate(points, 1):
        c = (x * 2, y * 2)
        cv2.circle(canvas, c, 16, (0, 0, 255), 2)
        cv2.circle(canvas, c, 2, (0, 0, 255), -1)
        cv2.putText(canvas, str(i), (c[0] + 18, c[1] - 12),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2, cv2.LINE_AA)
    ok, buf = cv2.imencode(".png", canvas)
    return buf.tobytes() if ok else b""
