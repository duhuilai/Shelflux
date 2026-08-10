// 生成 macOS 用的 icons/icon.icns
// 手动组装 Apple .icns 容器：magic + 各尺寸 PNG 条目（OSType + 长度 + 数据）
// 源图为 src-tauri/icons/icon.png（512x512），按需放大到 1024。

import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "src-tauri/icons/icon.png");
const out = join(root, "src-tauri/icons/icon.icns");

// OSType -> 目标边长(px)
const entries = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
];

async function render(size) {
  const buf = await sharp(src)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return buf;
}

function be32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

const chunks = [];
for (const [ostype, size] of entries) {
  const png = await render(size);
  const head = Buffer.concat([Buffer.from(ostype, "ascii"), be32(8 + png.length)]);
  chunks.push(head, png);
  console.log(`  ${ostype} ${size}x${size}: ${png.length} bytes`);
}

const body = Buffer.concat(chunks);
const header = Buffer.concat([Buffer.from("icns", "ascii"), be32(8 + body.length)]);
const icns = Buffer.concat([header, body]);

writeFileSync(out, icns);
console.log(`written ${out} (${icns.length} bytes)`);
