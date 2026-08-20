/**
 * buildPageMap 印刷页码映射测试（任务书 7.2）
 * 运行：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/detect.js';

const Detect = globalThis.Detect;

function makeDoc(numPages, pageNumBuilder) {
  return {
    numPages,
    async getPage(n) {
      const items = [
        { str: 'CONTENT', transform: [1, 0, 0, 1, 100, 400] },
        ...pageNumBuilder(n),
      ];
      return { getViewport: () => ({ width: 800, height: 842 }), getTextContent: () => ({ items }) };
    },
  };
}

test('页眉印刷页码 101~106 → 拟合 k=1,c=100，103→物理3', async () => {
  const doc = makeDoc(6, n => [{ str: String(100 + n), transform: [1, 0, 0, 1, 35, 35] }]);
  const map = await Detect.buildPageMap(doc, new Map());
  assert.ok(map, '应建立映射（页眉页码在顶部 y≈35，y 向下）');
  assert.equal(map.toPhys(103), 3);
  assert.equal(map.toPhys(106), 6);
});

test('对开页印刷页码（每物理页+2）→ k=2，印刷46→物理25', async () => {
  // 物理页 n → 印刷 2n+32（模拟 34/35 → 36/37 ... 46/47 对应物理 7 的场景：2*7+32=46）
  const doc = makeDoc(10, n => [{ str: String(2 * n + 32), transform: [1, 0, 0, 1, 35, 35] }]);
  const map = await Detect.buildPageMap(doc, new Map());
  assert.ok(map);
  assert.ok(Math.abs(map.k - 2) < 0.01, '斜率应为 2');
  assert.equal(map.toPhys(46), 7, '印刷 46 → 物理 7');
});

test('页码在页脚（底部）也能采样', async () => {
  const doc = makeDoc(5, n => [{ str: String(100 + n), transform: [1, 0, 0, 1, 35, 812] }]);
  const map = await Detect.buildPageMap(doc, new Map());
  assert.ok(map, '页脚页码（y>h-edge，y 向下）应被采样');
  assert.equal(map.toPhys(103), 3);
});

test('无稳定页码关系时返回 null（不猜测）', async () => {
  // 页码随机变化 → 斜率不一致 → 返回 null，绝不猜测
  const doc = makeDoc(6, n => [{ str: String((n * 7) % 100 + 1), transform: [1, 0, 0, 1, 35, 35] }]);
  const map = await Detect.buildPageMap(doc, new Map());
  assert.ok(map === null, '应返回 null');
});
