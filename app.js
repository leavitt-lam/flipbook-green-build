/* ═══════════════════════════════════════════════════════════
   PDF → 交互画册 网页版转换器 v3.7.0
   浏览器编辑器 + 可选 localhost 增强预处理 + JSZip 打包
   输出: index.html（内嵌 PDF）或 index.html + catalog.pdf，支持离线/HTTP 部署
   ═══════════════════════════════════════════════════════════ */
/* global pdfjsLib, JSZip, Detect, VIEWER_TEMPLATE, LIBS_PDFJS, LIBS_WORKER */
'use strict';

const $ = (id) => document.getElementById(id);

// ── 全局状态 ──────────────────────────────────────────────
const state = {
  pdfDoc: null,
  fileName: '',
  title: '',
  pdfBase64: '',           // 用于内嵌到画册
  pdfBytes: null,          // 原始 PDF 字节（用于外部 PDF 模式）
  tocPage: 0,              // 1-based，0=未设置
  editingPage: 0,          // 0-based 当前编辑页
  zones: [],               // [{id, page, name, x, y, w, h, target}]
  selectedId: null,
  editZoom: 1,
  drawMode: false,
  editRenderTask: null,
  specialPages: {},        // 用户导入的兼容页图片；不得由同一个 pdf.js 伪降级生成
  specialPageNames: {},
  enhancedCaps: null,      // localhost 增强服务能力
  preparedAnalysis: null,  // 矢量目录框 / 自学习页码 / 压缩报告
  sourceBytes: 0,
  renderQuality: 'adaptive',
};

// ── 构建产物检查 ──────────────────────────────────────────
if (typeof VIEWER_TEMPLATE === 'undefined' || typeof LIBS_PDFJS === 'undefined' || typeof LIBS_WORKER === 'undefined') {
  document.body.innerHTML = '<div style="padding:40px;font-family:monospace;background:#000;color:#fff;line-height:1.8;"><h2 style="color:#ff4141">错误：当前文件不是构建后的生成器</h2><p>请打开压缩包最外层的 <b>index.html</b>，或在源码目录运行 <code>node build.mjs</code> 重新构建。</p></div>';
  throw new Error('VIEWER_TEMPLATE not defined');
}

async function waitForPdfjs() {
  for (let i = 0; i < 200; i++) {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('pdf.js 初始化超时');
}

async function checkEnhancedCapabilities() {
  const status = $('enhanced-status');
  try {
    const response = await fetch('/api/capabilities', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const caps = await response.json();
    if (!caps.enhanced) throw new Error(caps.error || '增强服务不可用');
    state.enhancedCaps = caps;
    if (status) {
      const extras = [
        caps.ghostscript ? 'Ghostscript 高效压缩' : 'PyMuPDF 便携压缩',
        caps.pdfium ? 'PDFium 独立兼容渲染' : '缺少 PDFium',
        caps.documentFontOcr ? '自学习页码识别' : '缺少页码识别依赖',
        caps.tesseract ? 'Tesseract 备用 OCR' : '无需外部 OCR',
      ];
      status.innerHTML = '<b>增强服务已连接</b> · ' + extras.join(' · ');
    }
  } catch (err) {
    state.enhancedCaps = null;
    if (status) status.innerHTML = '当前是<b>浏览器基础模式</b>：不会自动压缩或生成兼容页。请运行最外层“启动增强生成器”脚本。';
    const profile = $('opt-profile');
    if (profile) profile.value = 'original';
  }
}

async function preprocessWithBackend(sourceBuffer, profile, tocPage) {
  const query = new URLSearchParams({ profile: profile || 'balanced', tocPage: String(tocPage || 0) });
  const response = await fetch('/api/preprocess?' + query.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: sourceBuffer,
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).error || ''; } catch (e) { detail = await response.text(); }
    throw new Error(detail || ('HTTP ' + response.status));
  }
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const pdfEntry = zip.file('catalog.pdf');
  const analysisEntry = zip.file('analysis.json');
  if (!pdfEntry || !analysisEntry) throw new Error('增强服务返回的数据包不完整');
  const pdfBytes = await pdfEntry.async('uint8array');
  const analysis = JSON.parse(await analysisEntry.async('string'));
  const specialPages = {};
  const specialPageNames = {};
  const compatEntries = Object.keys(zip.files).filter(name => /^compat\/page-\d+\.webp$/i.test(name));
  for (const name of compatEntries) {
    const match = /page-(\d+)\.webp$/i.exec(name);
    if (!match) continue;
    const pageNum = parseInt(match[1], 10);
    specialPages[pageNum] = 'data:image/webp;base64,' + await zip.file(name).async('base64');
    specialPageNames[pageNum] = '自动兼容渲染 · ' + name;
  }
  return { pdfBytes, analysis, specialPages, specialPageNames };
}

// ═══════════════════════════════════════════════════════════
//  文件载入
// ═══════════════════════════════════════════════════════════
function bindDropzone() {
  const dz = $('dropzone');
  const input = $('file-input');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) loadFile(input.files[0]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f && /\.pdf$/i.test(f.name)) loadFile(f);
    else showError('请拖入 PDF 文件');
  });

  $('edit-btn').addEventListener('click', openEditor);
  $('convert-btn').addEventListener('click', () => buildAndDownload());
  $('download-btn').addEventListener('click', downloadResult);
  $('android-download-btn').addEventListener('click', downloadAndroidResult);
}

