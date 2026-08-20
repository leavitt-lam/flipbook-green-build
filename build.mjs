#!/usr/bin/env node
/**
 * flipbook_tool 构建脚本
 *
 * 输入（相对于本文件所在工程根）：
 *   src/converter.html        转换器页面（含 __VIEWER_TEMPLATE_JSON__ / __LIBS_PDFJS__ / __LIBS_WORKER__ / <!--__CONV_LIBS__--> 占位符）
 *   src/viewer.template.html  查看器模板（含 __FLIPBOOK_DATA__ / __VIEWER_LIBS__ 运行时占位符，构建时保持原样）
 *   src/app.js  src/detect.js 转换器逻辑
 *   libs/                      pdf.mjs / pdf.worker.mjs / jszip.min.js（pdf.js 5.7.284 legacy）
 *
 * 说明：pdf.js 5.x 为 ESM 构建。主库经「尾部 export → globalThis.pdfjsLib」改写后
 *       以 <script type="module"> 内联（含 worker 的 Blob URL 注册），画册与转换器
 *       均为单文件可用（file:// 打开无需外部依赖）。
 *
 * 输出（发布根目录）：
 *   index.html + app.js + detect.js
 * 生成器始终位于压缩包最外层；libs/ 仅保留构建依赖与 jszip。
 *
 * 用法：node build.mjs
 * 构建是幂等的：相同源码重复构建结果一致。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = ROOT;

// ── 工具 ─────────────────────────────────────────────
function fail(msg) {
  console.error('[build] 失败：' + msg);
  process.exit(1);
}

function read(name) {
  try {
    return readFileSync(path.join(ROOT, name), 'utf8');
  } catch (e) {
    fail('无法读取 ' + name + '：' + e.message);
  }
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/** 把源码文本安全地嵌入 HTML 的 <script> 字符串：转义 < 为 \u003c 防止 </script> 提前闭合 */
function toJsString(src) {
  return JSON.stringify(src).replace(/</g, '\\u003c');
}

/**
 * pdf.js 5.x ESM 主库 → 全局变量版：
 * 保留尾部 export 行（<script type="module"> 内联时 export 合法），
 * 追加一行 globalThis.pdfjsLib 赋值（引用 module 顶层导出的名字）。
 * 注：不能把 export 行替换掉——pdf.mjs 中部的 webpack 代码里可能还有
 * "export {" 字符串，非行首锚定的正则会把整段代码替换掉，破坏语法。
 */
function toGlobalPdfjs(src) {
  const m = src.match(/^export \{ [\s\S]* \};/m);
  if (!m) fail('pdf.mjs 中未找到行首 export 行');
  const inner = m[0].slice('export {'.length, -' };'.length).trim();
  const pairs = [];
  for (const item of inner.split(',')) {
    const t = item.trim();
    if (!t) continue;
    if (t.includes(' as ')) {
      const [local, name] = t.split(' as ').map((s) => s.trim());
      pairs.push(`${name}: ${local}`);
    } else {
      pairs.push(`${t}: ${t}`);
    }
  }
  return src + `\nglobalThis.pdfjsLib = { ${pairs.join(', ')} };\n`;
}

/** worker 的 Blob URL 注册代码（内联在 module script 中，供 pdf.js fake/真实 worker 使用） */
function workerBlobSetup(workerJson) {
  return 'pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([' +
    workerJson +
    '], { type: "text/javascript" }));\n' +
    'if (globalThis.__pdfjsReadyResolve) globalThis.__pdfjsReadyResolve();';
}

// ── 1. 读取并校验模板 ────────────────────────────────
const viewerTpl = read('src/viewer.template.html');
for (const ph of ['__FLIPBOOK_DATA__', '<!--__VIEWER_LIBS__-->']) {
  const n = countOccurrences(viewerTpl, ph);
  if (n !== 1) fail(`查看器模板中占位符 ${ph} 应为 1 个，实际 ${n} 个`);
}
for (const ph of ['__VIEWER_TEMPLATE_JSON__', '__LIBS_PDFJS__', '__LIBS_WORKER__']) {
  if (viewerTpl.includes(ph)) fail(`查看器模板不应包含转换器占位符 ${ph}`);
}

