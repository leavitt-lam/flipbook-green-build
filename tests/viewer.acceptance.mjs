#!/usr/bin/env node
/**
 * 查看器 headless 验收（任务书 7.4 / 8；v3.2.0 新增 DPR=2 居中/文字层对齐场景）
 * 生成一个小型测试画册 → headless Chrome 打开（file:// 与 ?selftest=1）→ 断言页面状态。
 *
 * 前置：本机需有 Chrome/Edge（环境变量 CHROME 可指定路径）
 * 运行：node tests/viewer.acceptance.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, '.tmp_acceptance');

const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => existsSync(p));
if (!CHROME) {
  console.error('❌ 未找到 Chrome/Edge，请设置环境变量 CHROME');
  process.exit(1);
}

// ── 生成小画册（base64 内嵌，含 zones 与印刷页码）──
function buildViewer() {
  const conv = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  function extractVar(name) {
    const start = conv.indexOf('const ' + name + ' = ');
    const lineEnd = conv.indexOf('\n', start);
    return new Function(conv.slice(start, lineEnd) + '; return ' + name + ';')();
  }
  const VIEWER_TEMPLATE = extractVar('VIEWER_TEMPLATE');
  const LIBS_PDFJS = extractVar('LIBS_PDFJS');
  const LIBS_WORKER = extractVar('LIBS_WORKER');
  // 微型 PDF：手写一个含 2 页的最小 PDF（页面内容为可渲染图形）
  const tinyPdf = makeTinyPdf();
  const b64 = Buffer.from(tinyPdf, 'binary').toString('base64');
  const data = {
    title: '验收测试画册',
    totalPages: 2,
    tocPage: 1,
    zones: [
      { page: 1, name: 'PRODUCT A', x: 0.1, y: 0.2, w: 0.3, h: 0.15, target: 2 },
    ],
    pdfBase64: b64,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // v3.2.2: pdf.js 5.x ESM → 主库 module 内联 + worker Blob URL（与 app.js 生成逻辑一致；
  // worker 源码须 JSON.stringify 成字符串字面量，裸插会被解析成代码）
  const workerJson = JSON.stringify(LIBS_WORKER).replace(/</g, '\\u003c');
  const inlineLibs =
    '<script type="module">' + LIBS_PDFJS.replace(/<\/script/gi, '<\\/script') + '\n' +
    'pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([' + workerJson + '], { type: "text/javascript" }));\n' +
    'if (globalThis.__pdfjsReadyResolve) globalThis.__pdfjsReadyResolve();\n' +
    '</script>';
  // 占位符替换用 split/join（String.replace 替换串中 $ 有特殊含义，会展开成占位符文本）
  const html = VIEWER_TEMPLATE
    .split('__FLIPBOOK_DATA__').join(json)
    .split('<!--__VIEWER_LIBS__-->').join(inlineLibs);
  mkdirSync(path.join(OUT, 'libs'), { recursive: true });
  writeFileSync(path.join(OUT, 'index.html'), html);
  writeFileSync(path.join(OUT, 'libs', 'pdf.mjs'), LIBS_PDFJS);
  writeFileSync(path.join(OUT, 'libs', 'pdf.worker.mjs'), LIBS_WORKER);
}

// 生成一个最小合法 PDF（2 页，各一页矩形+文字）
function makeTinyPdf() {
  function page(objId, contentId) {
    return [
      objId + ' 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 400 300] /Contents ' + contentId + ' 0 R /Resources << /Font << /F1 6 0 R >> >> >>\nendobj\n',
    ].join('');
  }
  function stream(id, s) {
    return id + ' 0 obj\n<< /Length ' + s.length + ' >>\nstream\n' + s + '\nendstream\nendobj\n';
  }
  const s1 = 'BT /F1 24 Tf 50 200 Td (PRODUCT A) Tj ET';
  const s2 = 'BT /F1 24 Tf 50 200 Td (PRODUCT B) Tj ET';
  const pdf = '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 400 300] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>\nendobj\n' +
    '3 0 obj\n<< /Type /Pages /Kids [2 0 R 7 0 R] /Count 2 >>\nendobj\n' +
    stream(4, s1) +
    '5 0 obj\n<< /Type /Catalog >>\nendobj\n' +
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
    '7 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 400 300] /Contents 8 0 R /Resources << /Font << /F1 6 0 R >> >> >>\nendobj\n' +
    stream(8, s2) +
    'trailer\n<< /Root 1 0 R /Size 9 >>\n%%EOF\n';
  return pdf;
}

function chrome(args) {
  return execFileSync(CHROME, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '✅' : '❌'), name, detail ? '— ' + detail : '');
  if (!cond) failures++;
}

// ── 场景 1：基础渲染（file://，无自测脚本）──
// 注：本机 Chrome 的 --dump-dom 在管道下无输出（GUI stdout 问题），
// 统一改用 CDP 调试端口取 outerHTML，兼容中文路径。
const fileUrl = (p) => 'file:///' + path.resolve(p).split(path.sep).join('/').split('/').map(encodeURIComponent).join('/');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Windows 下 Chrome 会派生大量子进程，proc.kill 只杀父进程会泄漏实例，
// 导致后续场景端口/资源耗尽而卡死——用 taskkill 杀整个进程树
function killProc(proc) {
  try { if (proc && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  try { if (proc) proc.kill('SIGKILL'); } catch (e) {}
}

const CHROME_ARGS = [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--no-first-run', '--disable-default-apps',
];

function cdpConnect(port) {
  return (async () => {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await fetch('http://127.0.0.1:' + port + '/json').then(r => r.json());
        if (targets.length) break;
      } catch (e) { /* 端口未就绪 */ }
      await sleep(250);
    }
    if (!targets || !targets.length) throw new Error('无法连接调试端口 ' + port);
    const page = targets.find(t => t.type === 'page') || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 1;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise(res => {
      const id = msgId++;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    return { ws, send };
  })();
}

