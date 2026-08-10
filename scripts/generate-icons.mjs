// 生成 Tauri 所需的应用图标集
// 从 source-icon.jpg 生成 32、128、128@2x、256、512、icon.png、icon.ico、icon.icns

import sharp from "sharp";
import { mkdir, writeFile, readFile, copyFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, "..");
const SOURCE = join(PROJECT_ROOT, "source-icon.jpg");
const ICON_DIR = join(PROJECT_ROOT, "src-tauri", "icons");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");

// Tauri 2 所需图标列表
const PNG_TARGETS = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
  // 额外的 store 图标
  { name: "Square30x30Logo.png", size: 30 },
  { name: "Square44x44Logo.png", size: 44 },
  { name: "Square71x71Logo.png", size: 71 },
  { name: "Square89x89Logo.png", size: 89 },
  { name: "Square107x107Logo.png", size: 107 },
  { name: "Square142x142Logo.png", size: 142 },
  { name: "Square150x150Logo.png", size: 150 },
  { name: "Square284x284Logo.png", size: 284 },
  { name: "Square310x310Logo.png", size: 310 },
  { name: "StoreLogo.png", size: 50 },
];

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function generatePngs() {
  if (!existsSync(SOURCE)) {
    console.error(`Source icon not found: ${SOURCE}`);
    process.exit(1);
  }
  await ensureDir(ICON_DIR);
  await ensureDir(PUBLIC_DIR);

  // 加载并保证是正方形（带轻微圆角化）
  const src = sharp(SOURCE);
  const meta = await src.metadata();
  console.log(`Source: ${meta.width}x${meta.height}`);

  for (const t of PNG_TARGETS) {
    const out = join(ICON_DIR, t.name);
    await sharp(SOURCE)
      .resize(t.size, t.size, { fit: "cover", position: "center" })
      .png()
      .toFile(out);
    console.log(`✓ ${t.name} (${t.size}x${t.size})`);
  }

  // 复制 icon.png 为 favicon 风格的 svg（仅占位）
  // 实际 favicon 用 svg 重新画
  await writeFile(
    join(PUBLIC_DIR, "icon.svg"),
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7aa2f7"/>
      <stop offset="1" stop-color="#bb9af7"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#g)"/>
  <path d="M22 19 L36 32 L22 45" stroke="white" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M40 45 C 44 35, 52 35, 56 25 C 56 25, 50 22, 46 26 C 50 18, 56 14, 60 14 C 60 18, 56 24, 50 28 C 54 24, 56 22, 56 22" stroke="white" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>
</svg>
`
  );
  console.log("✓ public/icon.svg");

  // 生成 favicon.ico（包含 32、16 两帧）—— 使用 to-ico 也可，这里简化
  await generateIco();
  await generateIcns();
  console.log("\n✅ 图标集生成完成");
}

async function generateIco() {
  // 简单方案：使用 png 拼成 ico
  // sharp 不直接支持 ico 输出，需要 png-to-ico
  let pngToIco;
  try {
    pngToIco = (await import("png-to-ico")).default;
  } catch {
    console.warn("png-to-ico 未安装，跳过 .ico 生成（运行 npm i -D png-to-ico）");
    return;
  }
  const sizes = [16, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(
    sizes.map((s) =>
      sharp(SOURCE).resize(s, s, { fit: "cover" }).png().toBuffer()
    )
  );
  const ico = await pngToIco(buffers);
  await writeFile(join(ICON_DIR, "icon.ico"), ico);
  console.log("✓ icon.ico");
}

async function generateIcns() {
  // macOS ico -> icns 较复杂，且不强制（Windows build 不需要）
  // 这里使用 png-to-icns
  try {
    const mod = await import("png-to-icns");
    const pngToIcns = mod.default || mod;
    const buffers = {
      ic07: await sharp(SOURCE).resize(128, 128).png().toBuffer(),
      ic08: await sharp(SOURCE).resize(256, 256).png().toBuffer(),
      ic09: await sharp(SOURCE).resize(512, 512).png().toBuffer(),
      ic10: await sharp(SOURCE).resize(1024, 1024).png().toBuffer(),
    };
    const icns = await pngToIcns(buffers);
    await writeFile(join(ICON_DIR, "icon.icns"), icns);
    console.log("✓ icon.icns");
  } catch (e) {
    console.warn("png-to-icns 未安装或失败，跳过 .icns 生成（运行 npm i -D png-to-icns）");
    console.warn("  macOS 打包需要此文件，但开发阶段不影响");
  }
}

generatePngs().catch((e) => {
  console.error(e);
  process.exit(1);
});
