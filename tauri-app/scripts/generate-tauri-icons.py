from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri" / "icons"
SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
MARK_SCALE = 1.45


def scaled(points: list[tuple[float, float]], scale: int) -> list[tuple[int, int]]:
    return [(round(x * scale), round(y * scale)) for x, y in points]


def render_icon(size: int) -> Image.Image:
    scale = 8 if size <= 64 else 4
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas, "RGBA")

    def xy(value: float) -> float:
        return value * size * scale / 1024

    def mark(value: float) -> float:
        return 512 + (value - 512) * MARK_SCALE

    def shape(points: list[tuple[float, float]], fill: tuple[int, int, int, int]) -> None:
        draw.polygon(scaled([(xy(mark(x)), xy(mark(y))) for x, y in points], 1), fill=fill)

    # Small taskbar sizes need a full, high-contrast mark more than micro-detail.
    shape([(236, 340), (614, 558), (498, 625), (236, 474)], (198, 246, 255, 255))
    shape([(498, 625), (614, 558), (786, 459), (786, 595), (438, 796), (330, 734)], (90, 209, 212, 255))
    shape([(236, 474), (498, 625), (392, 686), (236, 596)], (96, 144, 175, 255))
    shape([(330, 734), (438, 796), (276, 796), (194, 748)], (18, 48, 62, 230))
    shape([(236, 340), (614, 558), (530, 607), (236, 438)], (170, 235, 255, 255))

    underline_width = max(2 * scale, round(size * scale * 0.12))
    draw.line(
        [(xy(mark(242)), xy(mark(790))), (xy(mark(782)), xy(mark(790)))],
        fill=(255, 111, 72, 255),
        width=round(underline_width * MARK_SCALE),
    )

    # A compact Rust/Tauri accent that remains readable at 24-32 px.
    accent = [
        (xy(mark(604)), xy(mark(636))),
        (xy(mark(678)), xy(mark(678))),
        (xy(mark(604)), xy(mark(720))),
        (xy(mark(530)), xy(mark(678))),
    ]
    draw.polygon(scaled(accent, 1), fill=(255, 131, 93, 255))

    if size >= 64:
        cross_width = max(2 * scale, round(size * scale * 0.035))
        draw.line([(xy(mark(572)), xy(mark(678))), (xy(mark(636)), xy(mark(678)))], fill=(255, 244, 236, 230), width=round(cross_width * MARK_SCALE))
        draw.line([(xy(mark(604)), xy(mark(646))), (xy(mark(604)), xy(mark(710)))], fill=(255, 244, 236, 230), width=round(cross_width * MARK_SCALE))

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def save_ico(entries: dict[int, bytes], path: Path) -> None:
    sizes = ICO_SIZES
    header_size = 6 + 16 * len(sizes)
    offset = header_size
    directory = bytearray()
    payload = bytearray()

    for size in sizes:
        data = entries[size]
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                0 if size == 256 else size,
                0 if size == 256 else size,
                0,
                0,
                1,
                32,
                len(data),
                offset,
            )
        )
        payload.extend(data)
        offset += len(data)

    path.write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) + directory + payload)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    png_entries: dict[int, bytes] = {}

    for size in SIZES:
        icon = render_icon(size)
        name = "128x128@2x.png" if size == 256 else f"{size}x{size}.png"
        if size == 256:
            icon.save(ICON_DIR / "256x256.png")
        icon.save(ICON_DIR / name)
        buffer = io.BytesIO()
        icon.save(buffer, format="PNG")
        png_entries[size] = buffer.getvalue()

    render_icon(1024).save(ICON_DIR / "app-icon.png")
    save_ico(png_entries, ICON_DIR / "icon.ico")


if __name__ == "__main__":
    main()
