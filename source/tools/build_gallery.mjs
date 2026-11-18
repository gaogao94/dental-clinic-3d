#!/usr/bin/env node
// Build the offline, self-contained dental gallery page.
//
//   node dental/tools/build_gallery.mjs [--title "..."]
//
// Outputs:
//   dental/delivery/gallery.html        (data inlined, no CDN)
//   dental/delivery/lib/                (three.js runtime + GLTFLoader/OrbitControls/RoomEnvironment)
//   dental/delivery/thumbs/<id>.png     (copied from dental/preview/thumbs)
//   dental/delivery/打开预览.cmd          (starts local static server + opens the page)
//
// The grid is plain JS so it also renders when gallery.html is opened directly from disk;
// the 3D viewer is an ES module and needs the local server (打开预览.cmd).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyThreeRuntime } from './three_bundle.mjs';
import { repoRootFromTools, loadItems, priorityRank } from './object_data.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = repoRootFromTools();
const DENTAL = path.join(REPO_ROOT, 'dental');
const DELIVERY = path.join(DENTAL, 'delivery');

function parseArgs(argv) {
  const args = { title: '牙科诊所 3D 物件库', includeTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--title') args.title = String(argv[++i] || args.title);
    else if (a === '--include-test') args.includeTest = true;
    else if (a === '--help' || a === '-h') {
      console.log('build_gallery.mjs — 生成离线 gallery.html\n'
        + '  --title 标题（默认：牙科诊所 3D 物件库）\n'
        + '  --include-test 把 dental/models/_test-smoke 的测试物件算进来');
      process.exit(0);
    } else throw new Error('unknown arg: ' + a);
  }
  return args;
}