async function loadFile(file) {
  resultBlob = null;
  androidResultBlob = null;
  androidBuildData = null;
  // 任务书 4.5：载入新文件前取消旧加载任务、销毁旧 pdfDoc；用 loadToken 防旧任务晚完成覆盖新状态
  state.loadToken = (state.loadToken || 0) + 1;
  const myToken = state.loadToken;
  if (state.loadingTask) { try { state.loadingTask.destroy(); } catch (e) {} state.loadingTask = null; }
  if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch (e) {} state.pdfDoc = null; }
  // 取消编辑器/缩略图渲染
  if (state.editRenderTask) { try { state.editRenderTask.cancel(); } catch (e) {} state.editRenderTask = null; }
  thumbRendering = false;
  thumbRenderQueue = [];
  thumbQueued.clear();
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  state.specialPages = {};
  state.specialPageNames = {};
  state.preparedAnalysis = null;
  state.sourceBytes = file.size || 0;

  hideAll();
  showError('');
  log('读取文件: ' + file.name + ' (' + fmtSize(file.size) + ')');
  $('progress-panel').classList.remove('hidden');
  setProgress('读取 PDF 字节', 0, 100);

  try {
    await waitForPdfjs();
    // ── 阶段 1：读取文件到 ArrayBuffer ──────────────────
    const buf = await file.arrayBuffer();
    let prepared = null;
    const profile = ($('opt-profile') && $('opt-profile').value) || 'balanced';
    if (state.enhancedCaps && state.enhancedCaps.enhanced) {
      setProgress('增强预处理：压缩 PDF / 检测异常页 / 读取目录矢量框与自学习页码', 18, 100);
      $('bar-fill').classList.add('indeterminate');
      await tick();
      try {
        prepared = await preprocessWithBackend(buf.slice(0), profile, 0);
        state.preparedAnalysis = prepared.analysis || null;
        state.specialPages = prepared.specialPages || {};
        state.specialPageNames = prepared.specialPageNames || {};
        const report = prepared.analysis || {};
        log('增强预处理完成: PDF ' + fmtSize(report.sourceBytes || file.size) + ' → ' + fmtSize(report.outputPdfBytes || prepared.pdfBytes.length));
        const pageSources = report.pageNumberSources || {};
        const sourceSummary = Object.keys(pageSources).map(key => key + ' ' + pageSources[key]).join(' / ');
        log('目录矢量框 ' + (report.catalogRectCount || 0) + ' 个 / 页码识别 ' + (report.printedPageHits || 0) + ' 个' + (sourceSummary ? '（' + sourceSummary + '）' : '') + ' / 自动兼容页 ' + ((report.specialPages || []).join(', ') || '无'));
      } catch (enhancedError) {
        prepared = null;
        state.preparedAnalysis = null;
        state.specialPages = {};
        state.specialPageNames = {};
        log('⚠ 增强预处理失败，已回退原始 PDF: ' + (enhancedError.message || enhancedError));
      } finally {
        $('bar-fill').classList.remove('indeterminate');
      }
    }
    // pdf.js getDocument 会 transfer 传入的 TypedArray；生成数据和解析数据必须各持有一份。
    const chosenBytes = prepared ? prepared.pdfBytes : new Uint8Array(buf);
    state.pdfBytes = new Uint8Array(chosenBytes.slice(0));
    const pdfData = new Uint8Array(chosenBytes.slice(0));

    setProgress('解析 PDF 结构（含高分辨率图片，大文件需等待）', 50, 100);
    await tick();
    // bar-fill 进入"无限循环"动画，让用户感知仍在工作
    $('bar-fill').classList.add('indeterminate');

    // ── 阶段 2：pdf.js 解析（worker 中进行，主线程不卡） ─
    state.loadingTask = pdfjsLib.getDocument({
      data: pdfData,
      stopAtErrors: false,
      verbosity: 0,
    });
    const doc = await state.loadingTask.promise;
    if (myToken !== state.loadToken) {
      // 已被更新的文件接管，旧结果直接丢弃
      try { doc.destroy(); } catch (e) {}
      return;
    }
    state.loadingTask = null;
    state.pdfDoc = doc;

    state.fileName = file.name;
    state.title = file.name.replace(/\.pdf$/i, '') || '电子画册';
    const preparedInfo = state.preparedAnalysis;
    state.tocPage = preparedInfo && preparedInfo.tocPage ? preparedInfo.tocPage : 0;
    state.zones = preparedInfo && Array.isArray(preparedInfo.zones)
      ? preparedInfo.zones.map(z => Detect.normalizeZone(z))
      : [];
    state.selectedId = null;
    state.editingPage = state.tocPage ? state.tocPage - 1 : 0;

    setProgress('加载完成', 100, 100);
    $('bar-fill').classList.remove('indeterminate');

    $('f-name').textContent = file.name;
    $('f-pages').textContent = state.pdfDoc.numPages + ' 页';
    $('opt-title').placeholder = state.title;
    $('opt-title').value = '';
    $('opt-tocpage').value = state.tocPage || '';
    $('f-size').textContent = state.sourceBytes && state.sourceBytes !== state.pdfBytes.length
      ? fmtSize(state.sourceBytes) + ' → ' + fmtSize(state.pdfBytes.length)
      : fmtSize(state.pdfBytes.length);
    if (state.preparedAnalysis) {
      const a = state.preparedAnalysis;
      $('f-render').textContent = '增强 PDF + ' + ((a.specialPages || []).length) + ' 个自动兼容页 · ' + (a.catalogRectCount || 0) + ' 个矢量目录框';
    } else {
      $('f-render').textContent = '基础 PDF.js 动态渲染 · 文字可选';
    }

    $('file-info').classList.remove('hidden');
    $('options').classList.remove('hidden');
    $('progress-panel').classList.add('hidden');
    log('加载完成: ' + state.pdfDoc.numPages + ' 页 / 动态高清渲染 / 输出 PDF 体积 ' + fmtSize(state.pdfBytes.length));
    // 任务书 5：显示 PDF 大小与预计生成大小，大文件给出警告阈值（25MB 可配置，允许继续）
    const estBase64MB = (state.pdfBytes.length * 4 / 3) / 1048576;
    if (state.pdfBytes.length > 25 * 1048576) {
      log('⚠ 提示: 文件较大，内嵌 base64 模式预计生成 HTML 约 ' + estBase64MB.toFixed(0) + 'MB，在低配平板上可能打开较慢；可改用「外部 PDF」模式 + HTTP 部署。');
    } else {
      log('预计内嵌 base64 生成 HTML 约 ' + estBase64MB.toFixed(1) + 'MB');
    }
  } catch (err) {
    if (myToken !== state.loadToken) return; // 被新加载取代的旧任务失败不报错
    $('bar-fill').classList.remove('indeterminate');
    showError('PDF 读取失败: ' + (err && err.message ? err.message : err));
    state.pdfDoc = null;
  }
}

// 编辑器渲染用户提供的兼容页图片。
// 注意：不能用 pdf.js 再渲染一次作为 fallback；那会把 pdf.js 自身的裂缝/偏色固化。
async function renderEditSpecialPage(idx, page, gen) {
  const img = state.specialPages && state.specialPages[idx + 1];
  if (!img) return false;
  const baseVp = page.getViewport({ scale: 1 });
  const availW = Math.max(canvasPanel.clientWidth - 60, 200);
  const availH = Math.max(canvasPanel.clientHeight - 60, 200);
  const fit = Math.min(availW / baseVp.width, availH / baseVp.height) * state.editZoom;
  const outScale = fit * 2;
  editHolder.style.width = (baseVp.width * fit) + 'px';
  editHolder.style.height = (baseVp.height * fit) + 'px';
  editCanvas.width = Math.ceil(baseVp.width * outScale);
  editCanvas.height = Math.ceil(baseVp.height * outScale);
  const ctx = editCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, editCanvas.width, editCanvas.height);
  const im = new Image();
  im.src = img;
  try {
    if (im.decode) await im.decode();
    else await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = reject; });
  } catch (e) { return false; }
  if (gen !== editRenderGen || idx !== state.editingPage) return false;
  ctx.drawImage(im, 0, 0, editCanvas.width, editCanvas.height);
  return true;
}

