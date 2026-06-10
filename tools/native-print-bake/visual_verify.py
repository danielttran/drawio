import os
from PIL import Image, ImageChops

def get_headless_bbox(img):
    # Headless image is RGBA. Find bounding box of non-transparent and non-white pixels.
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    width, height = img.size
    left, top, right, bottom = width, height, 0, 0
    data = img.load()
    for y in range(height):
        for x in range(width):
            r, g, b, a = data[x, y]
            # Content pixel: opaque enough and not pure white
            if a > 10 and (r < 254 or g < 254 or b < 254):
                if x < left: left = x
                if x > right: right = x
                if y < top: top = y
                if y > bottom: bottom = y
    if left > right or top > bottom:
        return (0, 0, width, height)
    # Add a small padding
    return (max(0, left - 10), max(0, top - 10), min(width, right + 10), min(height, bottom + 10))

def get_editor_bbox(img):
    # Editor image is RGB with light grid lines/white background.
    if img.mode != 'RGB':
        img = img.convert('RGB')
    width, height = img.size
    left, top, right, bottom = width, height, 0, 0
    data = img.load()
    for y in range(height):
        for x in range(width):
            r, g, b = data[x, y]
            # Draw.io editor grid lines and background are very light (> 240).
            # Any pixel with significant color or darkness is diagram content.
            if r < 240 or g < 240 or b < 240:
                if x < left: left = x
                if x > right: right = x
                if y < top: top = y
                if y > bottom: bottom = y
    if left > right or top > bottom:
        return (0, 0, width, height)
    return (max(0, left - 10), max(0, top - 10), min(width, right + 10), min(height, bottom + 10))

def main():
    editor_path = 'tools/native-print-bake/editor-view.png'
    headless_path = 'tools/native-print-bake/test-headless-300.png'
    out_path = 'tools/native-print-bake/visual_comparison.png'

    if not os.path.exists(editor_path):
        print(f"Error: {editor_path} not found")
        return
    if not os.path.exists(headless_path):
        print(f"Error: {headless_path} not found")
        return

    print("Loading images...")
    editor_img = Image.open(editor_path)
    headless_img = Image.open(headless_path)

    print("Computing diagram bounding boxes...")
    e_box = get_editor_bbox(editor_img)
    h_box = get_headless_bbox(headless_img)

    print(f"Editor diagram bbox: {e_box}")
    print(f"Headless diagram bbox: {h_box}")

    e_crop = editor_img.crop(e_box).convert('RGB')
    h_crop = headless_img.crop(h_box).convert('RGB')

    # Resize headless crop to match the width of editor crop for aligned comparison
    target_width = e_crop.width
    scale = target_width / h_crop.width
    target_height = int(h_crop.height * scale)
    h_crop_resized = h_crop.resize((target_width, target_height), Image.Resampling.LANCZOS)

    # Create a side-by-side comparison image
    spacing = 40
    comp_width = target_width * 2 + spacing
    comp_height = max(e_crop.height, target_height)

    # White background for comparison canvas
    comp_img = Image.new('RGB', (comp_width, comp_height), (255, 255, 255))
    
    # Paste editor view on the left
    comp_img.paste(e_crop, (0, 0))
    # Paste headless preview on the right
    comp_img.paste(h_crop_resized, (target_width + spacing, 0))

    # Save visual comparison
    comp_img.save(out_path)
    print(f"Saved side-by-side visual comparison to {out_path} ({comp_img.size})")

if __name__ == '__main__':
    main()