const converterHtml = read('src/converter.html');
for (const ph of ['__VIEWER_TEMPLATE_JSON__', '__LIBS_PDFJS__', '__LIBS_WORKER__', '<!--__CONV_LIBS__-->']) {
  const n = countOccurrences(converterHtml, ph);
  if (n !== 1) fail(`转换器页面中占位符 ${ph} 应为 1 个，实际 ${n} 个`);
}

// ── 2. 读取库并改写 ──────────────────────────────────
const libPdf = read('libs/pdf.mjs');
const libPdfModule = toGlobalPdfjs(libPdf); // 画册/转换器内联的 module 主体（含 globalThis.pdfjsLib 赋值）
const libWorker = read('libs/pdf.worker.mjs');
const libJsZip = read('libs/jszip.min.js');
if (!libPdfModule.includes('globalThis.pdfjsLib') || !libWorker.includes('WorkerMessageHandler') || !libJsZip.includes('JSZip')) {
  fail('libs/ 内容异常，请检查库文件');
}

// ── 3. 组装转换器 index.html ─────────────────────────
// 转换器页面自身的 pdf.js：内联 module script（主库 + worker Blob + ready 信号）
const convLibs =
  '<script type="module">\n' +
  libPdfModule.replace(/<\/script/gi, '<\\/script') + '\n' +
  workerBlobSetup(toJsString(libWorker)).replace(/<\/script/gi, '<\\/script') + '\n' +
  '</script>';

// 占位符替换统一用 split/join（String.replace 的替换串中 $ 有特殊含义——
// 库代码/JSON 里的 $&、$` 等序列会被展开成占位符文本，产生“幽灵占位符”）
const built = converterHtml
  .split('__VIEWER_TEMPLATE_JSON__').join(toJsString(viewerTpl))
  .split('__LIBS_PDFJS__').join(toJsString(libPdfModule))
  .split('__LIBS_WORKER__').join(toJsString(libWorker))
  .split('<!--__CONV_LIBS__-->').join(convLibs);

// ── 4. 校验产物 ──────────────────────────────────────
// 注：pdf.worker.mjs 内部恰好含 "__LIBS_WORKER__" 字符串（webpack 查表常量），
//     因此 __LIBS_WORKER__ 仅校验赋值语句形式（源码占位符写法）是否残留。
for (const ph of ['__VIEWER_TEMPLATE_JSON__', '__LIBS_PDFJS__']) {
  if (built.includes(ph)) fail(`构建产物仍残留占位符 ${ph}`);
}
if (built.includes('= __LIBS_WORKER__')) fail('构建产物仍残留占位符 __LIBS_WORKER__（源码赋值形式）');
if (built.includes('<!--__CONV_LIBS__-->')) fail('构建产物仍残留占位符 __CONV_LIBS__');
// 查看器模板内部的运行时占位符允许以 JSON 转义形式存在，但不得以明文 HTML 注释形式泄漏
if (built.includes('<!--__VIEWER_LIBS__-->')) {
  fail('构建产物中 __VIEWER_LIBS__ 占位符泄漏为明文注释');
}

// ── 5. 输出 ──────────────────────────────────────────
mkdirSync(path.join(DIST, 'libs'), { recursive: true });
for (const rel of ['index.html', 'app.js', 'detect.js', 'catalog.pdf', 'libs/pdf.min.js', 'libs/pdf.worker.min.js']) {
  try { unlinkSync(path.join(DIST, rel)); } catch (e) { /* 不存在则忽略 */ }
}
writeFileSync(path.join(DIST, 'index.html'), built);
cpSync(path.join(ROOT, 'src', 'app.js'), path.join(DIST, 'app.js'));
cpSync(path.join(ROOT, 'src', 'detect.js'), path.join(DIST, 'detect.js'));

console.log('[build] 构建完成 →', DIST);
console.log('[build] index.html:', (built.length / 1024).toFixed(1) + ' KB');