// 通用 CDP 求值：启动 headless Chrome（可附加参数如 --force-device-scale-factor=2），
// 等待页面 complete（可选额外等待条件），再对 expression 求值返回结果。
async function cdpEval(url, expression, { settleMs = 9000, waitExpr = null, args = [] } = {}) {
  const port = 9500 + Math.floor(Math.random() * 700);
  const proc = spawn(CHROME, [
    ...CHROME_ARGS,
    '--window-size=1280,900', '--remote-debugging-port=' + port,
    ...args, url,
  ], { stdio: 'ignore' });
  try {
    const { send } = await cdpConnect(port);
    // 等 DOMContentLoaded
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      const st = (r && r.result && r.result.result && r.result.result.value) || '';
      if (st === 'complete') break;
      await sleep(250);
    }
    // 可选：等画册真正就绪（如 canvas 非零尺寸）
    if (waitExpr) {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const r = await send('Runtime.evaluate', { expression: waitExpr, returnByValue: true });
        if (r && r.result && r.result.result && r.result.result.value) break;
        await sleep(250);
      }
    }
    await sleep(settleMs);
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return (r && r.result && r.result.result && r.result.result.value) || '';
  } finally {
    killProc(proc);
  }
}

async function cdpDump(url, settleMs = 9000) {
  return cdpEval(url, 'document.documentElement.outerHTML', { settleMs });
}

async function sceneBasic() {
  const dom = await cdpDump(fileUrl(path.join(OUT, 'index.html')));
  check('页面标题正确', dom.includes('验收测试画册'), 'topbar-title');
  check('canvas 已渲染', /canvas id="canvas-a" width="[1-9]/.test(dom), 'canvas-a 有非零尺寸');
  check('文字层有内容', /class="text-layer"[\s\S]*?<span/.test(dom) || dom.includes('PRODUCT A'), 'text-layer span');
  check('无致命遮罩', !dom.includes('id="fatal-overlay"'), 'fatal-overlay 未创建');
  check('目录热区已构建', dom.includes('class="zone"'), 'zone 元素');
}

// ── 场景 2：自测模式（CDP 真实时间驱动，避免虚拟时间与主线程渲染互斥）──

async function cdpWaitTitle(url, timeoutMs = 45000) {
  const port = 9400 + Math.floor(Math.random() * 800);
  const proc = spawn(CHROME, [
    ...CHROME_ARGS,
    '--window-size=1280,900', '--remote-debugging-port=' + port, url,
  ], { stdio: 'ignore' });
  try {
    const { send } = await cdpConnect(port);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      const title = (r && r.result && r.result.result && r.result.result.value) || '';
      if (title.startsWith('SELFTEST')) return { title, done: true };
      await sleep(400);
    }
    return { title: '(自测超时，title 未更新)', done: false };
  } catch (e) {
    return { title: '(无法连接调试端口: ' + e.message + ')', done: false };
  } finally {
    killProc(proc);
  }
}

