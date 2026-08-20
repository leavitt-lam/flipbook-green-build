#!/usr/bin/env node
/**
 * 编辑器全流程调试（问题 1/2：自动框选一团糟、无法单独指定页码）
 * 用真实浏览器（CDP）驱动转换器：加载 PDF → 打开编辑器 → detectPage() → dump 框 DOM 实际渲染位置与交互。
 * 前置：Chrome 可用；已运行 node build.mjs 更新根目录生成器。
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => existsSync(p));
if (!CHROME) { console.error('❌ 未找到 Chrome'); process.exit(1); }

const PDF_PATH = path.join(ROOT, '.tmp_test.pdf'); // 第7页目录页小 PDF
if (!existsSync(PDF_PATH)) { console.error('❌ 缺少 .tmp_test.pdf（先生成）'); process.exit(1); }
const B64 = readFileSync(PDF_PATH).toString('base64');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const port = 10100 + Math.floor(Math.random() * 500);
  const convUrl = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1280,900', '--remote-debugging-port=' + port, convUrl,
  ], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 60; i++) {
      try { targets = await fetch('http://127.0.0.1:' + port + '/json').then(r => r.json()); if (targets.length) break; } catch {}
      await sleep(250);
    }
    const page = targets.find(t => t.type === 'page') || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 1; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params) => new Promise(res => { const id = msgId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    // 1) 等待转换器就绪
    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evalJs('typeof loadFile === "function" && !!window.pdfjsLib');
      if (ready) break;
      await sleep(300);
    }
    console.log('转换器就绪:', ready);

    // 2) 注入 PDF 并等待加载
    const r1 = await evalJs(`(async () => {
      const b64 = '${B64}';
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1 << 16) {
        const end = Math.min(i + (1 << 16), bin.length);
        for (let j = i; j < end; j++) u8[j] = bin.charCodeAt(j);
      }
      const file = new File([u8], 'toc_test.pdf', { type: 'application/pdf' });
      await loadFile(file);
      return { pages: state.pdfDoc ? state.pdfDoc.numPages : 0, fname: state.fileName };
    })()`);
    console.log('PDF 加载:', JSON.stringify(r1));

    // 3) 设置目录页并打开编辑器
    const r2 = await evalJs(`(async () => {
      $('opt-tocpage').value = '1';
      state.tocPage = 1;
      openEditor();
      await new Promise(r => setTimeout(r, 1500)); // 等首页渲染
      return {
        editingPage: state.editingPage + 1,
        holderSize: [editHolder.style.width, editHolder.style.height],
        canvasSize: [editCanvas.width, editCanvas.height],
        spinnerHidden: $('ed-spinner').classList.contains('hidden'),
      };
    })()`);
    console.log('编辑器状态:', JSON.stringify(r2));

    // 4) 自动识别（默认第 1 页 = 目录页）
    await evalJs(`detectPage()`);
    await sleep(1500);
    const r3 = await evalJs(`(() => {
      const boxes = [...document.querySelectorAll('.ebox')];
      const rows = [...document.querySelectorAll('.zone-row')];
      const rects = boxes.map(el => {
        const r = el.getBoundingClientRect();
        const h = editHolder.getBoundingClientRect();
        return { id: el.dataset.id, left: (r.left - h.left).toFixed(1), top: (r.top - h.top).toFixed(1), w: r.width.toFixed(1), h: r.height.toFixed(1) };
      });
      // 检查框是否堆叠（同位置）
      const posSet = new Set(rects.map(r => r.left + ',' + r.top));
      return {
        zones: state.zones.length,
        eboxCount: boxes.length,
        zoneRowCount: rows.length,
        uniquePos: posSet.size,
        first8: rects.slice(0, 8),
        listFirst3: rows.slice(0, 3).map(r => r.innerText),
      };
    })()`);
    console.log('═══ 自动识别结果 ═══');
    console.log(JSON.stringify(r3, null, 2));

    // 5) 交互测试：点击第一个框 → 选中 → 设置页码
    const r4 = await evalJs(`(async () => {
      const first = state.zones[0];
      selectZone(first.id);
      await new Promise(r => setTimeout(r, 100));
      const selId = state.selectedId;
      // 直接给第一个框设页码
      first.targetPage = 4;
      first.targetSource = 'manual';
      syncBoxDOM(first);
      renderZoneList();
      const row = document.querySelector('.zone-row.selected');
      return {
        selectedId: selId === first.id,
        rowSelected: !!row,
        pageInputVal: row ? row.querySelector('.z-page').value : null,
        boxPageText: document.querySelector('.ebox.selected .ebox-page') ? document.querySelector('.ebox.selected .ebox-page').textContent : null,
      };
    })()`);
    console.log('═══ 交互测试（选中+设页码）═══');
    console.log(JSON.stringify(r4, null, 2));

  } finally { proc.kill(); }
}
main().catch(e => { console.error('ERR:', e); process.exit(1); });