// 分块 base64 编码：块长是 3 的倍数，避免构造一份与 PDF 同大的二进制字符串。
async function u8ToBase64(u8, onProgress) {
  const CHUNK = 3 * 32768;
  const parts = [];
  for (let i = 0; i < u8.length; i += CHUNK) {
    const chunk = u8.subarray(i, Math.min(u8.length, i + CHUNK));
    let bin = '';
    for (let p = 0; p < chunk.length; p += 0x8000) {
      bin += String.fromCharCode.apply(null, chunk.subarray(p, Math.min(chunk.length, p + 0x8000)));
    }
    parts.push(btoa(bin));
    if (onProgress) onProgress(Math.min(u8.length, i + chunk.length), u8.length);
    if ((parts.length & 7) === 0) await tick();
  }
  return parts.join('');
}

// ═══════════════════════════════════════════════════════════
//  目录编辑器
// ═══════════════════════════════════════════════════════════
const canvasPanel = $('canvas-panel');
const editHolder = $('edit-holder');
const editCanvas = $('edit-canvas');
const zoneList = $('zone-list');

function openEditor() {
  if (!state.pdfDoc) return;
  // 同步标题与目录页设置（任务书 4.2：输入为空 → 明确取消；非法 → 校验提示，不保留旧值）
  state.title = $('opt-title').value.trim() || state.fileName.replace(/\.pdf$/i, '') || '电子画册';
  const tpVal = $('opt-tocpage').value.trim();
  if (tpVal === '') {
    state.tocPage = 0;
  } else {
    const tp = parseInt(tpVal, 10);
    if (tp >= 1 && tp <= state.pdfDoc.numPages) {
      state.tocPage = tp;
    } else {
      $('opt-tocpage').value = '';
      state.tocPage = 0;
      toast('目录页需为 1~' + state.pdfDoc.numPages + ' 的整数，已清除');
    }
  }
  updateTocToggle();

  $('screen-editor').classList.remove('hidden');
  $('ed-page').value = state.editingPage + 1;
  buildThumbStrip();
  renderEditPage();
  renderZoneList();
}

function closeEditor() {
  $('screen-editor').classList.add('hidden');
  if (state.editRenderTask) { try { state.editRenderTask.cancel(); } catch (e) {} state.editRenderTask = null; }
}

// ── 编辑页渲染 ──
let editRenderGen = 0; // 渲染代际 token（任务书 4.5：防旧任务晚完成覆盖新状态）
async function renderEditPage() {
  if (!state.pdfDoc) return;
  const idx = state.editingPage;
  const gen = ++editRenderGen;
  if (state.editRenderTask) { try { state.editRenderTask.cancel(); } catch (e) {} state.editRenderTask = null; }
  $('ed-spinner').classList.remove('hidden');

  try {
    const page = await state.pdfDoc.getPage(idx + 1);
    if (gen !== editRenderGen) { try { page.cleanup(); } catch (e) {} return; } // 已被更新代际取代
    // PDF.js 不兼容页优先显示用户从 WPS/Acrobat 导入的兼容图片。
    if (await renderEditSpecialPage(idx, page, gen)) {
      try { page.cleanup(); } catch (e) {}
      if (gen !== editRenderGen) return;
      $('ed-spinner').classList.add('hidden');
      buildBoxes();
      updateThumbStripHighlight();
      updateTocToggle();
      return;
    }
    const baseVp = page.getViewport({ scale: 1 });
    const availW = Math.max(canvasPanel.clientWidth - 60, 200);
    const availH = Math.max(canvasPanel.clientHeight - 60, 200);
    const fit = Math.min(availW / baseVp.width, availH / baseVp.height) * state.editZoom;
    const outScale = fit * 2; // 2x 超采样，清晰

    editHolder.style.width = (baseVp.width * fit) + 'px';
    editHolder.style.height = (baseVp.height * fit) + 'px';
    editCanvas.width = Math.ceil(baseVp.width * outScale);
    editCanvas.height = Math.ceil(baseVp.height * outScale);
    const ctx = editCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, editCanvas.width, editCanvas.height);

    const task = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: outScale }) });
    state.editRenderTask = task;
    await task.promise;
    if (gen !== editRenderGen) { try { page.cleanup(); } catch (e) {} return; } // 取消/过期任务不更新状态
    state.editRenderTask = null;
    try { page.cleanup(); } catch (e) {}
  } catch (e) {
    // 渲染取消（RenderingCancelledException 等）属正常控制流，静默处理
    if (gen !== editRenderGen) return;
    state.editRenderTask = null;
  }
  if (gen !== editRenderGen) return;
  $('ed-spinner').classList.add('hidden');
  buildBoxes();
  updateThumbStripHighlight();
  updateTocToggle();
}

// ── 产品框 DOM ──
function buildBoxes() {
  const old = editHolder.querySelectorAll('.ebox');
  old.forEach(el => el.remove());
  const pageZones = state.zones.filter(z => z.page === state.editingPage + 1);
  for (const z of pageZones) {
    const el = document.createElement('div');
    el.className = 'ebox' + (z.id === state.selectedId ? ' selected' : '') +
      (z.targetPage ? ' has-target' : ' no-target');
    el.dataset.id = z.id;
    el.style.left = (z.x * 100) + '%';
    el.style.top = (z.y * 100) + '%';
    el.style.width = (z.w * 100) + '%';
    el.style.height = (z.h * 100) + '%';

    const nm = document.createElement('span');
    nm.className = 'ebox-name';
    nm.textContent = z.name || '未命名';
    const pg = document.createElement('span');
    pg.className = 'ebox-page';
    pg.textContent = z.targetPage ? ('→ ' + z.targetPage) : '未设';
    el.appendChild(nm);
    el.appendChild(pg);
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(dir => {
      const h = document.createElement('i');
      h.className = 'handle ' + dir;
      h.dataset.dir = dir;
      el.appendChild(h);
    });

    el.addEventListener('pointerdown', (e) => onBoxPointerDown(e, z));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameZone(z);
    });
    editHolder.appendChild(el);
  }
}