async function sceneSelftest() {
  const { title, done } = await cdpWaitTitle(fileUrl(path.join(OUT, 'index.html')) + '?selftest=1');
  check('自测通过（缩略图/翻页/缩放/缓存）', done && title.startsWith('SELFTEST_PASS'), title);
}

// ── 场景 3：转换器页面可加载 ──
// 注：不用 cdpDump（outerHTML 6.8MB 超出 CDP 返回值限制会挂起），
// 改为定向小表达式评估。
async function sceneConverter() {
  const state = await cdpEval(
    fileUrl(path.join(ROOT, 'index.html')),
    `JSON.stringify({
      log: (document.getElementById('log') || {}).textContent || '',
      base64: /value="base64" checked/.test(document.documentElement.innerHTML),
    })`,
    { settleMs: 6000 }
  );
  let log = '', base64 = false;
  try { const o = JSON.parse(state); log = o.log || ''; base64 = !!o.base64; } catch (e) {}
  check('转换器页面就绪', log.includes('就绪。等待 PDF 文件'), 'app.js 已初始化');
  check('默认输出模式为 base64', base64, '内嵌模式默认选中');
}

// ── 场景 4：DPR=2 居中 + 文字层对齐（v3.2.0 问题 4 回归验证）──
// 修复前：.page-stage transform-origin:0 0 导致整本偏移左上角；flex-shrink:1 导致
// 文字层溢出画布错位。headless 默认 DPR=1 测不出，必须用 --force-device-scale-factor=2 复现。
async function sceneDpr2() {
  const expr = `(function () {
    var layer = document.querySelector('.page-layer');
    var stage = document.getElementById('stage-a');
    var canvas = document.getElementById('canvas-a');
    var tl = document.getElementById('text-a');
    if (!layer || !stage || !canvas || !tl) return JSON.stringify({ ok: false, why: 'missing' });
    var lr = layer.getBoundingClientRect();
    var sr = stage.getBoundingClientRect();
    var cr = canvas.getBoundingClientRect();
    var tr = tl.getBoundingClientRect();
    // 居中：舞台（画布）视觉中心应等于页面层中心
    var dx = Math.abs((lr.left + lr.width / 2) - (sr.left + sr.width / 2));
    var dy = Math.abs((lr.top + lr.height / 2) - (sr.top + sr.height / 2));
    // 文字层与画布同尺寸
    var wDiff = Math.abs(tr.width - cr.width), hDiff = Math.abs(tr.height - cr.height);
    // 全部 span 必须落在画布范围内（零越界 = 无飘忽/裂痕/颜色错）
    var spans = tl.querySelectorAll('span');
    var inside = 0;
    for (var i = 0; i < spans.length; i++) {
      var r = spans[i].getBoundingClientRect();
      if (r.left >= cr.left - 1 && r.right <= cr.right + 1 && r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1) inside++;
    }
    return JSON.stringify({ dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100, wDiff: Math.round(wDiff * 100) / 100, hDiff: Math.round(hDiff * 100) / 100, inside: inside, total: spans.length });
  })()`;
  const raw = await cdpEval(fileUrl(path.join(OUT, 'index.html')), expr, {
    args: ['--force-device-scale-factor=2'],
    waitExpr: "(function(){ var c = document.getElementById('canvas-a'); return !!(c && c.width > 0 && c.height > 0); })()",
    settleMs: 4000,
  });
  let m = {};
  try { m = JSON.parse(raw); } catch (e) { m = { why: '求值解析失败: ' + String(raw).slice(0, 120) }; }
  check('DPR=2 页面居中（dx/dy ≈ 0）', !m.why && m.dx < 2 && m.dy < 2, 'dx=' + m.dx + ' dy=' + m.dy + (m.why ? ' ' + m.why : ''));
  check('DPR=2 文字层对齐（同尺寸、span 零越界）', !m.why && m.wDiff < 2 && m.hDiff < 2 && m.inside === m.total && m.total > 0, 'wDiff=' + m.wDiff + ' hDiff=' + m.hDiff + ' spans=' + m.inside + '/' + m.total + (m.why ? ' ' + m.why : ''));
}

// ── 主流程 ──
console.log('════ 查看器验收（headless Chrome, file://） ════');
buildViewer();
await sceneBasic();
await sceneSelftest();
await sceneConverter();
await sceneDpr2();

console.log('\n════ 结果:', failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌', '════');
process.exit(failures === 0 ? 0 : 1);
