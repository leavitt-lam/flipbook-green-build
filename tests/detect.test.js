/**
 * detect.js 单元测试（任务书 7.1 / 7.2 / 7.3）
 * v3.2.0: 测试数据全部改为 pdf.js 真实坐标（y 向下：页顶=0、页底=pageH）语义，
 *         并新增 4 个针对本次根因的回归测试（y 向下框位置 / 排除 Q1 / extractTextInBox / 阶段2集成）。
 * v3.2.1: 新增 viewport 归一化回归测试（常规 y 向上 PDF 兼容）+ 框体基线修正断言。
 * 运行：node --test tests/detect.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/detect.js';

const Detect = globalThis.Detect;

const PAGE_W = 800, PAGE_H = 842;

// ── 辅助：合成一页目录数据（y 向下：小 y = 页面更上）──
function makeItems(rows) {
  // rows: [{name, x, y, page}]
  const items = [];
  for (const r of rows) {
    if (r.name) items.push({ str: r.name, x: r.x, y: r.y, w: r.name.length * 6, h: 12 });
    if (r.page) items.push({ str: String(r.page), x: r.x + 500, y: r.y, w: 18, h: 12 });
  }
  return items;
}

// ═══════════════════════════════════════════════════════
// 7.1 Zone ID 测试
// ═══════════════════════════════════════════════════════
test('自动识别 20 个框，ID 全部存在且唯一', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    // y 向下：从页面顶部 120 向下排布（清洗阈值 yTop=0.12*842≈101 以内安全）
    rows.push({ name: 'PRODUCT ' + i, x: 70 + (i % 2) * 300, y: 120 + Math.floor(i / 2) * 24 });
  }
  const zones = Detect.detectZonesFromItems(makeItems(rows), PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 20);
  const ids = zones.map(z => z.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), 'ID 应为非空字符串');
  assert.equal(new Set(ids).size, 20, 'ID 应全部唯一');
});

test('createZoneId 幂等唯一 + normalizeZone 补齐字段', () => {
  const a = Detect.createZoneId(), b = Detect.createZoneId();
  assert.notEqual(a, b);
  const z = Detect.normalizeZone({ page: 7, name: 'X', x: -0.5, y: 1.5, w: 0.3, h: 0.2 });
  assert.ok(z.id);
  assert.ok(z.x >= 0 && z.x <= 1 - z.w, 'x 应满足 0≤x≤1-w');
  assert.ok(z.y >= 0 && z.y <= 1 - z.h, 'y 应满足 0≤y≤1-h');
  assert.equal(typeof z.printedPage, 'number');
  assert.equal(typeof z.targetPage, 'number');
  assert.equal(z.targetSource, 'none');
  assert.equal(z.geometrySource, 'auto');
  assert.equal(z.manualAdjusted, false);
  assert.equal(z.nameSource, 'auto');
});

// ═══════════════════════════════════════════════════════
// 7.3 文本碎片合并测试
// ═══════════════════════════════════════════════════════
test('PEARL|WASH|MAX|23 合并为一个产品，页码归它', () => {
  const items = [
    { str: 'PEARL', x: 100, y: 200, w: 50, h: 12 },
    { str: 'WASH', x: 154, y: 200, w: 42, h: 12 },
    { str: 'MAX', x: 200, y: 200, w: 30, h: 12 },
    { str: '23', x: 650, y: 200, w: 20, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 1, '应只生成 1 个框');
  assert.equal(zones[0].name, 'PEARL WASH MAX');
  assert.equal(zones[0].printedPage, 23, '页码 23 应归合并后的产品');
});

test('AQUAPEARL-|STELLA|35 与 PRO|Ⅱ|47 各自独立', () => {
  const items = [
    { str: 'AQUAPEARL-', x: 100, y: 200, w: 80, h: 12 },
    { str: 'STELLA', x: 184, y: 200, w: 46, h: 12 },
    { str: '35', x: 650, y: 200, w: 20, h: 12 },
    { str: 'PRO', x: 100, y: 240, w: 30, h: 12 },
    { str: 'Ⅱ', x: 134, y: 240, w: 12, h: 12 },
    { str: '47', x: 650, y: 240, w: 20, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 2);
  assert.ok(zones.some(z => z.name === 'AQUAPEARL- STELLA' && z.printedPage === 35));
  assert.ok(zones.some(z => z.name === 'PRO Ⅱ' && z.printedPage === 47));
});

// ═══════════════════════════════════════════════════════
// 7.2 页码模型测试
// ═══════════════════════════════════════════════════════
// 6 页测试文档：页眉印刷页码 101~106（物理页 n → 印刷 100+n）
// y 向下：页眉页码在顶部（y 小，≈35）
function makeMockDoc(numPages = 6) {
  return {
    numPages,
    async getPage(n) {
      const items = [
        { str: 'PAGE' + n, transform: [1, 0, 0, 1, 100, 300] },
        { str: String(100 + n), transform: [1, 0, 0, 1, 35, 35] }, // 页眉印刷页码（顶部）
        { str: 'CONTENT', transform: [1, 0, 0, 1, 100, 400] },
      ];
      return { getViewport: () => ({ width: 800, height: 842 }), getTextContent: () => ({ items }) };
    },
  };
}

test('印刷页码映射：印刷 103 → 物理页 3', async () => {
  const doc = makeMockDoc(6);
  const cache = new Map();
  const map = await Detect.buildPageMap(doc, cache);
  assert.ok(map, '应能建立页码映射（页眉页码在顶部）');
  assert.equal(map.toPhys(103), 3, '印刷 103 应映射到物理页 3');
});

test('自动匹配幂等：连续执行 3 次结果一致', async () => {
  const doc = makeMockDoc(6);
  // 目录页 1：产品 A（印刷 103 映射到物理 3），产品 B 无印刷页码（文本匹配到物理 4）
  const tocItems = [
    { str: 'PRODUCT A', x: 70, y: 200, w: 90, h: 12 },
    { str: '103', x: 650, y: 200, w: 20, h: 12 },
    { str: 'PRODUCT B', x: 70, y: 240, w: 90, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(tocItems, 800, 842, 1, 6);
  // 给 PRODUCT B 的产品页（物理 4）加文本：让文本匹配命中
  const realDoc = {
    numPages: 6,
    async getPage(n) {
      if (n === 4) return { getViewport: () => ({ width: 800, height: 842 }), getTextContent: () => ({ items: [{ str: 'PRODUCT B', transform: [1, 0, 0, 1, 100, 300] }] }) };
      return makeMockDoc(6).getPage(n);
    },
  };
  const snaps = [];
  for (let i = 0; i < 3; i++) {
    await Detect.autoMatchTargets(realDoc, zones, 1, new Map(), null, [1]);
    snaps.push(zones.map(z => z.targetPage + ':' + z.targetSource).join(','));
  }
  assert.equal(snaps[0], snaps[1], '第 1、2 次结果应一致');
  assert.equal(snaps[1], snaps[2], '第 2、3 次结果应一致');
});

test('人工页码优先级最高，自动流程不得覆盖', async () => {
  const doc = makeMockDoc(6);
  const tocItems = [
    { str: 'PRODUCT A', x: 70, y: 200, w: 90, h: 12 },
    { str: '103', x: 650, y: 200, w: 20, h: 12 }, // 印刷 103 → 物理 3
  ];
  const zones = Detect.detectZonesFromItems(tocItems, 800, 842, 1, 6);
  const z = zones[0];
  // 人工指定物理页 4
  z.targetPage = 4;
  z.targetSource = 'manual';
  await Detect.autoMatchTargets(doc, zones, 1, new Map(), null, [1]);
  assert.equal(z.targetPage, 4, '人工页码 4 不应被印刷映射覆盖');
  assert.equal(z.targetSource, 'manual');
});

test('所有框都有印刷页码时仍完成物理页转换（不提前返回）', async () => {
  const doc = makeMockDoc(6);
  const tocItems = [];
  for (let i = 0; i < 5; i++) {
    tocItems.push({ str: 'PRODUCT ' + i, x: 70, y: 120 + i * 30, w: 90, h: 12 });
    tocItems.push({ str: String(101 + i), x: 650, y: 120 + i * 30, w: 20, h: 12 }); // 印刷 101~105
  }
  const zones = Detect.detectZonesFromItems(tocItems, 800, 842, 1, 6);
  assert.equal(zones.length, 5);
  // 所有框都有 printedPage，但尚无 targetPage
  assert.ok(zones.every(z => z.printedPage));
  assert.ok(zones.every(z => !z.targetPage));
  await Detect.autoMatchTargets(doc, zones, 1, new Map(), null, [1]);
  assert.ok(zones.every(z => z.targetPage), '映射后所有框都应有 targetPage');
  assert.ok(zones.every(z => z.targetSource === 'printed-map'));
});

// ═══════════════════════════════════════════════════════
// v3.2.0 回归测试（本次 4 个根因）
// ═══════════════════════════════════════════════════════
test('回归：y 向下语义——顶部产品框 y 值小（不再颠倒到页底）', () => {
  // 名字在页面上部（y=200，y 向下 = 靠近页顶）
  const items = [
    { str: 'TOP PRODUCT', x: 70, y: 200, w: 90, h: 12 },
    { str: '23', x: 650, y: 200, w: 20, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].name, 'TOP PRODUCT');
  assert.equal(zones[0].printedPage, 23);
  // v3.2.1 基线修正 + v3.3 IMG_H 提升：框顶 = 基线(200) - 0.8*字号(12) - IMG_H(max(842*0.06, 12*4)=50.5) = 140.9
  assert.ok(Math.abs(zones[0].y - 140.9 / PAGE_H) < 0.01, '框 y 应 ≈ 0.167（页面顶部，含基线修正与 IMG_H 提升）');
  assert.ok(zones[0].y < 0.25, 'y 向下语义：顶部文本 → 框在顶部（修复前按 y 向上会跑到页底 ≈0.70）');
  assert.ok(zones[0].y + zones[0].h < 0.35, '框整体应在页面上半部');
  // 框应完整覆盖名字字形（基线上方 0.8h 到下方 0.2h）：[190.4, 212.4]
  const absTop = zones[0].y * PAGE_H, absBottom = (zones[0].y + zones[0].h) * PAGE_H;
  assert.ok(absTop <= 200 - 12 * 0.8 && absBottom >= 200 + 12 * 0.2, '框必须覆盖名字字形范围');
});

test('回归：pageHeadlineText 排除 Q1（右上），左中部产品名保留', async () => {
  const doc = {
    numPages: 1,
    async getPage() {
      return {
        getViewport: () => ({ width: PAGE_W, height: PAGE_H }),
        getTextContent: () => ({ items: [
          { str: 'FEATURES', transform: [1, 0, 0, 1, 600, 100] },      // Q1 右上 → 排除
          { str: 'SUPER SCOPE WASH', transform: [1, 0, 0, 1, 71, 450] }, // 左中部 → 保留
          { str: '46', transform: [1, 0, 0, 1, 700, 800] },             // 右下 → 保留
        ] }),
      };
    },
  };
  const head = await Detect.pageHeadlineText(doc, 1, new Map());
  assert.ok(!head.includes('FEATURES'), 'Q1（右上）文本应被排除');
  assert.ok(head.includes('SUPERSCOPEWASH'), '左中部产品名应保留');
  assert.ok(head.includes('46'), '右下部文本应保留（仅排除 Q1）');
});

test('回归：extractTextInBox 屏幕框在顶部提取到顶部文本（y 向下无需翻转）', () => {
  const items = [
    { str: 'HEADER', x: 50, y: 50, w: 60, h: 12 },   // 顶部
    { str: 'MIDDLE', x: 50, y: 400, w: 60, h: 12 },  // 中部
    { str: 'FOOTER', x: 50, y: 800, w: 60, h: 12 },  // 底部
  ];
  // 屏幕顶部框（归一化 y 0.02~0.12 → PDF y 16.8~101）
  const box = { x: 0.05, y: 0.02, w: 0.2, h: 0.1 };
  const text = Detect.extractTextInBox(items, box, PAGE_W, PAGE_H);
  assert.ok(text.includes('HEADER'), '框在顶部应提取到顶部文本（修复前按 y 向上翻转会提取到底部 FOOTER）');
  assert.ok(!text.includes('FOOTER'), '底部文本不应被顶部框提取');
});

test('回归：产品名在左上半部（y<半高）时 Q2 严格过滤会漏、排除 Q1 不漏', async () => {
  const tocItems = [
    { str: 'SUPER SCOPE WASH', x: 70, y: 120, w: 120, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(tocItems, PAGE_W, PAGE_H, 1, 3);
  assert.equal(zones.length, 1);
  assert.ok(!zones[0].printedPage, '目录页无印刷页码 → 应走文本匹配');
  const doc = {
    numPages: 3,
    async getPage(n) {
      if (n === 3) {
        // 产品页 3：产品名在左上半部（y=380 < 421=半高）且被页码 46 拆段 → 整串不命中，只能靠阶段 2
        // Q1（右上 600,100）有 FEATURES 噪声（旧 Q2 严格过滤 y>半高 会漏掉 y=380 的产品名）
        return {
          getViewport: () => ({ width: PAGE_W, height: PAGE_H }),
          getTextContent: () => ({ items: [
            { str: 'SUPER', transform: [1, 0, 0, 1, 71, 380] },
            { str: '46', transform: [1, 0, 0, 1, 300, 380] },
            { str: 'SCOPE', transform: [1, 0, 0, 1, 330, 380] },
            { str: 'WASH', transform: [1, 0, 0, 1, 400, 380] },
            { str: 'FEATURES', transform: [1, 0, 0, 1, 600, 100] },
          ] }),
        };
      }
      return makeMockDoc(3).getPage(n);
    },
  };
  await Detect.autoMatchTargets(doc, zones, 1, new Map(), null, [1]);
  assert.equal(zones[0].targetPage, 3, '排除 Q1 后左上半部产品名应命中');
  assert.equal(zones[0].targetSource, 'text-match');
});

// ═══════════════════════════════════════════════════════
// v3.2.1 回归测试（viewport 归一化：常规 y 向上 PDF 兼容）
// ═══════════════════════════════════════════════════════
test('回归：pageRawItems 经 viewport 归一化——常规 y 向上 PDF 也得到 y 向下坐标', async () => {
  // 模拟浏览器端（全局 pdfjsLib 存在）+ 常规 PDF（左下原点，y 向上）：
  // 页眉页码画在页顶（用户空间 y=807），经 viewport 变换 [1,0,0,-1,0,842] 应变为 y=35（页顶）
  const savedLib = globalThis.pdfjsLib;
  globalThis.pdfjsLib = {
    Util: {
      transform(m, t) {
        return [
          m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
          m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
          m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
        ];
      },
    },
  };
  try {
    const doc = {
      numPages: 3,
      async getPage(n) {
        return {
          getViewport: () => ({ width: 800, height: 842, transform: [1, 0, 0, -1, 0, 842] }),
          getTextContent: () => ({ items: [
            { str: String(100 + n), transform: [1, 0, 0, 1, 35, 807] }, // 页顶（y-up 用户空间）
          ] }),
        };
      },
    };
    const items = await Detect.pageRawItems(doc, 1, new Map());
    assert.ok(Math.abs(items[0].transform[5] - 35) < 0.01,
      'y 向上 PDF 经 viewport 归一化后应为 y 向下坐标（y=842-807=35）');
    // buildPageMap 依赖归一化坐标采样页眉/页脚，也应正常工作
    const map = await Detect.buildPageMap(doc, new Map());
    assert.ok(map, '归一化后 buildPageMap 应采样到页眉页码');
    assert.equal(map.toPhys(103), 3, '印刷 103 → 物理 3');
  } finally {
    if (savedLib === undefined) delete globalThis.pdfjsLib;
    else globalThis.pdfjsLib = savedLib;
  }
});


// ═══════════════════════════════════════════════════════
// v3.3 回归测试（框边界 / 页脚噪声 / 标题行匹配）
// ═══════════════════════════════════════════════════════
test('v3.4：无页码时按相邻列间距推断右缘且不重叠', () => {
  // 两列：列1 名字 x=70-115，列2 名字 x=170-210；列间距 55pt
  const items = [
    { str: 'PRODUCT A', x: 70, y: 700, w: 45, h: 12 },
    { str: 'PRODUCT B', x: 170, y: 700, w: 40, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 2);
  const a = zones.find(z => z.name === 'PRODUCT A');
  const b = zones.find(z => z.name === 'PRODUCT B');
  assert.ok(a.x * PAGE_W >= 60 && (a.x + a.w) * PAGE_W >= 145 && (a.x + a.w) * PAGE_W <= 168, 'A 框应利用列间距扩展，但不能碰到下一列');
  assert.ok(b.x * PAGE_W >= 160 && (b.x + b.w) * PAGE_W <= 230, 'B 框右缘不应越过下一列');
  assert.ok((a.x + a.w) <= b.x + 0.001, '相邻列框不得重叠');
});

test('v3.4：页码右缘作为产品卡右边界锚点，不再退化为文字右缘+8pt', () => {
  const items = [
    { str: 'PRODUCT A', x: 70, y: 700, w: 60, h: 12 },
    { str: '23', x: 260, y: 700, w: 18, h: 12 },
    { str: 'PRODUCT B', x: 70, y: 650, w: 58, h: 12 },
    { str: '24', x: 260, y: 650, w: 18, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 2);
  for (const z of zones) {
    const right = (z.x + z.w) * PAGE_W;
    assert.ok(right >= 282 && right <= 292, '框右缘应覆盖页码并带少量余量，实际=' + right);
  }
});

test('v3.4：框顶依据同列真实行距扩展，不写死页面百分比', () => {
  const items = [
    { str: 'PRODUCT A', x: 70, y: 200, w: 60, h: 12 },
    { str: '23', x: 260, y: 200, w: 18, h: 12 },
    { str: 'PRODUCT B', x: 70, y: 290, w: 60, h: 12 },
    { str: '24', x: 260, y: 290, w: 18, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  const b = zones.find(z => z.name === 'PRODUCT B');
  assert.ok(b, '应识别第二行产品');
  const top = b.y * PAGE_H;
  // 上一行字形下沿约 202.4pt；框顶应从其后少量留白开始，而不是固定上扩 6%。
  assert.ok(top >= 202 && top <= 210, '框顶应跟随上一行边界，实际=' + top.toFixed(1));
});

test('v3.3：页脚免责声明（含 * 长文本）不生成框', () => {
  const items = [
    { str: 'REAL PRODUCT', x: 70, y: 700, w: 90, h: 12 },
    { str: '*Light source life depends on several factors, including but not limited to: environmental', x: 660, y: 790, w: 360, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(items, PAGE_W, PAGE_H, 7, 62);
  assert.equal(zones.length, 1, '应只生成 1 个框（免责声明被过滤）');
  assert.equal(zones[0].name, 'REAL PRODUCT');
});

test('v3.3：pageTitleBlocks 提取标题字号文本（正文 8pt，标题 14pt）', async () => {
  const mockDoc = {
    numPages: 1,
    async getPage() {
      return {
        getViewport: () => ({ width: 1191, height: 842 }),
        getTextContent: () => ({ items: [
          { str: 'MINI LASER AQUA PRO', transform: [14, 0, 0, 14, 880, 160], width: 100 },
          { str: 'Some feature description text here', transform: [8, 0, 0, 8, 100, 400], width: 200 },
          { str: 'LASER MOVING BEAM', transform: [18, 0, 0, 18, 880, 120], width: 120 },
        ] }),
      };
    },
  };
  const cache = new Map();
  const titles = await Detect.pageTitleBlocks(mockDoc, 1, cache);
  assert.ok(titles.includes(Detect.normalizeText('MINI LASER AQUA PRO')), '标题应包含产品名（14pt ≥ 8*1.6）');
  assert.ok(titles.includes(Detect.normalizeText('LASER MOVING BEAM')), '标题应包含分类大标题（18pt）');
  assert.ok(!titles.includes('FEATUREDESCRIPTION'), '正文 8pt 不应进标题');
});

test('v3.4：两行产品标题先合并再规范化', async () => {
  const mockDoc = {
    numPages: 1,
    async getPage() {
      return {
        getViewport: () => ({ width: 800, height: 842 }),
        getTextContent: () => ({ items: [
          { str: 'body text body text', transform: [8, 0, 0, 8, 100, 500], width: 120 },
          { str: 'PEARL WASH', transform: [16, 0, 0, 16, 480, 180], width: 110, fontName: 'Brand-Bold' },
          { str: 'MAX', transform: [16, 0, 0, 16, 482, 207], width: 38, fontName: 'Brand-Bold' },
        ] }),
      };
    },
  };
  const candidates = await Detect.pageTitleCandidates(mockDoc, 1, new Map());
  assert.ok(candidates.some(c => c.norm === Detect.normalizeText('PEARL WASH MAX') && c.lineCount === 2));
});

test('v3.4：系列总览页含多个产品标题时不得抢先匹配', async () => {
  const zones = ['PRODUCT A', 'PRODUCT B', 'PRODUCT C'].map((name, i) => Detect.normalizeZone({
    page: 1, name, x: 0.1, y: 0.2 + i * 0.1, w: 0.3, h: 0.08,
    printedPage: 0, targetPage: 0, targetSource: 'none',
  }));
  const pages = {
    2: [
      { str: 'PRODUCT A', transform: [14, 0, 0, 14, 420, 140], width: 80 },
      { str: 'PRODUCT B', transform: [14, 0, 0, 14, 420, 190], width: 80 },
      { str: 'PRODUCT C', transform: [14, 0, 0, 14, 420, 240], width: 80 },
    ],
    3: [{ str: 'PRODUCT A', transform: [16, 0, 0, 16, 420, 160], width: 90 }],
    4: [{ str: 'PRODUCT B', transform: [16, 0, 0, 16, 420, 160], width: 90 }],
    5: [{ str: 'PRODUCT C', transform: [16, 0, 0, 16, 420, 160], width: 90 }],
  };
  const doc = {
    numPages: 5,
    async getPage(n) {
      return {
        getViewport: () => ({ width: 800, height: 842 }),
        getTextContent: () => ({ items: pages[n] || [] }),
      };
    },
  };
  await Detect.autoMatchTargets(doc, zones, 1, new Map(), null, [1]);
  assert.deepEqual(zones.map(z => z.targetPage), [3, 4, 5]);
});

test('v3.6：规格密集页只有分散关键词时不得兜底误匹配', async () => {
  const zone = Detect.normalizeZone({
    page: 1, name: 'DOLPHIN SMART', x: 0.1, y: 0.2, w: 0.3, h: 0.08,
    printedPage: 0, targetPage: 0, targetSource: 'none',
  });
  const pages = {
    2: [{ str: 'DIVIDER', transform: [18, 0, 0, 18, 420, 160], width: 80 }],
    3: [
      { str: 'DOLPHIN optical system and many specifications', transform: [8, 0, 0, 8, 100, 420], width: 260 },
      { str: 'SMART control protocol and more body text', transform: [8, 0, 0, 8, 100, 450], width: 240 },
    ],
  };
  const doc = {
    numPages: 3,
    async getPage(n) {
      return {
        getViewport: () => ({ width: 800, height: 842 }),
        getTextContent: () => ({ items: pages[n] || [] }),
      };
    },
  };
  await Detect.autoMatchTargets(doc, [zone], 1, new Map(), null, [1]);
  assert.equal(zone.targetPage, 0, '没有标题或完整名称证据时应留空，不能集中指向规格页');
});

test('v3.3：autoMatchTargets 标题行整串匹配（产品名在标题而非正文）', async () => {
  const tocItems = [
    { str: 'PRODUCT A', x: 70, y: 700, w: 90, h: 12 },
    { str: 'PRODUCT B', x: 70, y: 660, w: 90, h: 12 },
  ];
  const zones = Detect.detectZonesFromItems(tocItems, 800, 842, 1, 6);
  const pages = {
    2: [{ str: 'PRODUCT A', transform: [14, 0, 0, 14, 100, 200], width: 80 }],
    3: [{ str: 'Some text', transform: [8, 0, 0, 8, 100, 400], width: 50 }],
    4: [{ str: 'PRODUCT B is mentioned in body', transform: [8, 0, 0, 8, 100, 400], width: 150 }],
  };
  const mockDoc = {
    numPages: 4,
    async getPage(n) {
      return {
        getViewport: () => ({ width: 800, height: 842 }),
        getTextContent: () => ({ items: pages[n] || [] }),
      };
    },
  };
  await Detect.autoMatchTargets(mockDoc, zones, 1, new Map(), null, [1]);
  const a = zones.find(z => z.name === 'PRODUCT A');
  const b = zones.find(z => z.name === 'PRODUCT B');
  assert.equal(a.targetPage, 2, 'PRODUCT A 应经标题行匹配到第 2 页');
  assert.equal(b.targetPage, 4, 'PRODUCT B 应经整页匹配到第 4 页（正文提及）');
});