// 拖动 / 缩放
function onBoxPointerDown(e, z) {
  e.preventDefault();
  e.stopPropagation();
  selectZone(z.id);
  const handle = e.target.closest('.handle');
  const mode = handle ? handle.dataset.dir : 'move';
  const rect = editHolder.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const zx = z.x, zy = z.y, zw = z.w, zh = z.h;

  const move = (ev) => {
    const dx = (ev.clientX - startX) / rect.width;
    const dy = (ev.clientY - startY) / rect.height;
    let nx = zx, ny = zy, nw = zw, nh = zh;
    if (mode === 'move') {
      // 任务书 4.3：框体不得拖出页面（0 ≤ x ≤ 1-w, 0 ≤ y ≤ 1-h）
      nx = clamp01(zx + dx, 0, Math.max(0, 1 - zw));
      ny = clamp01(zy + dy, 0, Math.max(0, 1 - zh));
    } else {
      if (mode.includes('e')) nw = clamp01(zw + dx, 0.01, 1 - nx);
      if (mode.includes('s')) nh = clamp01(zh + dy, 0.01, 1 - ny);
      if (mode.includes('w')) {
        nw = clamp01(zw - dx, 0.01, zx + zw);
        nx = clamp01(zx + dx, 0, zx + zw - 0.01);
      }
      if (mode.includes('n')) {
        nh = clamp01(zh - dy, 0.01, zy + zh);
        ny = clamp01(zy + dy, 0, zy + zh - 0.01);
      }
    }
    z.x = r4(nx); z.y = r4(ny); z.w = r4(nw); z.h = r4(nh);
    z.geometrySource = 'manual';
    z.manualAdjusted = true;
    syncBoxDOM(z);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    renderZoneList();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function syncBoxDOM(z) {
  const el = editHolder.querySelector('.ebox[data-id="' + z.id + '"]');
  if (!el) return;
  el.style.left = (z.x * 100) + '%';
  el.style.top = (z.y * 100) + '%';
  el.style.width = (z.w * 100) + '%';
  el.style.height = (z.h * 100) + '%';
  const pg = el.querySelector('.ebox-page');
  if (pg) {
    pg.textContent = z.targetPage ? ('→ ' + z.targetPage) : '未设';
    el.classList.toggle('has-target', !!z.targetPage);
    el.classList.toggle('no-target', !z.targetPage);
  }
}

function renameZone(z) {
  const name = prompt('产品名称（用于自动匹配页码与目录显示）:', z.name || '');
  if (name === null) return;
  z.name = name.trim();
  z.nameSource = 'manual';
  const el = editHolder.querySelector('.ebox[data-id="' + z.id + '"] .ebox-name');
  if (el) el.textContent = z.name || '未命名';
  renderZoneList();
}

// ── 添加框（绘制模式）──
function bindDrawMode() {
  $('add-btn').addEventListener('click', () => {
    state.drawMode = !state.drawMode;
    canvasPanel.classList.toggle('drawing', state.drawMode);
    $('add-btn').classList.toggle('on', state.drawMode);
    if (state.drawMode) toast('在页面上拖拽画框 → 松手生成产品框');
  });

  let drawing = null;
  editHolder.addEventListener('pointerdown', (e) => {
    if (!state.drawMode) return;
    if (e.target.closest('.ebox')) return;
    e.preventDefault();
    const rect = editHolder.getBoundingClientRect();
    const p = (ev) => ({ x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height });
    const start = p(e);
    drawing = { start };
    const dr = $('draw-rect');
    dr.classList.remove('hidden');
    const upd = (ev) => {
      const cur = p(ev);
      const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
      dr.style.left = (x * 100) + '%';
      dr.style.top = (y * 100) + '%';
      dr.style.width = (Math.abs(cur.x - start.x) * 100) + '%';
      dr.style.height = (Math.abs(cur.y - start.y) * 100) + '%';
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', upd);
      window.removeEventListener('pointerup', up);
      dr.classList.add('hidden');
      const cur = p(ev);
      const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
      const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
      if (w > 0.008 && h > 0.008) {
        // 手动画框：统一走 normalizeZone（任务书 3.1：自动/手动框都必须有唯一 ID）
        const z = Detect.normalizeZone({
          id: Detect.createZoneId(),
          page: state.editingPage + 1,
          name: '产品 ' + (state.zones.filter(zz => zz.page === state.editingPage + 1).length + 1),
          x: r4(x), y: r4(y), w: r4(w), h: r4(h),
          targetPage: 0, targetSource: 'none', printedPage: 0, confidence: 1,
          geometrySource: 'manual', manualAdjusted: true, nameSource: 'auto',
        });
        state.zones.push(z);
        state.drawMode = false;
        canvasPanel.classList.remove('drawing');
        $('add-btn').classList.remove('on');
        selectZone(z.id);
        renderZoneList();
        buildBoxes();
        // 拉框后自动识别框内产品名（提取框内 PDF 文本），便于自动匹配页码
        autoFillZoneName(z);
      }
    };
    window.addEventListener('pointermove', upd);
    window.addEventListener('pointerup', up);
  });

  // 空白处点击取消选中
  editHolder.addEventListener('pointerdown', (e) => {
    if (state.drawMode || e.target.closest('.ebox')) return;
    selectZone(null);
  });
}

// ── 选择 ──
function selectZone(id) {
  state.selectedId = id;
  buildBoxes();
  renderZoneList();
}

// ── 右侧列表 ──
function renderZoneList() {
  const list = zoneList;
  list.innerHTML = '';
  const pageZones = state.zones.filter(z => z.page === state.editingPage + 1);
  $('sp-count').textContent = pageZones.length;
  for (const z of pageZones) {
    const row = document.createElement('div');
    row.className = 'zone-row' + (z.id === state.selectedId ? ' selected' : '');
    row.dataset.id = z.id;

    const name = document.createElement('input');
    name.className = 'z-name';
    name.value = z.name || '';
    name.placeholder = '产品名';
    name.addEventListener('input', () => {
      z.name = name.value;
      z.nameSource = 'manual';
      const el = editHolder.querySelector('.ebox[data-id="' + z.id + '"] .ebox-name');
      if (el) el.textContent = z.name || '未命名';
    });
    name.addEventListener('pointerdown', (e) => e.stopPropagation());

    const page = document.createElement('input');
    page.className = 'z-page';
    page.type = 'number';
    page.min = 1;
    page.max = state.pdfDoc ? state.pdfDoc.numPages : 9999;
    page.placeholder = '页';
    page.value = z.targetPage || '';
    page.title = '跳转页码（可点下方缩略图快速指定）';
    page.addEventListener('change', () => {
      // 人工指定物理页：写入 targetPage 并标记来源 manual（任务书 3.2：人工页码优先级最高）
      const n = parseInt(page.value, 10);
      if (n >= 1 && n <= state.pdfDoc.numPages) {
        z.targetPage = n;
        z.targetSource = 'manual';
      } else if (page.value.trim() === '') {
        z.targetPage = 0;
        z.targetSource = 'none';
      }
      syncBoxDOM(z);
      renderZoneList();
      updateThumbStripHighlight();
    });
    page.addEventListener('pointerdown', (e) => e.stopPropagation());

    const del = document.createElement('button');
    del.className = 'z-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.zones = state.zones.filter(zz => zz.id !== z.id);
      if (state.selectedId === z.id) state.selectedId = null;
      renderZoneList();
      buildBoxes();
      updateThumbStripHighlight();
    });

    row.appendChild(name);
    row.appendChild(page);
    row.appendChild(del);
    row.addEventListener('click', () => selectZone(z.id));
    list.appendChild(row);
  }
}

