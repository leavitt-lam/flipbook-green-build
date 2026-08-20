/* ═══════════════════════════════════════════════════════════
   detect.js — 目录页产品框自动识别 + 跳转页码自动匹配
   v4 网格目录算法（针对"对开分栏目录页"设计）：
   1) 清洗：剔除空文本、页眉（免责声明/页码）、页脚
   2) 行聚类：y 差 ≤ 12pt 合并为同一行
      （pdf.js 常把同一行的文本块拆成相差几 pt 的多个 y，
       例如 PRO Ⅱ 在 y=326、AQUAPEARL- 在 y=333，实际是同一行）
   3) 标题行过滤：无页码 且 每栏 span≤2 且 两栏都有 → 分类标题行
   4) 全局列起点聚类（排除页码 span）→ 自动发现网格列
   5) 行×列 生成产品框：同行同列 span 合并为产品名，
      页码 span 归入"左侧最近的列"
   6) 分栏排序：左栏上→下（行内左→右），再右栏上→下
   v3.4：右边界优先跟随同行页码，自适应回退到相邻列间距；产品页标题
   支持两行合并并排除目录/总览页，重新识别可由编辑器保留人工调整。
   v3.2.0（Fix 2/3）：全链路改为 pdf.js 真实坐标（y 向下：页顶=0），
   页码匹配由 Q2 严格过滤改为「排除 Q1（右上）」。
   v3.2.1：输入坐标统一经 viewport.transform 归一化（app.js 侧完成，
   pageRawItems 内对浏览器端原始 items 同样归一化），兼容内部坐标约定
   不同的 PDF；框体推导修正基线→字形偏移（≈0.8 字号）。
   浏览器（script 标签 → window.Detect）与 Node（module.exports）双端可用
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function r4(n) { return Math.round(n * 10000) / 10000; }
  function clamp01(v, min = 0, max = 1) { return Math.max(min, Math.min(max, v)); }

  // ── Zone ID 与规范化（任务书 3.1）────────────────────────
  let zoneSeq = 0;
  function createZoneId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'z' + crypto.randomUUID().slice(0, 8);
    }
    zoneSeq += 1;
    return 'z' + Date.now().toString(36) + '_' + zoneSeq;
  }

  // 补齐缺失 ID、校验坐标、页码字段。所有 zone 进入 state.zones 前必须经过此函数。
  function normalizeZone(z) {
    const out = Object.assign({}, z);
    if (!out.id) out.id = createZoneId();
    if (!out.page || out.page < 1) out.page = 1;
    const w = clamp01(out.w == null ? 0 : out.w, 0, 1);
    const h = clamp01(out.h == null ? 0 : out.h, 0, 1);
    out.w = r4(w);
    out.h = r4(h);
    // 边界约束：0 ≤ x ≤ 1-w, 0 ≤ y ≤ 1-h（任务书 4.3）
    out.x = r4(clamp01(out.x == null ? 0 : out.x, 0, 1 - w));
    out.y = r4(clamp01(out.y == null ? 0 : out.y, 0, 1 - h));
    // 页码数据模型（任务书 3.2）：
    //   printedPage 目录文字识别的印刷页码；targetPage 最终 PDF 物理页码；targetSource 来源
    if (!('printedPage' in out)) out.printedPage = out.target || 0;
    if (!('targetPage' in out)) out.targetPage = 0;
    if (!('targetSource' in out)) out.targetSource = 'none';
    if (!('confidence' in out)) out.confidence = out.confidence == null ? 0 : out.confidence;
    if (!('geometrySource' in out)) out.geometrySource = 'auto';
    if (!('manualAdjusted' in out)) out.manualAdjusted = false;
    if (!('nameSource' in out)) out.nameSource = 'auto';
    return out;
  }

  // 文本归一化：大写 + 全角转半角 + 罗马数字转字母 + 去空白
  // （页面全文匹配用：目录里的 "Ⅱ" 在正文里可能是 "II"）
  const ROMAN_MAP = {
    '\u2160': 'I', '\u2161': 'II', '\u2162': 'III', '\u2163': 'IV', '\u2164': 'V',
    '\u2165': 'VI', '\u2166': 'VII', '\u2167': 'VIII', '\u2168': 'IX', '\u2169': 'X'
  };
  function normalizeText(s) {
    return (s || '')
      .toUpperCase()
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[\u2160-\u2169]/g, ch => ROMAN_MAP[ch] || ch)
      .replace(/\s+/g, '');
  }

  // 名字清洗：压缩空白、去尾部连字符/点号等装饰符
  function cleanName(s) {
    return (s || '')
      .replace(/\s+/g, ' ')
      .replace(/[.\u00b7\u2022\u2026-]{2,}$/, '')
      .replace(/-+\s*$/, '')
      .replace(/\s+$/g, '')
      .trim();
  }

  // 识别"页码字符串"：纯数字 或 "46/47"
  function parsePageNumStr(s) {
    s = (s || '').trim();
    let m = /^(\d{1,4})\/\d{1,4}$/.exec(s);
    if (m && s.length <= 9) return parseInt(m[1], 10);
    m = /^\d{1,4}$/.exec(s);
    if (m) return parseInt(m[0], 10);
    return null;
  }
  const isPageNumStr = s => parsePageNumStr(s) !== null;

  // ── 行聚类 ────────────────────────────────────────────────
  // 按 y 排序；y 差 ≤ ROW_TOL 的 span 归为同一行
  // 注意：同行不同文本块的 y 可漂移 5~10pt，阈值必须覆盖这个范围
  function clusterLines(items, ROW_TOL) {
    const sorted = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const rows = [];
    for (const it of sorted) {
      let row = rows[rows.length - 1];
      if (!row || it.y - row.yMax > ROW_TOL) {
        row = { yMin: it.y, yMax: it.y, spans: [] };
        rows.push(row);
      }
      row.yMin = Math.min(row.yMin, it.y);
      row.yMax = Math.max(row.yMax, it.y);
      row.spans.push(it);
    }
    return rows;
  }

  // 页内正文字号中位数（任务书 4.1-5：容差按字号自适应，不假定固定 12pt）
  function medianFontSize(spans) {
    const hs = (spans || []).map(s => s.h || 0).filter(h => h > 2 && h < 100);
    if (!hs.length) return 10;
    hs.sort((a, b) => a - b);
    return hs[Math.floor(hs.length / 2)];
  }

  function medianNumber(values, fallback) {
    const nums = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
    return nums.length ? nums[Math.floor(nums.length / 2)] : fallback;
  }

  // 行内名称碎片合并（任务书 4.1）：
  // 把属于同一产品名的碎片（PEARL | WASH | MAX）按阅读顺序合并成一个「名称块」，
  // 页码 span 独立出来不参与合并；合并阈值 = 字符间距（字号自适应），小于列间距。
  function mergeNameSpans(spans, fontSizeRef) {
    const pageNumSpans = spans.filter(s => isPageNumStr(s.str));
    // 按 x 升序（左→右），稳定排序保持同 x 碎片的原始流顺序（前缀在前，如 AQUAPEARL- → PRO Ⅱ）
    const others = spans.filter(s => !isPageNumStr(s.str)).sort((a, b) => a.x - b.x);
    // 基线容差与行聚类一致（pdf.js 同行 span 的 y 可漂移 5~10pt）
    const lineTol = Math.max(8, (fontSizeRef || 10) * 1.6);
    const blocks = [];
    let cur = null;
    for (const s of others) {
      if (!cur) {
        cur = { spans: [s] };
        blocks.push(cur);
        continue;
      }
      const last = cur.spans[cur.spans.length - 1];
      const fs = Math.max(last.h || fontSizeRef || 8, s.h || fontSizeRef || 8);
      const xGap = s.x - (last.x + last.w);
      const nearX = xGap <= Math.max(4, fs * 0.8);              // 词间距合并阈值
      const sameLine = Math.abs(last.y - s.y) <= lineTol;       // 基线差容差
      if (nearX && sameLine) {
        cur.spans.push(s);
      } else {
        cur = { spans: [s] };
        blocks.push(cur);
      }
    }
    for (const b of blocks) {
      b.minX = Math.min(...b.spans.map(s => s.x));
      b.minY = Math.min(...b.spans.map(s => s.y));
      b.maxY = Math.max(...b.spans.map(s => s.y + (s.h || 0)));
      b.maxX = Math.max(...b.spans.map(s => s.x + s.w));
    }
    return { blocks, pageNumSpans };
  }

  // ── 标题行判定 ────────────────────────────────────────────
  // 分类标题（EFFECT LIGHT / LED MOVING WASH / MOVING BEAM…）的特征：
  // 无页码、每栏 span 数 ≤ 2、且左右两栏都有内容
  // （无页码产品行如 TX1920 ZOOM 只在左栏，不会被误杀）
  function rowIsHeader(row, pageW) {
    const spans = row.spans;
    if (spans.some(it => isPageNumStr(it.str))) return false;
    const mid = pageW / 2;
    const left = spans.filter(it => it.x < mid).length;
    const right = spans.filter(it => it.x >= mid).length;
    return left > 0 && right > 0 && left <= 2 && right <= 2;
  }

  // ── 主检测函数 ────────────────────────────────────────────
  function detectZonesFromItems(items, pageW, pageH, pageNum, totalPages) {
    // 1. 清洗：空文本、页眉、页脚。
    //    v3.2.0 Fix 2: pdf.js 文本坐标 y **向下**（页顶=0、页底=pageH）。
    //    因此 y < 0.12*pageH 过滤顶部 12%（页眉/免责声明），y > 0.93*pageH 过滤底部 7%（页脚）。
    const yTop = pageH * 0.12, yBottom = pageH * 0.93;
    const spans = [];
    for (const it of (items || [])) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const y = it.y || 0;
      if (y < yTop || y > yBottom) continue;
      spans.push({ str, x: it.x || 0, y, w: it.w || 0, h: it.h || 0 });
    }
    if (!spans.length) return [];

    // 2. 全部行聚类（保留标题行，用于计算产品卡边界）
    // 任务书 4.1-5：行/列容差按页内字号自适应，不假定固定 12pt/14pt
    const fontSizeRef = medianFontSize(spans);
    const ROW_TOL = Math.max(8, fontSizeRef * 1.6);
    const allRows = clusterLines(spans, ROW_TOL);

    // 3. 过滤标题行
    const bodyRows = allRows.filter(r => !rowIsHeader(r, pageW));
    if (!bodyRows.length) return [];

    // 3.5 行内名称碎片合并（任务书 4.1）：PEARL|WASH|MAX 合并为一个名称块，页码独立
    const mergedRows = bodyRows.map(row => {
      const { blocks } = mergeNameSpans(row.spans, fontSizeRef);
      return { row, blocks };
    });

    // 4. 全局列起点聚类：基于合并后的名称块（页码 span 不参与）
    const COL_TOL = Math.max(10, fontSizeRef * 2);
    const src = [];
    for (const { blocks } of mergedRows) {
      for (const b of blocks) src.push(b.minX);
    }
    src.sort((a, b) => a - b);
    const cols = [];
    for (const x of src) {
      if (!cols.length || x - cols[cols.length - 1] > COL_TOL) cols.push(x);
    }

    // 5. 行 × 列 → 产品框（锚点方案：以"名称块"为锚点）
    //    v3.2.0 Fix 2: items 的 y 为屏幕坐标（**y 向下**：页顶=0、页底=pageH，经 viewport 归一化）。
    //    - 左：名称块 minX - PAD（往左扩一点）
    //    - 上：由同列相邻产品名字形间距推导；首行用本列中位行距反推
    //    - 下：名称块字形下边界（基线+0.2字号）+ PAD（略低于名字）
    //    - 右：列右边界（见下方 colRight）—— BUG FIX (v3.3)：原来右边缘 = 列起点 + colW，
    //      把"列间距"整个包进框内（实测右边缘超出卡片真实右缘约 1/4），
    //      改为"列内最宽名称块/页码的右缘 + 图右余量"。
    //    输出为屏幕坐标（top 从页面顶部向下），与 PDF y 同向：y = 框顶PDF_y/pageH。
    const PAD = 3;               // 框边缘 padding (pt)
    const ASC = 0.8;             // 基线到字形顶部的近似比例
    const IMG_R_MARGIN = 8;      // 框右超出"最宽文本右缘"的余量 (pt)，覆盖产品图右缘（实测图右比名右最多宽 ~7pt）
    const ROW_GAP_THRESH = 150;  // 列间距超过此视为跨栏间隙
    const zones = [];

    // ── 5.0 列级左/右边界（两遍法）────────────────────
    // 列左 = 列内最小名称块 minX；列右 = max(列内名称块 maxX, 列内页码 maxX)。
    // 统一列边界保证同列各框右缘对齐、框宽整齐，且不再吃掉列间距。
    const colLefts = cols.map(() => Infinity);
    const colRights = cols.map(() => -Infinity);
    const colPageRightSamples = cols.map(() => []);
    for (const { row, blocks } of mergedRows) {
      const rowPageSpans = row.spans.filter(it => isPageNumStr(it.str));
      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        const block = blocks.find(b => Math.abs(b.minX - c) <= COL_TOL);
        if (!block) continue;
        // 页脚免责声明/装饰噪声（含 * 或超长文本）不参与列边界（否则污染整列右缘）
        const bn = cleanName(block.spans.map(it => it.str).join(' '));
        if (bn.includes('*') || bn.length > 40) continue;
        colLefts[ci] = Math.min(colLefts[ci], block.minX);
        colRights[ci] = Math.max(colRights[ci], block.maxX);
      }
      // 页码通常位于产品卡最右侧，是比“产品名文字右缘”更可靠的卡片右边界锚点。
      // 旧实现要求页码 x 与列起点相差不超过约 20pt，真实目录中页码往往相隔数百 pt，
      // 因而这个分支几乎从不生效，右边缘才会退化成“文字右缘 + 8pt”。
      // 现在把每个页码分配给同行左侧最近的名称块，并按列累计页码右缘样本。
      for (const ps of rowPageSpans) {
        let bestCi = -1, bestD = Infinity;
        for (let ci = 0; ci < cols.length; ci++) {
          const block = blocks.find(b => Math.abs(b.minX - cols[ci]) <= COL_TOL);
          if (!block || block.maxX > ps.x + 2) continue;
          const d = ps.x - block.maxX;
          if (d < bestD) { bestD = d; bestCi = ci; }
        }
        if (bestCi >= 0) colPageRightSamples[bestCi].push(ps.x + ps.w);
      }
    }
    for (let ci = 0; ci < cols.length; ci++) {
      if (colRights[ci] < 0) colRights[ci] = cols[ci] + 100;
      if (colPageRightSamples[ci].length) {
        const samples = colPageRightSamples[ci].slice().sort((a, b) => a - b);
        // 用中位数拒绝少数错位页码/装饰数字；再与文字右缘取大值。
        colRights[ci] = Math.max(colRights[ci], samples[Math.floor(samples.length / 2)]);
      } else if (ci + 1 < cols.length) {
        // 没有文字页码时，用相邻列中线作保守 fallback，避免短产品名导致框宽严重不足。
        const nextLeft = colLefts[ci + 1] < Infinity ? colLefts[ci + 1] : cols[ci + 1];
        const pitchRight = cols[ci] + (nextLeft - cols[ci]) * 0.88;
        colRights[ci] = Math.max(colRights[ci], pitchRight);
      }
    }

    // ── 5.1 按真实行距推导每列卡片上边界 ────────────────
    // 产品名通常位于卡片底部，上一产品名字形下沿到当前名字形上沿就是当前产品图的
    // 可用高度。这里不再写死“向上扩页面高度的 N%”：有上一行时直接取上一行文字
    // 下沿后的空白边界；首行则使用本列产品名基线间距的中位数推导。
    const colAnchors = cols.map(() => []);
    for (let ri = 0; ri < mergedRows.length; ri++) {
      const { blocks } = mergedRows[ri];
      for (let ci = 0; ci < cols.length; ci++) {
        const block = blocks.find(b => Math.abs(b.minX - cols[ci]) <= COL_TOL);
        if (!block) continue;
        const name = cleanName(block.spans.map(it => it.str).join(' '));
        if (name.length < 2 || name.includes('*') || name.length > 40) continue;
        colAnchors[ci].push({
          ri,
          top: block.minY - ASC * fontSizeRef,
          bottom: block.maxY - ASC * fontSizeRef,
          baseline: block.minY,
        });
      }
    }
    const allPitchSamples = [];
    const colPitches = colAnchors.map(anchors => {
      anchors.sort((a, b) => a.baseline - b.baseline);
      const samples = [];
      for (let i = 1; i < anchors.length; i++) {
        const gap = anchors[i].baseline - anchors[i - 1].baseline;
        if (gap >= fontSizeRef * 2 && gap <= pageH * 0.25) {
          samples.push(gap);
          allPitchSamples.push(gap);
        }
      }
      return medianNumber(samples, 0);
    });
    const globalPitch = medianNumber(allPitchSamples, fontSizeRef * 5);

    for (let ri = 0; ri < mergedRows.length; ri++) {
      const { row, blocks } = mergedRows[ri];

      // 该行的页码 span（页码分配时使用）
      const rowPageNumSpans = row.spans.filter(it => isPageNumStr(it.str));

      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        // 该列该行的名称块（合并后的完整产品名）
        const block = blocks.find(b => Math.abs(b.minX - c) <= COL_TOL);
        if (!block) continue;
        const name = cleanName(block.spans.map(it => it.str).join(' '));
        if (name.length < 2) continue;
        // 页脚免责声明/装饰噪声：含 * 的长文本（如 "*Light source life depends..."）不生成框
        if (name.includes('*') || name.length > 40) continue;

        // 名字文字 bbox（锚点；v3.2.0 Fix 2: items 的 y 为 pdf.js 用户空间坐标，**y 向下**，
        // 页顶 = 0、页底 = pageH）
        // v3.2.1 Fix: 文本 y 是**基线**，字形实际范围 ≈ [基线-0.8h, 基线+0.2h]
        // （y 向下时字形在基线上方）。原实现把 [基线, 基线+h] 当文本框，
        // 框整体向下偏 ~0.8 字号 → 识别框位置偏低的根因。
        const nameMinX = block.minX;
        const nameTopPdfY = block.minY - ASC * fontSizeRef;    // 字形上边界
        const nameBottomPdfY = block.maxY - ASC * fontSizeRef; // 字形下边界（maxY=基线+h，-0.8h ≈ 基线+0.2h）

        // 框顶依据同列行距覆盖名字上方产品图；输出 z.y 与 PDF y 同为向下坐标。
        const boxLeft = Math.max(0, colLefts[ci] - PAD);
        const nextColLimit = ci + 1 < cols.length ? cols[ci + 1] - PAD : pageW - PAD;
        const boxRight = Math.min(pageW - PAD, nextColLimit, colRights[ci] + IMG_R_MARGIN);
        const anchors = colAnchors[ci];
        const anchorIndex = anchors.findIndex(a => a.ri === ri);
        const prevAnchor = anchorIndex > 0 ? anchors[anchorIndex - 1] : null;
        const localPitch = colPitches[ci] || globalPitch;
        const interCardGap = Math.max(PAD, fontSizeRef * 0.25);
        let boxTopPdfY;
        if (prevAnchor && nameTopPdfY - prevAnchor.bottom <= localPitch * 1.55) {
          // 中间行：从上一产品名下沿之后开始，天然跟随本画册真实网格行距。
          boxTopPdfY = prevAnchor.bottom + interCardGap;
        } else {
          // 首行/跨分类大间隙：由本列中位行距反推；无足够样本时仅按字号回退。
          const glyphH = Math.max(fontSizeRef, nameBottomPdfY - nameTopPdfY);
          const inferredImageH = Math.max(fontSizeRef * 4, localPitch - glyphH - interCardGap);
          boxTopPdfY = nameTopPdfY - inferredImageH;
        }
        const boxBottomPdfY = nameBottomPdfY + PAD;    // PDF y：框底
        const boxW = boxRight - boxLeft;
        const boxH = boxBottomPdfY - boxTopPdfY;

        // 屏幕坐标（左上原点，向下为正；与 PDF y 同向，无需翻转）
        const screenTop = boxTopPdfY / pageH;
        const screenBottom = boxBottomPdfY / pageH;

        zones.push(normalizeZone({
          id: createZoneId(),
          page: pageNum,
          name: name.slice(0, 60),
          printedPage: 0,
          targetPage: 0,
          targetSource: 'none',
          confidence: name.length < 4 ? 0.6 : 1, // 任务书 4.1-4：无法可靠判断时降低置信度
          geometrySource: 'auto',
          manualAdjusted: false,
          nameSource: 'auto',
          x: r4(boxLeft / pageW),
          y: r4(Math.max(0, Math.min(1, screenTop))),
          w: r4(boxW / pageW),
          h: r4(boxH / pageH),
          _row: ri,
          _minX: block.minX, _maxX: boxRight,
          _minY: screenTop, _maxY: screenBottom
        }));
      }

      // 页码分配：只在本行内，左侧最近列的产品；写入 printedPage（任务书 3.2：
      // 识别出的印刷页码不得直接写入最终物理页）
      for (const s of rowPageNumSpans) {
        let bestCi = -1, bestD = Infinity;
        for (let ci = 0; ci < cols.length; ci++) {
          const c = cols[ci];
          if (c > s.x - 2) continue; // 页码应在产品名右侧
          const d = s.x - c;
          if (d < bestD) { bestD = d; bestCi = ci; }
        }
        if (bestCi >= 0) {
          // BUG FIX (B1): 原来用 `z._minX === cols[bestCi]` 严格浮点相等，
          // 同一列内不同行的 x 与列起点差 < COL_TOL(14pt)，几乎永不相等，
          // 导致 43 个框实测仅 1 个分配到页码。改为容差匹配。
          const z = zones.find(z => z._row === ri && Math.abs(z._minX - cols[bestCi]) <= COL_TOL && !z.printedPage);
          if (z) {
            const pn = parsePageNumStr(s.str);
            // 印刷页码与物理页数无关（如 101~105 这类从 100 起计的页码），不得用 totalPages
            // 限制，否则会被全部过滤（任务书 3.2：印刷/物理分离；物理映射在 autoMatchTargets 校验）
            if (pn !== null && pn >= 1 && pn <= 9999) z.printedPage = pn;
          }
        }
      }
    }

    // 6. 分栏排序：左栏（行 y → 列 x）→ 右栏
    // 注意：_minY 为屏幕坐标（归一化 0-1，小 = 页面更上），比较阈值须用归一化值
    const midX = pageW / 2;
    zones.sort((a, b) => {
      const ac = (a._minX + a._maxX) / 2 < midX ? 0 : 1;
      const bc = (b._minX + b._maxX) / 2 < midX ? 0 : 1;
      if (ac !== bc) return ac - bc;
      if (Math.abs(a._minY - b._minY) > 0.02) return a._minY - b._minY;
      return a._minX - b._minX;
    });
    for (const z of zones) {
      delete z._row; delete z._minX; delete z._maxX; delete z._minY; delete z._maxY;
    }
    return zones;
  }

  // ═══════════════════════════════════════════════════════════
  //  页码匹配
  // ═══════════════════════════════════════════════════════════
  async function pageRawItems(doc, n, cache) {
    let tc = cache.get('raw' + n);
    if (!tc) {
      const page = await doc.getPage(n);
      tc = await page.getTextContent();
      // v3.2.1 Fix: 坐标归一化（与 app.js detectPage/getPageItems 一致）——
      // pdf.js 原始 transform 在 PDF 用户空间，常规 PDF 左下原点（y 向上）、
      // 部分工具导出的 PDF 自带翻转（表现 y 向下）。统一经 viewport.transform
      // 变换后一律为 y 向下屏幕坐标（页顶=0），象限判断/页码采样按此语义。
      // Node 单测环境无 pdfjsLib：测试数据已按屏幕坐标语义构造，直接透传。
      const pdfjs = root.pdfjsLib;
      if (pdfjs && pdfjs.Util && typeof page.getViewport === 'function') {
        const vp = page.getViewport({ scale: 1 });
        tc.items = (tc.items || []).map(it => {
          if (!it.transform) return it;
          return {
            str: it.str,
            transform: pdfjs.Util.transform(vp.transform, it.transform),
            width: it.width,
            hasEOL: it.hasEOL,
            fontName: it.fontName || '',
            dir: it.dir || '',
          };
        });
      }
      cache.set('raw' + n, tc);
    }
    return tc.items;
  }
  async function pageNormText(doc, n, cache) {
    let text = cache.get('text' + n);
    if (text === undefined) {
      const items = await pageRawItems(doc, n, cache);
      text = normalizeText(items.map(i => i.str).join(' '));
      cache.set('text' + n, text);
    }
    return text;
  }

  // 获取页面尺寸（缓存），用于第二象限位置过滤
  async function pageDims(doc, n, cache) {
    let dims = cache.get('dims' + n);
    if (!dims) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      dims = { w: vp.width, h: vp.height };
      cache.set('dims' + n, dims);
    }
    return dims;
  }

  // 产品页"头部文本"（v3.2.0 Fix 3：排除 Q1 右上区域；v3.3.1 改为印刷页感知）：
  // 用户指出：产品页的产品名只出现在非右上区域（右页左半等），
  // Q1（印刷页右上）一旦出现文本即可能是扉页/目录右半页的页码噪声。
  // PDF坐标系 y 向下：Q1 = 印刷页的右上象限（isInQ1，支持横版对开）。
  async function pageHeadlineText(doc, n, cache) {
    let text = cache.get('head' + n);
    if (text === undefined) {
      const items = await pageRawItems(doc, n, cache);
      const dims = await pageDims(doc, n, cache);
      // 排除 Q1（印刷页右上象限）
      const notQ1 = items.filter(it => {
        if (!it.str || !it.transform) return false;
        const y = it.transform[5];
        return !isInQ1(it.transform[4], y, dims.w, dims.h);
      });
      text = normalizeText(notQ1.map(it => it.str).join(' '));
      cache.set('head' + n, text);
    }
    return text;
  }

  // 自动匹配专用标题区文本：沿用 pageHeadlineText 的非 Q1 区域，但移除
  // 插在产品标题词之间的纯页码（SUPER 46 SCOPE WASH → SUPERSCOPEWASH）。
  async function pageProductNameText(doc, n, cache) {
    let text = cache.get('productHead' + n);
    if (text === undefined) {
      const items = await pageRawItems(doc, n, cache);
      const dims = await pageDims(doc, n, cache);
      const productItems = items.filter(it => {
        if (!it.str || !it.transform) return false;
        if (/^\d{1,4}(?:\s*[/|]\s*\d{1,4})?$/.test(String(it.str).trim())) return false;
        return !isInQ1(it.transform[4], it.transform[5], dims.w, dims.h);
      });
      text = normalizeText(productItems.map(it => it.str).join(' '));
      cache.set('productHead' + n, text);
    }
    return text;
  }

  // 页眉页码映射：目录标注的页码是"印刷页码"（对开页），
  // 通过扫描每页页眉/页脚数字拟合 印刷 = k×物理 + c，把目录页码转成物理页
  // BUG FIX (B5): 原代码只扫 y < 60（当时按 y 向上理解 = 页脚底部）。
  // 本画册的印刷页码在页眉顶部（y 小，靠近 0），导致映射失效、目录页码被当作物理页，跳转错位 3-4 页。
  // 现在同时采样顶部与底部页码区域（y 向下：y < edge = 顶部页眉，y > h-edge = 底部页脚）。
  async function buildPageMap(doc, cache) {
    const samples = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const items = await pageRawItems(doc, n, cache);
      const dims = await pageDims(doc, n, cache);
      const edge = Math.max(60, dims.h * 0.08); // 页眉/页脚采样带：顶部 60pt~8%、底部 8%
      const nums = items.filter(it => {
        if (!it.str || !it.transform) return false;
        if (!/^\d{1,4}$/.test(it.str.trim())) return false;
        const y = it.transform[5];
        return y < edge || y > dims.h - edge; // 页眉（顶部 y 小）或页脚（底部 y 大）
      });
      if (!nums.length) continue;
      nums.sort((a, b) => a.transform[4] - b.transform[4]);
      samples.push({ print: parseInt(nums[0].str.trim(), 10), phys: n });
    }
    if (samples.length < 3) return null;
    const slopes = [];
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const dp = samples[j].print - samples[i].print;
        const dn = samples[j].phys - samples[i].phys;
        if (dn !== 0) slopes.push(dp / dn);
      }
    }
    slopes.sort((a, b) => a - b);
    const k = slopes[Math.floor(slopes.length / 2)];
    if (!(k > 0.1 && k <= 4)) return null;
    const cs = samples.map(s => s.print - k * s.phys).sort((a, b) => a - b);
    const c = cs[Math.floor(cs.length / 2)];
    const residualLimit = Math.max(1, Math.abs(k) * 0.2);
    const inliers = samples.filter(s => Math.abs(s.print - (k * s.phys + c)) <= residualLimit);
    if (inliers.length < 3 || inliers.length / samples.length < 0.65) return null;
    return { k, c, toPhys(print) { return Math.round((print - c) / k); } };
  }

  // 中位数
  function median(arr) {
    if (!arr.length) return 10;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  // v3.4：产品页标题候选提取。
  // 产品详情页/系列页的产品名标题特征（实测）：
  //   - 字号为区域内最大且统一（正文 6-8pt，标题 12-18pt；分类大标题可能更大但文本极短）
  //   - 文本短（≤60 字符），可跨两行
  // 实现：主正文字号 = 出现次数最多且 ≤ 最大字号/1.5 的字号簇（无正文簇时取最小字号）；
  //       标题阈值 = max(10, 正文×1.5, 最大字号×0.6)。
  //   纯标题页（如系列页仅 14/18 两档）→ 正文簇为空 → 阈值 = 最大字号×0.6，标题全部入选；
  //   详情页（正文 8 + FEATURES 12）→ 正文 8 簇 → 阈值 12，正文不进标题、FEATURES 进。
  async function pageTitleCandidates(doc, n, cache) {
    let candidates = cache.get('titleCandidates' + n);
    if (candidates === undefined) {
      const items = await pageRawItems(doc, n, cache);
      const dims = await pageDims(doc, n, cache);
      const sizes = items
        .filter(it => it.str && it.transform)
        .map(it => Math.hypot(it.transform[2], it.transform[3]) || 0)
        .filter(h => h > 2 && h < 100);
      let titleFs = 10;
      if (sizes.length) {
        const maxSize = Math.max(...sizes);
        const freq = {};
        for (const s of sizes) {
          const k = Math.round(s * 10) / 10;
          freq[k] = (freq[k] || 0) + 1;
        }
        // 主正文字号簇：出现最多且 ≤ 最大字号/1.5（大量小字 = 正文/规格）
        const bodyCands = Object.entries(freq)
          .filter(([s]) => parseFloat(s) <= maxSize / 1.5)
          .sort((a, b) => b[1] - a[1]);
        if (bodyCands.length) {
          titleFs = Math.max(10, parseFloat(bodyCands[0][0]) * 1.5, maxSize * 0.6);
        } else {
          titleFs = Math.max(10, maxSize * 0.6); // 纯标题页
        }
      }
      const lines = []; // [{y, fs, spans}]
      for (const it of items) {
        if (!it.str || !it.transform) continue;
        const fs = Math.hypot(it.transform[2], it.transform[3]) || 0;
        if (fs < titleFs) continue;               // 非标题字号
        const s = (it.str || '').trim();
        if (!s || s.length > 60) continue;        // 长文本是正文/规格，非标题
        const x = it.transform[4], y = it.transform[5];
        if (y < dims.h * 0.07) continue;          // 页眉噪声
        let line = null;
        for (const candidate of lines) {
          if (Math.abs(candidate.y - y) <= Math.max(candidate.fs, fs) * 0.6) { line = candidate; break; }
        }
        if (!line) { line = { y, fs, spans: [] }; lines.push(line); }
        line.y = (line.y * line.spans.length + y) / (line.spans.length + 1);
        line.fs = Math.max(line.fs, fs);
        line.spans.push({ s, x, fs, fontName: it.fontName || '' });
      }
      lines.sort((a, b) => (a.y - b.y) || ((a.spans[0]?.x || 0) - (b.spans[0]?.x || 0)));
      for (const line of lines) {
        line.spans.sort((a, b) => a.x - b.x);
        line.text = cleanName(line.spans.map(a => a.s).join(' '));
        line.norm = normalizeText(line.text);
        line.x = Math.min(...line.spans.map(a => a.x));
        line.x2 = Math.max(...line.spans.map(a => a.x + Math.max(a.fs, a.s.length * a.fs * 0.45)));
        line.bold = line.spans.some(a => /(BOLD|BLACK|HEAVY|SEMIBOLD|DEMI)/i.test(a.fontName));
        // 单页与对开页分别计算局部横坐标；位置只作为评分，不作为硬过滤。
        const spread = dims.w / dims.h > 1.3;
        const halfW = spread ? dims.w / 2 : dims.w;
        const localX = spread ? line.x % halfW : line.x;
        const localRatio = localX / Math.max(1, halfW);
        line.positionScore = localRatio >= 0.30 && localRatio <= 0.92 ? 1 : 0.55;
      }

      candidates = [];
      const addCandidate = (lineSet) => {
        const text = cleanName(lineSet.map(line => line.text).join(' '));
        const norm = normalizeText(text);
        if (!norm || norm.length < 2) return;
        const fontSize = Math.max(...lineSet.map(line => line.fs));
        const x = Math.min(...lineSet.map(line => line.x));
        const y = Math.min(...lineSet.map(line => line.y - line.fs));
        const x2 = Math.max(...lineSet.map(line => line.x2));
        const y2 = Math.max(...lineSet.map(line => line.y + line.fs * 0.25));
        const bold = lineSet.some(line => line.bold);
        const positionScore = Math.max(...lineSet.map(line => line.positionScore));
        const score = Math.min(1, 0.62 + (bold ? 0.18 : 0) + 0.12 * positionScore + (lineSet.length === 2 ? 0.08 : 0));
        if (!candidates.some(c => c.norm === norm && c.lineCount === lineSet.length)) {
          candidates.push({ text, norm, x, y, w: x2 - x, h: y2 - y, fontSize, bold, lineCount: lineSet.length, score, positionScore });
        }
      };

      for (let i = 0; i < lines.length; i++) {
        addCandidate([lines[i]]);
        const a = lines[i], b = lines[i + 1];
        if (!b) continue;
        const spread = dims.w / dims.h > 1.3;
        const halfW = spread ? dims.w / 2 : dims.w;
        const sameHalf = !spread || Math.floor(a.x / halfW) === Math.floor(b.x / halfW);
        const fsRatio = Math.max(a.fs, b.fs) / Math.max(1, Math.min(a.fs, b.fs));
        const yGap = b.y - a.y;
        const xAligned = Math.abs(a.x - b.x) <= Math.max(dims.w * 0.04, Math.max(a.fs, b.fs) * 2.2);
        if (sameHalf && fsRatio <= 1.25 && yGap > 0 && yGap <= Math.max(a.fs, b.fs) * 2.4 && xAligned) {
          // 两行先合并再整体 normalize，避免 "PEARLWASH MAX" 与 "PEARLWASHMAX" 不相等。
          addCandidate([a, b]);
        }
      }
      candidates.sort((a, b) => (b.score - a.score) || (b.fontSize - a.fontSize) || (a.y - b.y));
      cache.set('titleCandidates' + n, candidates);
    }
    return candidates;
  }

  // 兼容旧调用：返回所有候选的规范化文本。候选之间用空格分隔，但两行标题
  // 已在 pageTitleCandidates 内先合并后规范化，因此整串匹配不会再被换行打断。
  async function pageTitleBlocks(doc, n, cache) {
    let text = cache.get('title' + n);
    if (text === undefined) {
      const candidates = await pageTitleCandidates(doc, n, cache);
      text = candidates.map(c => c.norm).join(' ');
      cache.set('title' + n, text);
    }
    return text;
  }

  // v3.3.1：印刷页感知的"右上象限（Q1）"判断。
  // 本画册为横版对开页（宽 1191 ≈ 两个印刷页各 595），产品名标题常位于
  // **右页左半**（如 x=878 < 右页中线 893）——若按整页中线 595 判断会被误判为 Q1。
  // 规则：宽高比 > 1.3 视为对开，左页 Q1 = x ∈ [w/4, w/2] 且 y ≤ h/2；
  //       右页 Q1 = x ≥ 3w/4 且 y ≤ h/2；竖版单页 Q1 = x ≥ w/2 且 y ≤ h/2。
  function isInQ1(x, y, w, h) {
    if (y > h / 2) return false;                 // 下半象限不是 Q1
    if (w / h > 1.3) {
      if (x < w / 2) return x >= w / 4;          // 左印刷页右上
      return x > w * 3 / 4;                      // 右印刷页右上
    }
    return x > w / 2;                            // 竖版单页右上（中线本身仍属于标题区域）
  }

  // v3.3（用户思路第一轮）：候选页预筛——"第二象限（非右上）没有文字的页面"直接跳过。
  // 非 Q1 区域的非页码文本 ≥ 4 字符视为有产品内容（排除空白页/纯页码页/纯图页）。
  async function pageHasContent(doc, n, cache) {
    let has = cache.get('has' + n);
    if (has === undefined) {
      const titleCandidates = await pageTitleCandidates(doc, n, cache);
      if (titleCandidates.length) {
        cache.set('has' + n, true);
        return true;
      }
      const items = await pageRawItems(doc, n, cache);
      const dims = await pageDims(doc, n, cache);
      const notQ1 = items.filter(it => it.str && it.transform && !isInQ1(it.transform[4], it.transform[5], dims.w, dims.h));
      let len = 0;
      for (const it of notQ1) {
        const s = String(it.str || '').trim();
        if (!s || /^\d{1,4}(\/\d{1,4})?$/.test(s)) continue; // 纯页码不算内容
        len += s.length;
        if (len >= 8) break;
      }
      has = len >= 8;
      cache.set('has' + n, has);
    }
    return has;
  }

  // 名称 → 关键词列表（在原始名称上分词，保留 Ⅱ 等字符）
  function uniqueWords(rawName) {
    const set = new Set();
    for (const w of String(rawName || '').toUpperCase().split(/[^A-Z0-9]+/)) {
      if (w.length >= 2) set.add(w);
    }
    return [...set];
  }

  // 提取框选区域内的文本作为产品名（手动拉框后自动识别）
  // box: {x, y, w, h}（归一化 0-1，**屏幕坐标** top-left 向下），items: 该页文本块 [{str,x,y,w,h}]
  // v3.2.0 Fix 2: pdf.js 文本坐标 y 向下（页顶=0），与屏幕坐标同向，**无需翻转**。
  // BUG FIX (B4): 原代码按 y 向上做 (1-box.y)*pageH 翻转，框在屏幕顶部时提取到的却是页面底部文本。
  // 返回框内按阅读顺序（行 y → 列 x）拼接的文本
  function extractTextInBox(items, box, pageW, pageH) {
    const x0 = box.x * pageW, x1 = x0 + box.w * pageW;
    // 屏幕框 → PDF y 区间（同向下）：框顶 = box.y*pageH；框底 = (box.y+box.h)*pageH
    const pdfYTop = box.y * pageH;
    const pdfYBottom = (box.y + box.h) * pageH;
    const inside = [];
    for (const it of (items || [])) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const x = it.x || 0, y = it.y || 0;
      if (x >= x0 && x <= x1 && y >= pdfYTop && y <= pdfYBottom) inside.push({ str, x, y });
    }
    inside.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return cleanName(inside.map(it => it.str).join(' '));
  }

  // 为未设页码的框自动匹配跳转页（目录页之后逐页搜索产品名）
  // 两阶段：先全页整串包含（最可靠），无命中再关键词多数命中兜底
  // skipPages: 可选，物理页码(1-based)数组/Set，跳过这些页（目录跨页时防止误命中后续目录页）—— BUG FIX (B6)
  // 幂等（任务书 3.2）：只读取 printedPage 做映射、只填充没有 targetPage 的框；
  // 人工页码（targetSource='manual'）优先级最高，自动流程不得覆盖；连续执行结果不变。
  async function autoMatchTargets(doc, zones, fromPage, cache, onProgress, skipPages) {
    const skip = skipPages instanceof Set ? skipPages : new Set(skipPages || []);
    // ── 步骤 1：印刷页码 → 物理页 映射 ──
    // 只读 printedPage，只写 targetPage；已有 targetPage 的框（含人工指定）绝不再次转换。
    // 即使所有框都有 printedPage 也执行（不得提前返回跳过映射）。
    const needsPrintedMap = (zones || []).some(z => z && z.printedPage && !z.targetPage);
    const map = needsPrintedMap ? await buildPageMap(doc, cache) : null;
    if (map) {
      for (const z of zones) {
        if (z && z.printedPage && !z.targetPage) {
          const phys = map.toPhys(z.printedPage);
          if (phys >= 1 && phys <= doc.numPages) {
            z.targetPage = phys;
            z.targetSource = 'printed-map';
          }
        }
      }
    }
    // ── 步骤 2：文本匹配，只填充没有最终物理页的框 ──
    const pending = (zones || []).filter(z => !z.targetPage && z.name && normalizeText(z.name).length >= 2);
    if (!pending.length) return 0;
    // v3.4：先一次性建立页面描述器，再按“标题优先、全文仅作辅助”匹配。
    // 页面含多个同级产品标题时视为目录/系列总览，不能抢先成为单产品详情页。
    const normNames = [...new Set((zones || [])
      .filter(z => z && z.name && normalizeText(z.name).length >= 2)
      .map(z => normalizeText(z.name)))];

    const records = [];
    for (let n = fromPage + 1; n <= doc.numPages; n++) {
      if (skip.has(n)) continue;
      const fullText = await pageNormText(doc, n, cache);
      const headlineText = await pageProductNameText(doc, n, cache);
      const titles = await pageTitleCandidates(doc, n, cache);
      const hasContent = await pageHasContent(doc, n, cache);
      const keepLongestDistinct = hits => hits.filter(hit => !hits.some(other => other !== hit && other.includes(hit)));
      // SUPER SCOPE HYBRID 是 SUPER SCOPE HYBRID PRO 的真子串，不能因此把
      // 一个详情页误判成“同时出现两个产品”。只保留最长的独立命中。
      const fullHits = keepLongestDistinct(normNames.filter(nn => fullText.includes(nn)));
      const headlineHits = keepLongestDistinct(normNames.filter(nn => headlineText.includes(nn)));
      const titleHits = keepLongestDistinct(normNames.filter(nn => titles.some(t => t.norm === nn)));
      let pageType = 'detail';
      if (!hasContent || (!fullText && !titles.length)) pageType = 'blank';
      // 两个及以上已知产品名同时出现时，优先判作系列扉页/列表页。
      // 对文字转轮廓的详情页宁可留待印刷页码/OCR，也不能把列表页当作详情页。
      else if (titleHits.length >= 2 || headlineHits.length >= 2) pageType = 'overview';
      else if (fullHits.length >= 2) pageType = 'toc';
      records.push({ n, fullText, headlineText, titles, fullHits, headlineHits, titleHits, pageType, hasContent });
      if (n % 4 === 0 && typeof setTimeout === 'function') {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const usable = record => record.hasContent && record.pageType === 'detail';
    const wordScore = (text, words) => {
      let score = 0;
      for (const w of words) if (text.includes(w)) score++;
      return score;
    };
    let done = 0;
    for (const z of pending) {
      const norm = normalizeText(z.name);
      const words = uniqueWords(z.name);
      let found = 0;
      const orderedRecords = records;

      // 阶段 1：单一主标题精确命中（含先合并再规范化的两行标题）。
      let hit = orderedRecords.find(r => usable(r) && r.titleHits.length === 1 && r.titles.some(t => t.norm === norm && t.positionScore >= 0.9));
      if (hit) found = hit.n;

      // 阶段 1.5：固定中上标题区域的完整名称命中。该区域会过滤插入标题
      // 中间的纯页码，比整页关键词安全，也覆盖少数无法提取字号的 PDF。
      if (!found) {
        hit = orderedRecords.find(r => usable(r) && r.headlineHits.length === 1 && r.headlineText.includes(norm));
        if (hit) found = hit.n;
      }

      // 阶段 2：标题关键词高置信度匹配。全文不能在标题之前决定目标页。
      if (!found && words.length >= 2) {
        const need = Math.max(2, Math.ceil(words.length * 0.75));
        let best = null;
        for (const r of orderedRecords) {
          if (!usable(r)) continue;
          const score = Math.max(0, ...r.titles.map(t => wordScore(t.norm, words)));
          if (score >= need && (!best || score > best.score || (score === best.score && r.n < best.n))) best = { n: r.n, score };
        }
        if (best) found = best.n;
      }

      // 阶段 3：整页精确出现仅作辅助，且排除目录/系列总览页。
      if (!found) {
        hit = orderedRecords.find(r => usable(r) && r.fullHits.length === 1 && r.fullText.includes(norm));
        if (hit) found = hit.n;
      }

      // 不再用整页关键词做最终兜底。规格密集页会反复出现 WASH / SCOPE /
      // AQUA 等系列词，旧逻辑会把多个目录项集中指向同一个规格页（实测第52页）。
      // 没有标题或完整名称证据时宁可留空，交给自学习页码识别或人工确认。
      if (found) {
        z.targetPage = found;
        z.targetSource = 'text-match';
        z.confidence = Math.max(z.confidence || 0, 0.9);
      }
      done++;
      if (onProgress) onProgress(done, pending.length);
    }
    return pending.length;
  }

  const api = {
    normalizeText, cleanName, detectZonesFromItems, autoMatchTargets, buildPageMap,
    extractTextInBox, createZoneId, normalizeZone, pageHeadlineText, pageRawItems,
    pageTitleCandidates, pageTitleBlocks, pageHasContent, pageProductNameText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Detect = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
