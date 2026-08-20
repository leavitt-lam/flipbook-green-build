import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

test('生成器位于工程根目录且版本一致', () => {
  const html = read('index.html');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '3.7.0');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /FLIPBOOK_FORGE v3\.7\.0/);
  assert.match(html, /<script src="libs\/jszip\.min\.js"><\/script>/);
  assert.match(html, /<script src="detect\.js"><\/script>/);
  assert.match(html, /<script src="app\.js"><\/script>/);
});

test('根目录构建产物与 src 保持同步', () => {
  assert.equal(read('app.js'), read('src/app.js'));
  assert.equal(read('detect.js'), read('src/detect.js'));
});

test('转换器 DOM ID 唯一且 app.js 没有悬空 ID 引用', () => {
  const html = read('src/converter.html');
  const app = read('src/app.js');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const refs = [...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'converter.html 不得出现重复 ID');
  assert.deepEqual([...new Set(refs.filter(id => !ids.includes(id)))], []);
});

test('构建产物没有源码占位符泄漏', () => {
  const html = read('index.html');
  assert.ok(!html.includes('const VIEWER_TEMPLATE = __VIEWER_TEMPLATE_JSON__'));
  assert.ok(!html.includes('const LIBS_PDFJS = __LIBS_PDFJS__'));
  assert.ok(!html.includes('const LIBS_WORKER = __LIBS_WORKER__'));
  assert.ok(!html.includes('<!--__CONV_LIBS__-->'));
});

test('v3.7 查看器包含横版缩略图、兼容页缩略图、三档缩放和自适应清晰度', () => {
  const viewer = read('src/viewer.template.html');
  const converter = read('src/converter.html');
  assert.match(viewer, /id="zoom-reset"/);
  assert.match(viewer, /ZOOM_LEVELS = \[1\.5, 2, 3\]/);
  assert.match(viewer, /mousePanning/);
  assert.match(viewer, /canvas\.dataset\.renderer = 'compat'/);
  assert.match(viewer, /--thumb-aspect/);
  assert.match(converter, /\.bar \{[^}]*overflow: hidden/);
  assert.match(viewer, /renderProfile = FLIPBOOK\.renderQuality/);
  assert.match(converter, /id="opt-render-quality"/);
  assert.match(converter, /id="android-download-btn"/);
});