// ── 自动识别 ──
function zoneIoU(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function mergeDetectedZones(existing, detected) {
  const used = new Set();
  const out = detected.map(fresh => {
    const freshName = Detect.normalizeText(fresh.name || '');
    let match = existing.find(old => !used.has(old.id) && freshName && Detect.normalizeText(old.name || '') === freshName);
    if (!match) match = existing.find(old => !used.has(old.id) && zoneIoU(old, fresh) >= 0.45);
    if (!match) return fresh;
    used.add(match.id);
    const merged = Object.assign({}, fresh, {
      id: match.id,
      printedPage: match.printedPage || fresh.printedPage || 0,
      targetPage: match.targetPage || 0,
      targetSource: match.targetSource || 'none',
      confidence: Math.max(match.confidence || 0, fresh.confidence || 0),
    });
    if (match.manualAdjusted || match.geometrySource === 'manual') {
      merged.x = match.x; merged.y = match.y; merged.w = match.w; merged.h = match.h;
      merged.geometrySource = 'manual';
      merged.manualAdjusted = true;
    }
    if (match.nameSource === 'manual') {
      merged.name = match.name;
      merged.nameSource = 'manual';
    }
    return Detect.normalizeZone(merged);
  });
  // 未匹配的人工框必须保留；普通旧自动框可由本轮识别结果替换。
  for (const old of existing) {
    if (!used.has(old.id) && (old.manualAdjusted || old.geometrySource === 'manual' || old.nameSource === 'manual' || old.targetSource === 'manual')) {
      out.push(Detect.normalizeZone(old));
    }
  }
  return out;
}

async function detectPage() {
  if (!state.pdfDoc) return;
  const idx = state.editingPage;
  setEdProg('识别中...');
  try {
    // 增强服务已经从 PDF 绘图层读到真实卡片矩形时，直接复用该几何结果。
    // 再跑文本行距启发式会把准确的上/右边界退化回估算值。
    if (state.preparedAnalysis && state.preparedAnalysis.tocPage === idx + 1 && Array.isArray(state.preparedAnalysis.zones)) {
      const exact = state.preparedAnalysis.zones.map(z => Detect.normalizeZone(z));
      const existing = state.zones.filter(z => z.page === idx + 1);
      const merged = mergeDetectedZones(existing, exact);
      state.zones = state.zones.filter(z => z.page !== idx + 1).concat(merged);
      state.selectedId = null;
      buildBoxes();
      renderZoneList();
      updateThumbStripHighlight();
      setEdProg('矢量框识别完成：' + merged.length + ' 个产品框；上/右边界来自 PDF 原始框线');
      toast('已恢复 ' + merged.length + ' 个矢量卡片框');
      return;
    }
    const page = await state.pdfDoc.getPage(idx + 1);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    const items = tc.items
      .filter(it => it.str && it.str.trim())
      .map(it => {
        const t = it.transform || [1, 0, 0, 1, 0, 0];
        // v3.2.1 Fix 1: it.width 已是用户空间宽度（含字号缩放），不得再乘 |transform[0]|
        //   （会膨胀 ≈6 倍 → 碎片合并把列间距误判成词间距 → 整行产品合并成 1 个框）
        // v3.2.1 Fix 2: 坐标必须经 viewport.transform 归一化为「y 向下屏幕坐标」。
        //   pdf.js 原始 transform 在 PDF 用户空间——常规 PDF 左下原点（y 向上），
        //   部分工具导出的 PDF 内容流自带翻转（表现 y 向下）。两种约定都存在，
        //   统一经 viewport 变换后一律 y 向下（页顶=0），detect.js 按此语义处理。
        const tx = pdfjsLib.Util.transform(vp.transform, t);
        return {
          str: it.str,
          x: tx[4], y: tx[5],
          w: it.width || 0,
          h: Math.hypot(tx[2], tx[3]) || Math.abs(t[3]) || 1,
        };
      });
    const zones = Detect.detectZonesFromItems(items, vp.width, vp.height, idx + 1, state.pdfDoc.numPages);
    // 自动结果与已有框合并：人工几何、名称、页码不得被重新识别覆盖。
    const existing = state.zones.filter(z => z.page === idx + 1);
    const merged = mergeDetectedZones(existing, zones);
    state.zones = state.zones.filter(z => z.page !== idx + 1).concat(merged);
    state.selectedId = null;
    buildBoxes();
    renderZoneList();
    updateThumbStripHighlight();
    setEdProg('识别完成：本页 ' + merged.length + ' 个产品框（人工调整已保留；未设页码可自动匹配）');
    toast('识别到 ' + merged.length + ' 个条目');
  } catch (err) {
    setEdProg('识别失败: ' + (err && err.message ? err.message : err));
  }
}

// 取某页文本块（转为 {str,x,y,w,h}），供拉框识别产品名用
async function getPageItems(pageNum) {
  const page = await state.pdfDoc.getPage(pageNum);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const items = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => {
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      // v3.2.1 Fix: it.width 已是用户空间宽度（不得乘字号）；坐标经 viewport
      // 变换统一为 y 向下屏幕坐标（同 detectPage，兼容两种内部坐标约定的 PDF）
      const tx = pdfjsLib.Util.transform(vp.transform, t);
      return { str: it.str, x: tx[4], y: tx[5], w: it.width || 0, h: Math.hypot(tx[2], tx[3]) || Math.abs(t[3]) || 1 };
    });
  return { items, vp };
}

// 手动拉框后，自动提取框内文本作为产品名（便于自动匹配页码）
async function autoFillZoneName(z) {
  try {
    const { items, vp } = await getPageItems(z.page);
    const name = Detect.extractTextInBox(items, z, vp.width, vp.height);
    if (z.nameSource !== 'manual' && name && name.length >= 2 && !/^产品 \d+$/.test(name)) {
      z.name = name.slice(0, 60);
      z.nameSource = 'auto';
      renderZoneList();
      buildBoxes();
      toast('识别产品名：' + z.name);
    }
  } catch (e) { /* 提取失败则保留默认名 */ }
}