function displayPriority(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return 'P' + text;
  return text;
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{
  --bg:#f6f7f9; --panel:#ffffff; --ink:#1b2430; --muted:#7a8698; --line:#e4e8ee;
  --accent:#2f6fed; --radius:14px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:20;background:rgba(246,247,249,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.head-inner{max-width:1440px;margin:0 auto;padding:18px 28px 10px;display:flex;align-items:center;gap:18px}
h1{font-size:20px;font-weight:600;margin:0;letter-spacing:.5px;white-space:nowrap}
.count{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.count b{color:var(--ink);font-weight:600;font-size:15px}
.search{margin-left:auto;position:relative}
.search input{width:260px;height:36px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:0 14px 0 36px;font-size:13px;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(47,111,237,.12)}
.search svg{position:absolute;left:12px;top:10px;width:16px;height:16px;stroke:var(--muted);fill:none;stroke-width:2}
.filters{max-width:1440px;margin:0 auto;padding:2px 28px 12px;display:flex;flex-wrap:wrap;gap:8px 26px;align-items:center}
.fgroup{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.flabel{font-size:12px;color:var(--muted);margin-right:2px}
.chip{border:1px solid var(--line);background:#fff;color:#46536a;font-size:12.5px;line-height:1;padding:7px 12px;border-radius:999px;cursor:pointer;transition:all .14s;white-space:nowrap}
.chip:hover{border-color:#c3cdda;color:var(--ink)}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff}
main{max-width:1440px;margin:0 auto;padding:8px 28px 72px}
.group{margin-top:26px}
.group h2{font-size:15px;font-weight:600;margin:0 0 12px;display:flex;align-items:baseline;gap:8px}
.group h2 span{font-size:12px;color:var(--muted);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:transform .16s,box-shadow .16s,border-color .16s;position:relative}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(24,38,60,.10);border-color:#d3dae5}
.card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.thumb{position:relative;aspect-ratio:1/1;background:linear-gradient(160deg,#eef1f5,#e3e8ef);overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;position:relative;z-index:1}
.thumb .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:38px;color:#b4bfcd;font-weight:600}
.meta{padding:10px 12px 12px;display:flex;align-items:flex-start;gap:8px}
.names{min-width:0;flex:1}
.zh{font-size:13.5px;font-weight:600;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.en{font-size:11.5px;color:var(--muted);line-height:1.4;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pri{flex:none;font-size:10.5px;line-height:1;padding:4px 7px;border-radius:6px;font-weight:600;letter-spacing:.3px;background:#eef1f5;color:#62708a}
.pri.r0{background:#fdecec;color:#c92a2a}
.pri.r1{background:#fff4e0;color:#a35b00}
.pri.r2{background:#e7f6ec;color:#2b7a3d}
.empty{padding:80px 0;text-align:center;color:var(--muted);font-size:14px}
.modal{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;background:rgba(16,24,36,.5);backdrop-filter:blur(4px);padding:3vh 3vw}
.modal.open{display:flex}
.panel{width:min(1080px,94vw);height:min(780px,92vh);background:#f2f4f7;border-radius:18px;box-shadow:0 30px 90px rgba(10,20,35,.35);display:flex;flex-direction:column;overflow:hidden;position:relative}
.mhead{display:flex;align-items:center;gap:14px;padding:16px 20px;background:#fff;border-bottom:1px solid var(--line);z-index:2}
.mnames{min-width:0}
.mzh{font-size:17px;font-weight:600;line-height:1.3}
.men{font-size:12.5px;color:var(--muted);margin-top:2px}
.mtags{margin-left:auto;display:flex;align-items:center;gap:8px}
.tag{font-size:11.5px;color:#5a6779;background:#f0f3f7;border-radius:7px;padding:5px 9px;line-height:1}
.close{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:#fff;color:#4a576b;font-size:19px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
.close:hover{background:#f2f4f7;color:var(--ink)}
.viewer{flex:1;position:relative;background:radial-gradient(circle at 50% 42%,#f7f9fb 0%,#e8edf3 70%,#e0e6ee 100%)}
.viewer canvas{display:block;width:100%;height:100%}
.vstate{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#69768a;font-size:13px;pointer-events:none;text-align:center;padding:24px}
.vstate.show{display:flex}
.spinner{position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:2px solid #d5dde7;border-top-color:var(--accent);animation:spin .8s linear infinite;display:none}
.spinner.show{display:block}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
<script type="importmap">{"imports":{"three":"./lib/three.module.js","three/addons/":"./lib/addons/"}}</script>
</head>
<body>
<header>
  <div class="head-inner">
    <h1>__TITLE__</h1>
    <div class="count"><b id="shown">0</b> / <span id="total">0</span> 件</div>
    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
      <input id="q" type="search" placeholder="搜索" autocomplete="off" spellcheck="false">
    </div>
  </div>
  <div class="filters" id="filters">
    <div class="fgroup" id="catGroup"><span class="flabel">分类</span></div>
    <div class="fgroup" id="priGroup"><span class="flabel">优先级</span></div>
  </div>
</header>
<main id="main"></main>

<div class="modal" id="modal">
  <div class="panel" role="dialog" aria-modal="true">
    <div class="mhead">
      <div class="mnames"><div class="mzh" id="mZh"></div><div class="men" id="mEn"></div></div>
      <div class="mtags"><span class="tag" id="mCat"></span><span class="tag" id="mRoom"></span><span class="tag" id="mPri"></span><button class="close" id="mClose" aria-label="关闭">×</button></div>
    </div>
    <div class="viewer" id="viewer">
      <div class="spinner" id="spinner"></div>
      <div class="vstate" id="vstate"></div>
    </div>
  </div>
</div>

<script>
window.__GALLERY__ = __DATA_JSON__;
(function () {
  var G = window.__GALLERY__;
  var state = { q: '', cat: '', pri: '' };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function priRank(p) {
    var k = String(p || '').trim().toLowerCase();
    var map = { p0: 0, p1: 1, p2: 2, p3: 3, urgent: 0, high: 0, normal: 1, medium: 1, low: 2, '高': 0, '中': 1, '低': 2, '紧急': 0 };
    if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
    var m = /^p(\\d+)$/.exec(k);
    if (m) return Number(m[1]);
    return 9;
  }
  function buildFilters() {
    var catGroup = $('catGroup');
    var cats = [{ name: '全部', value: '' }].concat(G.categories.map(function (c) { return { name: c.name, value: c.name }; }));
    cats.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'chip' + (c.value === '' ? ' on' : '');
      b.textContent = c.name;
      b.dataset.cat = c.value;
      b.addEventListener('click', function () {
        state.cat = c.value;
        Array.prototype.forEach.call(catGroup.querySelectorAll('.chip'), function (el) { el.classList.toggle('on', el.dataset.cat === state.cat); });
        render();
      });
      catGroup.appendChild(b);
    });
    var priGroup = $('priGroup');
    var pris = [{ name: '全部', value: '' }].concat(G.priorities.map(function (p) { return { name: p, value: p }; }));
    pris.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'chip' + (p.value === '' ? ' on' : '');
      b.textContent = p.name;
      b.dataset.pri = p.value;
      b.addEventListener('click', function () {
        state.pri = p.value;
        Array.prototype.forEach.call(priGroup.querySelectorAll('.chip'), function (el) { el.classList.toggle('on', el.dataset.pri === state.pri); });
        render();
      });
      priGroup.appendChild(b);
    });
  }
  function matches(it) {
    if (state.cat && it.category !== state.cat) return false;
    if (state.pri && it.priority !== state.pri) return false;
    if (state.q) {
      var q = state.q.toLowerCase();
      var hay = (it.zh + ' ' + it.en + ' ' + it.id + ' ' + it.category + ' ' + it.room).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function makeCard(it) {
    var el = document.createElement('article');
    el.className = 'card';
    el.tabIndex = 0;
    el.dataset.id = it.id;
    var img = it.thumb ? '<img loading="lazy" src="' + esc(it.thumb) + '" alt="" onerror="this.remove()">' : '';
    el.innerHTML = '<div class="thumb"><span class="ph">' + esc((it.zh || it.id).slice(0, 1)) + '</span>' + img + '</div>'
      + '<div class="meta"><div class="names"><div class="zh">' + esc(it.zh) + '</div><div class="en">' + esc(it.en) + '</div></div>'
      + (it.priority ? '<span class="pri r' + priRank(it.priority) + '">' + esc(it.priority) + '</span>' : '')
      + '</div>';
    el.addEventListener('click', function () { openModal(it); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(it); } });
    return el;
  }
  function render() {
    var main = $('main');
    main.innerHTML = '';
    var shown = 0;
    var groups = [];
    var byCat = new Map();
    G.items.forEach(function (it) {
      if (!matches(it)) return;
      shown += 1;
      if (!byCat.has(it.category)) { byCat.set(it.category, []); groups.push(it.category); }
      byCat.get(it.category).push(it);
    });
    if (!shown) {
      var d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '无匹配物件';
      main.appendChild(d);
    }
    groups.forEach(function (cat) {
      var list = byCat.get(cat);
      var sec = document.createElement('section');
      sec.className = 'group';
      var h = document.createElement('h2');
      h.textContent = cat;
      var n = document.createElement('span');
      n.textContent = list.length + ' 件';
      h.appendChild(n);
      sec.appendChild(h);
      var grid = document.createElement('div');
      grid.className = 'grid';
      list.forEach(function (it) { grid.appendChild(makeCard(it)); });
      sec.appendChild(grid);
      main.appendChild(sec);
    });
    $('shown').textContent = String(shown);
    window.__shown = shown;
  }

  // ---- modal shell (3D content is provided by the module viewer when available) ----
  function setState(msg) {
    var vs = $('vstate');
    if (msg) { vs.textContent = msg; vs.classList.add('show'); }
    else { vs.classList.remove('show'); vs.textContent = ''; }
  }
  function openModal(it) {
    $('modal').classList.add('open');
    document.body.style.overflow = 'hidden';
    $('mZh').textContent = it.zh;
    $('mEn').textContent = it.en;
    $('mCat').textContent = it.category;
    $('mRoom').textContent = it.room || '';
    $('mRoom').style.display = it.room ? '' : 'none';
    $('mPri').textContent = it.priority || '—';
    $('spinner').classList.add('show');
    setState(null);
    window.__viewerReady = false;
    window.__viewerError = null;
    if (typeof window.__viewerOpen === 'function') {
      try { window.__viewerOpen(it); } catch (e) { fail('加载失败'); }
    } else {
      setTimeout(function () {
        if (typeof window.__viewerOpen !== 'function') fail('3D 预览需通过 打开预览.cmd 打开');
      }, 400);
    }
  }
  function fail(msg) {
    $('spinner').classList.remove('show');
    setState(msg);
    window.__viewerError = msg;
  }
  function closeModal() {
    $('modal').classList.remove('open');
    document.body.style.overflow = '';
    $('spinner').classList.remove('show');
    setState(null);
    window.__viewerReady = false;
    if (typeof window.__viewerClose === 'function') window.__viewerClose();
  }
  $('mClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('modal').classList.contains('open')) closeModal();
  });
  var searchTimer = 0;
  $('q').addEventListener('input', function (e) {
    clearTimeout(searchTimer);
    var v = e.target.value;
    searchTimer = setTimeout(function () { state.q = v.trim(); render(); }, 120);
  });

  buildFilters();
  $('total').textContent = String(G.items.length);
  render();
  window.__openFirst = function () {
    var c = document.querySelector('.card');
    if (!c) return false;
    c.click();
    return true;
  };
  window.__galleryShell = { fail: fail };
  var imgs = Array.prototype.slice.call(document.images);
  Promise.all(imgs.map(function (img) {
    return img.complete ? Promise.resolve() : new Promise(function (r) { img.onload = r; img.onerror = r; });
  })).then(function () { window.__galleryReady = true; }, function () { window.__galleryReady = true; });
})();
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

var itemById = new Map(window.__GALLERY__.items.map(function (it) { return [it.id, it]; }));
var view = null;

function fail(msg) {
  var sp = document.getElementById('spinner');
  if (sp) sp.classList.remove('show');
  var vs = document.getElementById('vstate');
  if (vs) { vs.textContent = msg; vs.classList.add('show'); }
  window.__viewerError = msg;
}

function createView(container) {
  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0xeef1f5, 1);
  container.appendChild(renderer.domElement);
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef1f5);
  try {
    var pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
  } catch (e) { /* optional */ }
  scene.add(new THREE.HemisphereLight(0xffffff, 0xccd4df, 1.5));
  var key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(4, 7, 6);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.65);
  fill.position.set(-5, 3, -4);
  scene.add(fill);
  var camera = new THREE.PerspectiveCamera(38, 1, 0.001, 100000);
  var controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 0.9;
  controls.rotateSpeed = 0.85;
  var loader = new GLTFLoader();
  var obj = null;
  var disposed = false;
  var raf = 0;
  var v = {
    resize: function () {
      var w = container.clientWidth || 800;
      var h = container.clientHeight || 600;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    frame: function (root) {
      var box = new THREE.Box3().setFromObject(root);
      var sphere = box.getBoundingSphere(new THREE.Sphere());
      if (!isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('empty bounds');
      var fov = THREE.MathUtils.degToRad(camera.fov);
      var dist = (sphere.radius / Math.sin(fov / 2)) * 1.18;
      var dir = new THREE.Vector3(0.82, 0.62, 1.0).normalize();
      var target = sphere.center.clone();
      camera.position.copy(target).addScaledVector(dir, dist);
      camera.near = Math.max(dist / 2000, 0.0001);
      camera.far = dist * 2000;
      camera.updateProjectionMatrix();
      controls.target.copy(target);
      controls.minDistance = dist * 0.05;
      controls.maxDistance = dist * 14;
      controls.update();
    },
    load: function (it) {
      loader.load(it.model, function (gltf) {
        if (disposed) return;
        if (obj) scene.remove(obj);
        obj = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!obj) { fail('模型无场景'); return; }
        scene.add(obj);
        try { v.frame(obj); } catch (e) { fail('模型无法取景'); return; }
        var sp = document.getElementById('spinner');
        if (sp) sp.classList.remove('show');
        renderer.render(scene, camera);
        window.__viewerReady = true;
      }, undefined, function () {
        if (!disposed) fail('加载失败' + (location.protocol === 'file:' ? ' · 请用 打开预览.cmd' : ''));
      });
    },
    tick: function () {
      if (disposed) return;
      raf = requestAnimationFrame(function () { v.tick(); });
      controls.update();
      renderer.render(scene, camera);
    },
    destroy: function () {
      disposed = true;
      cancelAnimationFrame(raf);
      if (obj) {
        obj.traverse(function (n) {
          if (n.geometry) n.geometry.dispose();
          var mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
          mats.forEach(function (m) {
            Object.keys(m).forEach(function (k) { var val = m[k]; if (val && val.isTexture) val.dispose(); });
            m.dispose();
          });
        });
      }
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
  new ResizeObserver(function () { v.resize(); }).observe(container);
  v.resize();
  v.tick();
  return v;
}

window.__viewerOpen = function (it) {
  if (view) { view.destroy(); view = null; }
  var container = document.getElementById('viewer');
  view = createView(container);
  view.load(it);
};
window.__viewerClose = function () {
  if (view) { view.destroy(); view = null; }
  window.__viewerReady = false;
};
window.__viewerModuleReady = true;
</script>
</body>
</html>
`;

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadItems({ repoRoot: REPO_ROOT, includeTest: args.includeTest });
  const items = loaded.items.filter((it) => it.modelExists);

  fs.mkdirSync(DELIVERY, { recursive: true });
  fs.mkdirSync(path.join(DELIVERY, 'thumbs'), { recursive: true });

  const libInfo = copyThreeRuntime(REPO_ROOT, path.join(DELIVERY, 'lib'));

  let thumbsCopied = 0;
  let missingThumbs = 0;
  const galleryItems = [];
  for (const it of items) {
    let thumb = null;
    if (it.thumbExists) {
      fs.copyFileSync(it.thumbFile, path.join(DELIVERY, 'thumbs', it.id + '.png'));
      thumb = 'thumbs/' + encodeURIComponent(it.id) + '.png';
      thumbsCopied += 1;
    } else {
      missingThumbs += 1;
    }
    galleryItems.push({
      id: it.id,
      zh: it.zh,
      en: it.en,
      category: it.category,
      room: it.room,
      priority: displayPriority(it.priority),
      model: '../models/' + encodeURIComponent(it.id) + '/model.glb',
      thumb,
    });
  }

  const categories = [];
  for (const it of galleryItems) {
    const found = categories.find((c) => c.name === it.category);
    if (found) found.count += 1;
    else categories.push({ name: it.category, count: 1 });
  }
  // 未分类 always last
  const uncategorized = categories.findIndex((c) => c.name === '未分类');
  if (uncategorized >= 0) categories.push(categories.splice(uncategorized, 1)[0]);
  const priSet = [...new Set(galleryItems.map((i) => i.priority).filter(Boolean))];
  priSet.sort((a, b) => priorityRank(a) - priorityRank(b) || String(a).localeCompare(String(b), 'zh-CN'));

  const data = {
    schema: 'dental-clinic-gallery/v1',
    title: args.title,
    generatedAt: new Date().toISOString(),
    categories,
    priorities: priSet,
    items: galleryItems,
  };

  const titleHtml = String(args.title).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const html = PAGE
    .replace(/__TITLE__/g, () => titleHtml)
    .replace('__DATA_JSON__', () => jsonForScript(data));
  fs.writeFileSync(path.join(DELIVERY, 'gallery.html'), html, 'utf8');

  const cmd = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0.."',
    'start "" node tools\\serve_preview.mjs',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(DELIVERY, '打开预览.cmd'), cmd, 'utf8');

  console.log('[gallery] 物件 ' + galleryItems.length + ' 件，分类 ' + categories.length + ' 个，缩略图 ' + thumbsCopied + ' 张'
    + (missingThumbs ? '，缺缩略图 ' + missingThumbs + ' 件' : ''));
  console.log('[gallery] three.js lib: ' + path.relative(REPO_ROOT, path.join(DELIVERY, 'lib')).replace(/\\/g, '/') + '（' + libInfo.files + ' 个文件）');
  console.log('[gallery] 页面: ' + path.relative(REPO_ROOT, path.join(DELIVERY, 'gallery.html')).replace(/\\/g, '/'));
  if (!galleryItems.length) {
    console.warn('[gallery] 警告：当前没有可用模型，页面为空占位；数据就绪后重跑本命令。');
  }
}

try {
  main();
} catch (err) {
  console.error('[gallery] 失败: ' + (err && err.stack || err));
  process.exitCode = 1;
}
