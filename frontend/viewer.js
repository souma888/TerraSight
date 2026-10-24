import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js';

let activeJobId = null;
let sceneState = null;

const endpoint = (suffix = '') => `/api/reconstructions/${encodeURIComponent(activeJobId)}${suffix}`;
const get = async (suffix) => {
  const response = await fetch(endpoint(suffix), { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || 'The local processing worker did not respond.');
  return body;
};

function createPanel() {
  let panel = document.querySelector('#postprocess-panel');
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = 'postprocess-panel';
  panel.className = 'postprocess-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="section-heading"><p class="eyebrow">LOCAL ANALYSIS · OPTIONAL STAGES</p><h2>Inspect geometry and trained masks</h2><p id="postprocess-capability">Checking local analysis tools…</p></div>
    <div class="postprocess-actions">
      <button class="button button-secondary" id="run-geometry" type="button">Analyse point cloud</button>
      <button class="button button-outline" id="run-segmentation" type="button">Run trained segmentation</button>
    </div>
    <p class="postprocess-status" id="postprocess-status" role="status"></p>
    <div class="geometry-summary" id="geometry-summary"></div>
    <div class="point-cloud-viewer" id="point-cloud-viewer" hidden><div class="viewer-head"><span>INTERACTIVE POINT CLOUD</span><small>Drag to orbit · scroll to zoom</small></div><div id="three-canvas" aria-label="Interactive point-cloud viewer"></div></div>
    <div class="segmentation-results" id="segmentation-results"></div>`;
  document.querySelector('#reconstruction-output').append(panel);
  panel.querySelector('#run-geometry').addEventListener('click', () => startStage('/geometry', 'geometry'));
  panel.querySelector('#run-segmentation').addEventListener('click', () => startStage('/segmentation', 'segmentation'));
  return panel;
}

function setStatus(text) { document.querySelector('#postprocess-status').textContent = text; }

function formatExtent(values) { return values.map((value) => Number(value).toFixed(3)).join(' × '); }

function renderGeometry(report) {
  const target = document.querySelector('#geometry-summary');
  if (!report) { target.replaceChildren(); return; }
  target.innerHTML = `<article><small>FILTERED POINTS</small><strong>${Number(report.filtered_points).toLocaleString()}</strong></article><article><small>BOUNDING EXTENT</small><strong>${formatExtent(report.axis_extent)}</strong><span>Model units${report.coordinate_frame.includes('metric if') ? ' · metric only after scale validation' : ''}</span></article><article><small>VIEWER SAMPLE</small><strong>${Number(report.viewer_points).toLocaleString()}</strong></article>`;
}

function renderSegmentation(report) {
  const target = document.querySelector('#segmentation-results');
  if (!report) { target.replaceChildren(); return; }
  const metrics = report.checkpoint_metrics || {};
  const cards = report.views.map((view) => `<a href="${endpoint('/segmentation/' + encodeURIComponent(view.overlay))}" target="_blank" rel="noopener"><img src="${endpoint('/segmentation/' + encodeURIComponent(view.overlay))}" alt="${view.image} predicted overlay"><span>${view.image} · ${(view.target_fraction * 100).toFixed(1)}% ${report.class_name}</span></a>`).join('');
  target.innerHTML = `<div class="segmentation-head"><strong>${report.class_name} masks</strong><span>Validation IoU: ${metrics.validation_iou == null ? 'not recorded' : Number(metrics.validation_iou).toFixed(3)} · F1: ${metrics.validation_f1 == null ? 'not recorded' : Number(metrics.validation_f1).toFixed(3)}</span><a class="button button-outline" href="${endpoint('/artifacts/segmentation-report.json')}">Download report</a></div><div class="segmentation-grid">${cards}</div><p class="model-limit">${report.limitations.join(' ')}</p>`;
}

function disposeScene() {
  if (!sceneState) return;
  cancelAnimationFrame(sceneState.frame);
  sceneState.observer.disconnect();
  sceneState.renderer.dispose();
  sceneState.canvas.replaceChildren();
  sceneState = null;
}

function renderPointCloud(data) {
  const shell = document.querySelector('#point-cloud-viewer');
  const canvas = document.querySelector('#three-canvas');
  shell.hidden = false;
  disposeScene();
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0e1512);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 1e8);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  canvas.append(renderer.domElement);
  const positions = new Float32Array(data.positions);
  const colors = new Uint8Array(data.colors);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geometry.computeBoundingBox(); geometry.center(); geometry.computeBoundingSphere();
  scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1.8, sizeAttenuation: true, vertexColors: true })));
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  const radius = Math.max(geometry.boundingSphere?.radius || 1, 0.01);
  camera.position.set(radius * 1.7, radius * 1.15, radius * 1.7); controls.update();
  const resize = () => { const width = Math.max(canvas.clientWidth, 1); const height = Math.max(canvas.clientHeight, 280); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); };
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  const draw = () => { if (!sceneState) return; controls.update(); renderer.render(scene, camera); sceneState.frame = requestAnimationFrame(draw); };
  sceneState = { renderer, canvas, observer, frame: requestAnimationFrame(draw) };
}

async function poll(stage) {
  for (;;) {
    const state = await get(`/${stage}`);
    if (state.status === 'completed') return state.report;
    if (state.status === 'failed') throw new Error(state.error || `${stage} failed.`);
    setStatus(state.stage || `${stage} is running locally…`);
    await new Promise((resolve) => setTimeout(resolve, 1600));
  }
}

async function startStage(path, stage) {
  try {
    const response = await fetch(endpoint(path), { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `${stage} could not start.`);
    setStatus(body.stage || `${stage} queued…`);
    const report = await poll(stage);
    if (stage === 'geometry') {
      renderGeometry(report);
      const cloud = await get('/artifacts/viewer-point-cloud.json');
      renderPointCloud(cloud);
    } else renderSegmentation(report);
    setStatus(`${stage === 'geometry' ? 'Point-cloud analysis' : 'Segmentation'} complete.`);
  } catch (error) { setStatus(error.message || 'Processing failed.'); }
}

async function configure(jobId) {
  activeJobId = jobId;
  const panel = createPanel(); panel.hidden = false;
  const geometryButton = panel.querySelector('#run-geometry');
  const segmentationButton = panel.querySelector('#run-segmentation');
  try {
    const [capabilities, job] = await Promise.all([
      fetch('/api/reconstructions/postprocess/capabilities').then((response) => response.json()),
      get(''),
    ]);
    geometryButton.disabled = !capabilities.geometry?.available;
    segmentationButton.disabled = !capabilities.segmentation?.available;
    panel.querySelector('#postprocess-capability').textContent = capabilities.reason || 'Local processing capabilities checked.';
    if (!capabilities.geometry?.available) geometryButton.title = capabilities.geometry?.reason || '';
    if (!capabilities.segmentation?.available) segmentationButton.title = capabilities.segmentation?.reason || '';
    if (job.geometry?.status === 'completed') {
      renderGeometry(job.geometry.report);
      const cloud = await get('/artifacts/viewer-point-cloud.json'); renderPointCloud(cloud);
    }
    if (job.segmentation?.status === 'completed') renderSegmentation(job.segmentation.report);
  } catch (error) { setStatus(error.message || 'Could not load analysis state.'); }
}

window.addEventListener('terrasight:reconstruction-ready', (event) => configure(event.detail.jobId));