// ── 自动匹配页码 ──
async function matchPages() {
  // 任务书 3.2：只对「没有最终物理页」的框做文本匹配；印刷页码映射在 detect.js 内统一完成
  const pending = state.zones.filter(z => !z.targetPage && z.name);
  if (!pending.length) { toast('没有需要匹配的框（都已设置页码）'); return; }
  setEdProg('自动匹配中 0/' + pending.length);
  const cache = new Map();
  const from = state.tocPage || state.editingPage + 1;
  const t0 = performance.now();
  // BUG FIX (B6): 传入目录页，匹配时跳过，防止目录跨页时产品被误匹配到后续目录页
  await Detect.autoMatchTargets(state.pdfDoc, state.zones, from, cache, (done, total) => {
    setEdProg('自动匹配中 ' + done + '/' + total);
  }, state.tocPage ? [state.tocPage] : []);
  buildBoxes();
  renderZoneList();
  updateThumbStripHighlight();
  const matched = state.zones.filter(z => z.targetPage).length;
  setEdProg('匹配完成：' + matched + ' 个框已设页码，耗时 ' + ((performance.now() - t0) / 1000).toFixed(1) + 's（其余请手动指定）');
  toast('匹配完成');
}

// ── 缩略图条 ──
let thumbRenderQueue = [];
let thumbRendering = false;
let thumbObserver = null;
const thumbQueued = new Set();

function buildThumbStrip() {
  const strip = $('thumb-strip');
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  thumbQueued.clear();
  strip.innerHTML = '';
  const n = state.pdfDoc.numPages;
  for (let i = 0; i < n; i++) {
    const t = document.createElement('div');
    t.className = 'ts-thumb';
    t.dataset.page = i;
    t.innerHTML = '<canvas></canvas><div class="ts-num">' + (i + 1) + '</div>';
    t.addEventListener('click', () => onThumbClick(i));
    strip.appendChild(t);
  }
  if ('IntersectionObserver' in window) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        const i = parseInt(card.dataset.page, 10);
        queueThumbRender(i, card.querySelector('canvas'));
      }
      startThumbRenderer();
    }, { root: strip, rootMargin: '0px 360px', threshold: 0.01 });
    strip.querySelectorAll('.ts-thumb').forEach(card => thumbObserver.observe(card));
  } else {
    strip.querySelectorAll('.ts-thumb').forEach((card, i) => { if (i < 12) queueThumbRender(i, card.querySelector('canvas')); });
    startThumbRenderer();
  }
}

function queueThumbRender(i, canvas) {
  if (!canvas || canvas.dataset.done || thumbQueued.has(i)) return;
  thumbQueued.add(i);
  thumbRenderQueue.push({ i, canvas, doc: state.pdfDoc, loadToken: state.loadToken });
}

function startThumbRenderer() {
  if (!thumbRendering && thumbRenderQueue.length) {
    thumbRendering = true;
    renderThumbsLoop();
  }
}

async function renderThumbsLoop() {
  let done = 0;
  while (thumbRenderQueue.length) {
    const { i, canvas, doc, loadToken } = thumbRenderQueue.shift();
    thumbQueued.delete(i);
    if (doc !== state.pdfDoc || loadToken !== state.loadToken || !canvas.isConnected) continue;
    try {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const scale = (86 / vp.width) * Math.min(window.devicePixelRatio || 1, 2);
      const outVp = page.getViewport({ scale });
      if (canvas.parentElement) canvas.parentElement.style.setProperty('--page-ratio', vp.width + ' / ' + vp.height);
      canvas.width = Math.ceil(outVp.width);
      canvas.height = Math.ceil(outVp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const special = state.specialPages && state.specialPages[i + 1];
      if (special) {
        const image = new Image();
        image.src = special;
        if (image.decode) await image.decode();
        else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.dataset.renderer = 'compat';
      } else {
        await page.render({ canvasContext: ctx, viewport: outVp }).promise;
        canvas.dataset.renderer = 'pdfjs';
      }
      if (doc !== state.pdfDoc || loadToken !== state.loadToken || !canvas.isConnected) continue;
      canvas.dataset.done = '1';
      page.cleanup();
    } catch (e) {}
    done++;
    if (done % 4 === 0) setEdProg('已按可见区域生成 ' + done + ' 张缩略图');
    await new Promise(r => setTimeout(r, 0));
  }
  thumbRendering = false;
}

function onThumbClick(i) {
  const sel = state.zones.find(z => z.id === state.selectedId);
  if (sel && sel.page === state.editingPage + 1) {
    // 缩略图点选 = 人工指定物理页（任务书 3.2）
    sel.targetPage = i + 1;
    sel.targetSource = 'manual';
    syncBoxDOM(sel);
    renderZoneList();
    updateThumbStripHighlight();
    toast('「' + (sel.name || '未命名') + '」→ 第 ' + (i + 1) + ' 页');
  } else {
    state.editingPage = i;
    $('ed-page').value = i + 1;
    renderEditPage();
  }
}

function updateThumbStripHighlight() {
  const strip = $('thumb-strip');
  strip.querySelectorAll('.ts-thumb').forEach(t => {
    const i = parseInt(t.dataset.page);
    t.classList.toggle('cur', i === state.editingPage);
    const targeted = state.zones.some(z => z.page === state.editingPage + 1 && z.targetPage === i + 1);
    t.classList.toggle('targeted', targeted);
  });
}

function updateCompatButton() {
  const pageNum = state.editingPage + 1;
  const has = !!(state.specialPages && state.specialPages[pageNum]);
  $('compat-btn').classList.toggle('on', has);
  $('compat-btn').textContent = has ? ('▣ 已设置兼容图 · 第 ' + pageNum + ' 页') : '▣ 导入兼容页图';
  $('compat-clear-btn').classList.toggle('hidden', !has);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function importCompatImage(file) {
  if (!file || !/^image\/(png|webp|jpeg)$/i.test(file.type || '')) {
    toast('请选择 PNG、WebP 或 JPEG 图片');
    return;
  }
  const pageNum = state.editingPage + 1;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const probe = new Image();
    probe.src = dataUrl;
    if (probe.decode) await probe.decode();
    else await new Promise((resolve, reject) => { probe.onload = resolve; probe.onerror = reject; });
    if (probe.width < 1000 || probe.height < 1000) {
      toast('兼容页图分辨率偏低，建议长边至少 2000px');
    }
    state.specialPages[pageNum] = dataUrl;
    state.specialPageNames[pageNum] = file.name || '';
    updateCompatButton();
    renderEditPage();
    log('第 ' + pageNum + ' 页使用兼容页图：' + (file.name || '未命名图片') + '（' + probe.width + '×' + probe.height + '）');
    toast('已设置第 ' + pageNum + ' 页兼容图');
  } catch (e) {
    toast('兼容页图读取失败');
  }
}

// ── 编辑器按钮 ──
function bindEditorButtons() {
  $('ed-back').addEventListener('click', closeEditor);
  $('ed-goto').addEventListener('click', () => {
    const n = parseInt($('ed-page').value, 10);
    if (n >= 1 && n <= state.pdfDoc.numPages) {
      state.editingPage = n - 1;
      renderEditPage();
      updateThumbStripHighlight();
    }
  });
  $('ed-page').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ed-goto').click(); });
  $('toc-toggle').addEventListener('click', () => {
    if (state.tocPage === state.editingPage + 1) {
      state.tocPage = 0;
    } else {
      state.tocPage = state.editingPage + 1;
    }
    updateTocToggle();
    $('opt-tocpage').value = state.tocPage || '';
    if (state.tocPage) toast('目录页 = 第 ' + state.tocPage + ' 页（画册将有常驻返回按钮）');
  });
  $('detect-btn').addEventListener('click', detectPage);
  $('del-btn').addEventListener('click', () => {
    if (!state.selectedId) { toast('请先选中一个产品框'); return; }
    state.zones = state.zones.filter(z => z.id !== state.selectedId);
    state.selectedId = null;
    renderZoneList();
    buildBoxes();
    updateThumbStripHighlight();
  });
  $('clear-btn').addEventListener('click', () => {
    const before = state.zones.length;
    state.zones = state.zones.filter(z => z.page !== state.editingPage + 1);
    state.selectedId = null;
    renderZoneList();
    buildBoxes();
    updateThumbStripHighlight();
    if (before !== state.zones.length) toast('已清空本页产品框');
  });
  $('match-btn').addEventListener('click', matchPages);
  $('compat-btn').addEventListener('click', () => $('compat-input').click());
  $('compat-input').addEventListener('change', () => {
    const file = $('compat-input').files && $('compat-input').files[0];
    $('compat-input').value = '';
    if (file) importCompatImage(file);
  });
  $('compat-clear-btn').addEventListener('click', () => {
    const pageNum = state.editingPage + 1;
    delete state.specialPages[pageNum];
    delete state.specialPageNames[pageNum];
    updateCompatButton();
    renderEditPage();
    toast('已移除第 ' + pageNum + ' 页兼容图');
  });
  $('generate-btn').addEventListener('click', () => { closeEditor(); buildAndDownload(); });

  // 键盘删除
  document.addEventListener('keydown', (e) => {
    if (!$('screen-editor').classList.contains('hidden')) {
      if ((e.key === 'Delete' || e.key === 'Backspace') &&
          e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        if (state.selectedId) {
          state.zones = state.zones.filter(z => z.id !== state.selectedId);
          state.selectedId = null;
          renderZoneList();
          buildBoxes();
        }
      }
      if (e.key === 'Escape') closeEditor();
    }
  });

  window.addEventListener('resize', () => { if (!$('screen-editor').classList.contains('hidden')) renderEditPage(); });
}

function updateTocToggle() {
  $('toc-toggle').classList.toggle('on', state.tocPage === state.editingPage + 1);
  $('toc-toggle').innerHTML = state.tocPage === state.editingPage + 1
    ? '&#9873; 目录页: 第 ' + state.tocPage + ' 页'
    : '&#9873; 设为目录页';
  updateCompatButton();
}

// ═══════════════════════════════════════════════════════════
//  生成画册
// ═══════════════════════════════════════════════════════════
let resultBlob = null;
let resultName = '';
let androidResultBlob = null;
let androidResultName = '';
let androidBuildData = null;

function safePackageName(name) {
  return String(name || 'flipbook').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 48) || 'flipbook';
}

function makeViewerHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const workerJson = JSON.stringify(LIBS_WORKER).replace(/</g, '\\u003c');
  const inlineLibs =
    '<script type="module">' + LIBS_PDFJS.replace(/<\/script/gi, '<\\/script') + '\n' +
    'pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([' + workerJson + '], { type: "text/javascript" }));\n' +
    'if (globalThis.__pdfjsReadyResolve) globalThis.__pdfjsReadyResolve();\n' +
    '</script>';
  return VIEWER_TEMPLATE
    .split('__FLIPBOOK_DATA__').join(json)
    .split('<!--__VIEWER_LIBS__-->').join(inlineLibs);
}

async function makePwaIcon(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#00ff41'; ctx.lineWidth = Math.max(6, size * 0.045);
  ctx.strokeRect(size * 0.14, size * 0.12, size * 0.72, size * 0.76);
  ctx.fillStyle = '#ffffff'; ctx.font = '700 ' + Math.round(size * 0.17) + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('PDF', size / 2, size * 0.40);
  ctx.fillStyle = '#00ff41'; ctx.font = '700 ' + Math.round(size * 0.12) + 'px sans-serif';
  ctx.fillText('BOOK', size / 2, size * 0.62);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图标生成失败')), 'image/png'));
}

async function buildAndroidOfflineZip(baseData) {
  const data = { ...baseData, pdfUrl: 'catalog.pdf' };
  delete data.pdfBase64;
  const html = makeViewerHtml(data)
    .replace('</head>', '<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#050505"><meta name="mobile-web-app-capable" content="yes"></head>')
    .replace('</body>', '<script>if("serviceWorker" in navigator){navigator.serviceWorker.register("./sw.js").catch(console.warn);}</script></body>');
  const appId = 'flipbook-' + Date.now().toString(36);
  const manifest = {
    name: state.title, short_name: state.title.slice(0, 12),
    id: './?book=' + appId, start_url: './index.html', scope: './',
    display: 'standalone', orientation: 'any', background_color: '#050505', theme_color: '#050505',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  const sw = `const CACHE='${appId}-shell-v1';\nconst SHELL=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];\nself.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));\nself.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));\nself.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname.endsWith('/catalog.pdf'))return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));});\n`;
  const guide = `安卓完全本地桌面版使用说明\n\n1. 把本文件夹完整复制到安卓平板，不能只复制 index.html。\n2. 用任意“本机静态 HTTP 服务器”应用选择本文件夹并启动，地址通常是 http://127.0.0.1:端口/。全程不需要互联网。\n3. 用 Edge 打开该 localhost 地址，菜单中选择“添加到手机/主屏幕”或“安装应用”。\n4. 后续打开桌面图标即可。若服务器应用未设置开机自启，打开画册前先启动本机服务器。\n\n为什么不能直接从文件管理器添加：Android Edge 不把 file:// 页面当作可安装网站，Service Worker 和 PWA 安装要求 localhost 或 HTTPS。\n性能说明：本包使用外置 catalog.pdf，不进行大体积 Base64 解码；正常页保留 PDF 文字层，异常页仍用兼容图。\n隐私说明：本包不访问互联网；PDF 只由平板本机 localhost 提供。\n`;
  const zip = new JSZip();
  zip.file('index.html', html);
  zip.file('catalog.pdf', state.pdfBytes);
  zip.file('manifest.webmanifest', JSON.stringify(manifest, null, 2));
  zip.file('sw.js', sw);
  zip.file('icon-192.png', await makePwaIcon(192));
  zip.file('icon-512.png', await makePwaIcon(512));
  zip.file('安卓离线桌面版使用说明.txt', guide);
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

async function buildAndDownload() {
  if (!state.pdfDoc) return;
  // 同步最新设置（任务书 4.2：目录页输入为空 → 取消）
  state.title = $('opt-title').value.trim() || state.fileName.replace(/\.pdf$/i, '') || '电子画册';
  state.renderQuality = ($('opt-render-quality') && $('opt-render-quality').value) || 'adaptive';
  const tpVal = $('opt-tocpage').value.trim();
  if (tpVal === '') {
    state.tocPage = 0;
  } else {
    const tp = parseInt(tpVal, 10);
    if (tp >= 1 && tp <= state.pdfDoc.numPages) state.tocPage = tp;
  }

  $('err-box').classList.add('hidden');
  $('result-panel').classList.add('hidden');
  $('progress-panel').classList.remove('hidden');
  setProgress('准备数据', 0, 100);

  try {
    await tick();
    const t0 = performance.now();
    // 任务书 3.2：输出保持 target 字段兼容查看器，但值必须由最终 targetPage 生成
    const zonesOut = state.zones.map(z => {
      const nz = Detect.normalizeZone(z);
      return {
        page: nz.page, name: nz.name || '',
        x: nz.x, y: nz.y, w: nz.w, h: nz.h,
        target: nz.targetPage || 0,
      };
    });

    // 输出模式：base64（内嵌，file:// 平板开箱即用，默认推荐）/ url（外部 PDF，HTML 极小，需 HTTP 部署）
    // BUG FIX (B3): 原来默认 url 并在 UI 标注「推荐」，但目标部署环境是安卓平板双击 index.html（file://），
    // 该协议下 fetch('catalog.pdf') 被 CORS 拒绝，画册只能显示"请拖入 PDF"。故默认改为 base64。
    const mode = (document.querySelector('input[name="opt-mode"]:checked') || {}).value || 'base64';
    const data = {
      title: state.title,
      totalPages: state.pdfDoc.numPages,
      tocPage: state.tocPage || 0,
      zones: zonesOut,
      renderQuality: state.renderQuality,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    };
    // 用户导入的兼容页图片随画册数据嵌入；它来自独立正常阅读器导出，
    // 不再用同一个 pdf.js 重渲染错误页面作为伪降级。
    if (state.specialPages && Object.keys(state.specialPages).length) {
      data.specialPages = state.specialPages;
    }
    if (mode === 'url') {
      data.pdfUrl = 'catalog.pdf';
    } else {
      setProgress('编码 PDF 到 base64（大文件稍候）', 20, 100);
      await tick();
      data.pdfBase64 = await u8ToBase64(state.pdfBytes, (done, total) => {
        setProgress('编码 PDF 到 base64', 20 + Math.round((done / Math.max(1, total)) * 10), 100);
      });
    }

    setProgress('生成查看器', 30, 100);
    const html = makeViewerHtml(data);

    const zip = new JSZip();
    zip.file('index.html', html);
    if (mode === 'url' && state.pdfBytes) {
      zip.file('catalog.pdf', state.pdfBytes);
    }

    setProgress('打包 ZIP（大文件不压缩，稍候）', 40, 100);
    resultBlob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      (meta) => setProgress('打包 ZIP', 40 + Math.round(meta.percent * 0.6), 100)
    );
    resultName = state.title + '_画册.zip';

    const pwaData = { ...data };
    delete pwaData.pdfBase64;
    androidBuildData = pwaData;
    androidResultBlob = null;
    androidResultName = safePackageName(state.title) + '_安卓离线桌面包.zip';

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('r-pages').textContent = state.pdfDoc.numPages + ' 页';
    $('r-zones').textContent = state.zones.filter(z => z.targetPage).length + ' 个（共 ' + state.zones.length + ' 框）';
    $('r-toc').textContent = state.tocPage ? '第 ' + state.tocPage + ' 页' : '未设置';
    $('r-size').textContent = fmtSize(resultBlob.size);
    $('result-panel').classList.remove('hidden');
    $('progress-panel').classList.add('hidden');
    log('完成: 耗时 ' + secs + 's, 体积 ' + fmtSize(resultBlob.size));
    triggerDownload(resultBlob, resultName);
  } catch (err) {
    showError('转换失败: ' + (err && err.message ? err.message : err));
    $('progress-panel').classList.add('hidden');
  }
}

function downloadResult() {
  if (resultBlob) triggerDownload(resultBlob, resultName);
}

async function downloadAndroidResult() {
  if (androidResultBlob) { triggerDownload(androidResultBlob, androidResultName); return; }
  if (!androidBuildData || !state.pdfBytes) return;
  const button = $('android-download-btn');
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '[ 正在生成安卓离线包… ]';
  try {
    androidResultBlob = await buildAndroidOfflineZip(androidBuildData);
    triggerDownload(androidResultBlob, androidResultName);
  } catch (err) {
    showError('安卓离线包生成失败: ' + (err && err.message ? err.message : err));
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

function triggerDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

// ═══════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════
function clamp01(v, min = 0, max = 1) { return Math.max(min, Math.min(max, v)); }
function r4(n) { return Math.round(n * 10000) / 10000; }
function tick() { return new Promise(r => setTimeout(r, 0)); }

function setProgress(label, cur, total) {
  $('prog-label').textContent = label;
  $('prog-num').textContent = Math.round(cur) + ' / ' + Math.round(total);
  $('bar-fill').style.width = Math.min(100, Math.max(0, (cur / total) * 100)) + '%';
}

let edProgTimer = null;
function setEdProg(msg) {
  $('ed-prog').innerHTML = msg;
}

function toast(msg) {
  const el = $('ed-toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function log(msg) {
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function fmtSize(bytes) {
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function showError(msg) {
  const el = $('err-box');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; }
  else { el.textContent = msg; el.classList.remove('hidden'); }
}

function hideAll() {
  ['file-info', 'options', 'progress-panel', 'result-panel']
    .forEach((id) => $(id).classList.add('hidden'));
  $('log').textContent = '';
}

// ── 启动 ──────────────────────────────────────────────────
bindDropzone();
bindEditorButtons();
bindDrawMode();
log('就绪。等待 PDF 文件...');
checkEnhancedCapabilities();
