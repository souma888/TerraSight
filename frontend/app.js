(() => {
  'use strict';

  const MIN_PHOTOS = 5;
  const TARGET_OVERLAP = 70;
  const SAMPLE_W = 48;
  const SAMPLE_H = 32;
  const photos = [];
  const video = document.querySelector('#camera-video');
  const canvas = document.querySelector('#capture-canvas');
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = SAMPLE_W;
  sampleCanvas.height = SAMPLE_H;
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
  const streamButton = document.querySelector('#start-camera');
  const captureButton = document.querySelector('#take-photo');
  const flipButton = document.querySelector('#flip-camera');
  const cameraFrame = document.querySelector('#camera-frame');
  const placeholder = document.querySelector('#camera-placeholder');
  const cameraError = document.querySelector('#camera-error');
  const fileInput = document.querySelector('#file-input');
  const dropzone = document.querySelector('#dropzone');
  const thumbnailGrid = document.querySelector('#thumbnail-grid');
  const toast = document.querySelector('#toast');
  let stream = null;
  let facingMode = 'environment';
  let overlapTimer = null;
  let overlapBusy = false;
  let facingHeading = null;
  let orientationEnabled = false;
  let toastTimer = null;
  let qualityReviewed = false;
  let sessionId = null;
  let latestAnalysis = null;

  const $ = (selector) => document.querySelector(selector);

  async function checkApi() {
    const pill = $('.api-pill');
    try {
      const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('API unavailable');
      const result = await response.json();
      $('#api-status').textContent = result.status === 'ok' ? 'API connected' : 'API status unknown';
      pill.classList.toggle('is-online', result.status === 'ok');
      pill.classList.toggle('is-offline', result.status !== 'ok');
    } catch {
      $('#api-status').textContent = 'API unavailable';
      pill.classList.add('is-offline');
    }
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
  }

  const viewTitles = { capture: 'Capture studio', library: 'Image library', quality: 'Capture quality', scene: '3D scene', guide: 'Field guide' };

  function switchView(view) {
    if (!viewTitles[view]) return;
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      const active = panel.dataset.viewPanel === view;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });
    document.querySelectorAll('.side-link,.mobile-nav-link').forEach((button) => {
      const active = button.dataset.nav === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('#active-view-title').textContent = viewTitles[view];
    if (view !== 'capture') stopCamera();
    if (view === 'library') renderLibrary();
    if (view === 'quality') updateQuality();
    $('#mobile-nav').classList.remove('open');
  }

  function renderLibrary() {
    const grid = $('#library-grid');
    if (!grid) return;
    grid.replaceChildren();
    $('#library-count').textContent = photos.length + (photos.length === 1 ? ' photo' : ' photos');
    $('#library-export').disabled = photos.length === 0;
    if (!photos.length) {
      grid.innerHTML = '<div class="library-empty"><span>▧</span><h3>Your image library is ready</h3><p>Add slope photos or capture views on your phone. They will appear here for review.</p><button class="button button-primary" type="button" data-nav="capture">Add the first images</button></div>';
      return;
    }
    photos.forEach((photo, index) => {
      const card = document.createElement('article');
      card.className = 'library-card';
      const image = document.createElement('img'); image.src = photo.url; image.alt = 'Terrain view ' + (index + 1);
      const meta = document.createElement('div'); meta.className = 'library-card-meta';
      const title = document.createElement('strong'); title.textContent = 'View ' + String(index + 1).padStart(2, '0');
      const detail = document.createElement('span'); detail.textContent = photo.width + ' × ' + photo.height + ' · ' + (photo.source === 'camera' ? 'Camera' : 'Library');
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small-link'; remove.textContent = 'Remove'; remove.addEventListener('click', () => removePhoto(index));
      meta.append(title, detail, remove); card.append(image, meta); grid.append(card);
    });
  }

  function setChecklist(name, state, text) {
    const item = $('#check-' + name);
    if (!item) return;
    item.classList.toggle('is-good', state === true);
    item.classList.toggle('is-caution', state === false);
    const status = item.querySelector('.check-status');
    if (status) status.textContent = text;
  }

  function updateQuality() {
    const count = photos.length;
    const large = photos.filter((photo) => photo.width >= 1280 && photo.height >= 720).length;
    $('#quality-count').innerHTML = count + ' <small>/ ' + MIN_PHOTOS + ' suggested</small>';
    $('#quality-resolution').textContent = count ? large + ' / ' + count : '—';
    $('#quality-count-bar').style.width = Math.min(100, count / MIN_PHOTOS * 100) + '%';
    $('#quality-resolution-bar').style.width = count ? (large / count * 100) + '%' : '0%';
    const matching = latestAnalysis && latestAnalysis.feature_matching;
    const matchedRatio = matching ? matching.matched_view_ratio : null;
    $('#quality-overlap').textContent = matchedRatio == null ? 'Run check' : matching.largest_matched_group + ' / ' + count + ' linked';
    $('#quality-overlap-bar').style.width = matchedRatio == null ? '0%' : Math.round(matchedRatio * 100) + '%';
    $('#feature-connectivity-note').textContent = matching
      ? matching.matched_pairs + ' of ' + matching.total_pairs + ' image pairs matched; ' + matching.connected_components + ' connected group(s).'
      : 'OpenCV matches distinctive features across images and checks their geometric consistency.';
    $('#check-count').classList.toggle('is-good', count >= MIN_PHOTOS);
    $('#check-resolution').classList.toggle('is-good', count > 0 && large >= Math.min(3, count));
    $('#check-overlap').classList.toggle('is-good', matchedRatio != null && matchedRatio >= 0.7);
    $('#check-count').classList.toggle('is-caution', count < MIN_PHOTOS);
    $('#check-resolution').classList.toggle('is-caution', count > 0 && large < Math.min(3, count));
    $('#check-overlap').classList.toggle('is-caution', matchedRatio != null && matchedRatio < 0.7);
    $('#quality-title').textContent = latestAnalysis ? latestAnalysis.summary : count === 0 ? 'Your review is waiting.' : 'Your capture set is taking shape.';
    $('#check-count').querySelector('.check-status').textContent = count >= MIN_PHOTOS ? 'Minimum reached' : 'Add more views';
    $('#check-resolution').querySelector('.check-status').textContent = count ? (large >= Math.min(3, count) ? 'Suitable dimensions' : 'Use larger images') : 'Awaiting images';
    $('#check-overlap').querySelector('.check-status').textContent = matchedRatio == null ? 'Run server check' : matchedRatio >= 0.7 ? 'Views connected' : 'Add intermediate views';
    $('#quality-summary').textContent = latestAnalysis
      ? latestAnalysis.feedback.join(' ')
      : count === 0 ? 'Add images to run quality checks and feature matching on the server.' : 'Image counts and dimensions are local previews. Run a server check for image quality and feature matching.';
  }

  function decodeImage(file) {
    if ('createImageBitmap' in window) {
      return createImageBitmap(file).catch(() => decodeWithElement(file));
    }
    return decodeWithElement(file);
  }

  function decodeWithElement(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const temporaryUrl = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(temporaryUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(temporaryUrl);
        reject(new Error('This image could not be opened.'));
      };
      image.src = temporaryUrl;
    });
  }

  function sampleImage(image) {
    const width = image.width || image.videoWidth || image.naturalWidth;
    const height = image.height || image.videoHeight || image.naturalHeight;
    sampleContext.drawImage(image, 0, 0, SAMPLE_W, SAMPLE_H);
    const rgba = sampleContext.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const gray = new Float32Array(SAMPLE_W * SAMPLE_H);
    for (let pixel = 0, index = 0; pixel < rgba.length; pixel += 4, index += 1) {
      gray[index] = rgba[pixel] * 0.299 + rgba[pixel + 1] * 0.587 + rgba[pixel + 2] * 0.114;
    }
    let gradientTotal = 0;
    let gradientSquared = 0;
    let gradientCount = 0;
    for (let y = 1; y < SAMPLE_H - 1; y += 1) {
      for (let x = 1; x < SAMPLE_W - 1; x += 1) {
        const index = y * SAMPLE_W + x;
        const gradient = Math.abs(gray[index + 1] - gray[index - 1]) + Math.abs(gray[index + SAMPLE_W] - gray[index - SAMPLE_W]);
        gradientTotal += gradient;
        gradientSquared += gradient * gradient;
        gradientCount += 1;
      }
    }
    const mean = gradientTotal / gradientCount;
    const sharpness = Math.max(0, gradientSquared / gradientCount - mean * mean);
    return { pixels: gray, width, height, sharpness };
  }

  function estimateOverlap(previous, current) {
    if (!previous || !current) return null;
    let best = { correlation: -1, dx: 0, dy: 0 };
    for (let dy = -8; dy <= 8; dy += 2) {
      for (let dx = -14; dx <= 14; dx += 2) {
        const x0 = Math.max(0, -dx);
        const x1 = Math.min(SAMPLE_W, SAMPLE_W - dx);
        const y0 = Math.max(0, -dy);
        const y1 = Math.min(SAMPLE_H, SAMPLE_H - dy);
        let n = 0, sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
        for (let y = y0; y < y1; y += 1) {
          const rowA = y * SAMPLE_W;
          const rowB = (y + dy) * SAMPLE_W;
          for (let x = x0; x < x1; x += 1) {
            const a = previous[rowA + x];
            const b = current[rowB + x + dx];
            sumA += a; sumB += b; sumAA += a * a; sumBB += b * b; sumAB += a * b; n += 1;
          }
        }
        const covariance = sumAB - sumA * sumB / n;
        const varianceA = sumAA - sumA * sumA / n;
        const varianceB = sumBB - sumB * sumB / n;
        const correlation = varianceA > 1 && varianceB > 1 ? covariance / Math.sqrt(varianceA * varianceB) : -1;
        if (correlation > best.correlation) best = { correlation, dx, dy };
      }
    }
    if (best.correlation < 0.22) return { percent: null, confidence: best.correlation };
    const overlap = Math.max(0, SAMPLE_W - Math.abs(best.dx)) * Math.max(0, SAMPLE_H - Math.abs(best.dy));
    return {
      percent: Math.round(overlap / (SAMPLE_W * SAMPLE_H) * 100),
      confidence: best.correlation,
      dx: best.dx,
      dy: best.dy
    };
  }

  function updateOverlap(result, firstFrame = false) {
    const card = $('#overlap-card');
    const value = $('#overlap-value');
    const bar = $('#overlap-bar');
    card.classList.remove('low');
    if (firstFrame || photos.length === 0) {
      value.textContent = 'Waiting for first photo';
      bar.style.width = '0%';
      return;
    }
    if (!result || result.percent == null) {
      value.textContent = result ? 'Low visual match' : 'Checking next view…';
      bar.style.width = '0%';
      card.classList.add('low');
      return;
    }
    value.textContent = result.percent + '% frame similarity';
    bar.style.width = result.percent + '%';
    if (result.percent < TARGET_OVERLAP) card.classList.add('low');
  }

  function nextCue() {
    const count = photos.length;
    const directions = [
      'Choose a starting point',
      'Move one short step right',
      'Continue along the slope',
      'Keep the same features in view',
      'Close the capture arc',
      'Add a view for hidden terrain'
    ];
    $('#direction-text').textContent = directions[Math.min(count, directions.length - 1)];
    $('#angle-value').textContent = count === 0 ? 'START' : count >= MIN_PHOTOS ? 'OPTIONAL' : '+20°';
    $('#direction-arrow').textContent = count === 0 ? '◎' : count >= MIN_PHOTOS ? '＋' : '↗';
    $('#shot-count').innerHTML = String(count).padStart(2, '0') + ' <small>/ 05</small>';
    $('#guidance-message').textContent = count === 0
      ? 'Frame the full slope from safe ground. Move sideways in short steps between views.'
      : count >= MIN_PHOTOS
        ? 'Minimum set captured. Add viewpoints for terrain hidden behind ridges or vegetation.'
        : 'Move sideways a short step, keeping recognizable slope features in frame. Aim for at least 70% overlap.';
  }

  function renderPhotos() {
    const count = photos.length;
    $('#photo-count').innerHTML = count + ' <small>/ 5 minimum</small>';
    $('#photo-summary').textContent = count === 0 ? 'No photos yet' : count + (count === 1 ? ' photo added' : ' photos added');
    $('#progress-bar').style.width = Math.min(100, count / MIN_PHOTOS * 100) + '%';
    $('#progress-text').textContent = count >= MIN_PHOTOS ? 'Minimum image count reached' : 'Add ' + (MIN_PHOTOS - count) + ' more ' + (MIN_PHOTOS - count === 1 ? 'view' : 'views');
    $('#clear-photos').hidden = count === 0;
    $('#check-readiness').disabled = count === 0;
    $('#run-quality-check').disabled = count === 0;
    $('#reconstruct-button').disabled = count < MIN_PHOTOS;
    document.querySelector('#download-set').disabled = count === 0;
    $('#nav-photo-count').textContent = String(count);
    $('#heading-session-status').textContent = count ? count + (count === 1 ? ' view captured' : ' views captured') : 'Waiting for images';
    thumbnailGrid.replaceChildren();
    const shownSlots = count > MIN_PHOTOS ? count : MIN_PHOTOS + 1;
    for (let index = 0; index < shownSlots; index += 1) {
      const photo = photos[index];
      if (!photo) {
        const slot = document.createElement('div');
        slot.className = 'empty-photo' + (index >= MIN_PHOTOS ? ' optional' : '');
        slot.innerHTML = '<span>＋</span><small>' + (index >= MIN_PHOTOS ? 'More' : 'View ' + String(index + 1).padStart(2, '0')) + '</small>';
        thumbnailGrid.append(slot);
        continue;
      }
      const tile = document.createElement('div');
      tile.className = 'photo-thumb';
      const image = document.createElement('img');
      image.src = photo.url;
      image.alt = 'Terrain view ' + (index + 1);
      const indexLabel = document.createElement('span');
      indexLabel.className = 'photo-index';
      indexLabel.textContent = String(index + 1).padStart(2, '0');
      const origin = document.createElement('span');
      origin.className = 'photo-origin';
      origin.textContent = photo.source === 'camera' ? 'CAM' : 'FILE';
      const remove = document.createElement('button');
      remove.className = 'remove-photo';
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove view ' + (index + 1));
      remove.textContent = '×';
      remove.addEventListener('click', () => removePhoto(index));
      tile.append(image, indexLabel, origin, remove);
      thumbnailGrid.append(tile);
    }
    nextCue();
    updateOverlap(null, count === 0);
    renderLibrary();
    updateQuality();
  }

  function removePhoto(index) {
    const [photo] = photos.splice(index, 1);
    if (photo) URL.revokeObjectURL(photo.url);
    renderPhotos();
    resetReadiness();
  }

  function resetReadiness() {
    qualityReviewed = false;
    latestAnalysis = null;
    $('#readiness-results').hidden = true;
    updateQuality();
    const box = $('#readiness-box');
    box.classList.remove('is-ready', 'is-warning');
    $('#readiness-icon').textContent = '✳';
    $('#readiness-title').textContent = photos.length ? 'Photo set updated' : 'Ready to get started?';
    $('#readiness-detail').textContent = photos.length
      ? 'Run a new readiness review to refresh the capture checks.'
      : 'Add images to review resolution, sharpness and visual overlap.';
  }

  async function addFiles(files) {
    const selected = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!selected.length) {
      notify('Choose image files to add to the session.');
      return;
    }
    let added = 0;
    for (const file of selected) {
      try {
        const bitmap = await decodeImage(file);
        const info = sampleImage(bitmap);
        const overlap = photos.length ? estimateOverlap(photos[photos.length - 1].features, info.pixels) : null;
        const photo = {
          file,
          url: URL.createObjectURL(file),
          features: info.pixels,
          width: info.width,
          height: info.height,
          sharpness: info.sharpness,
          overlap: overlap ? overlap.percent : null,
          overlapConfidence: overlap ? overlap.confidence : null,
          source: 'file'
        };
        photos.push(photo);
        if (typeof bitmap.close === 'function') bitmap.close();
        added += 1;
      } catch (error) {
        notify(file.name + ': ' + error.message);
      }
    }
    if (added) {
      renderPhotos();
      resetReadiness();
      const last = photos[photos.length - 1];
      if (last.overlap != null || photos.length === 1) {
        const previousOverlap = last.overlap == null ? null : { percent: last.overlap, confidence: last.overlapConfidence };
        updateOverlap(previousOverlap, photos.length === 1);
      }
      notify(added + (added === 1 ? ' image added to this browser session.' : ' images added to this browser session.'));
    }
    fileInput.value = '';
  }

  function updateDirectionFromHeading() {
    const prior = photos[photos.length - 1];
    if (!prior || prior.heading == null || facingHeading == null) return;
    const delta = ((facingHeading - prior.heading + 540) % 360) - 180;
    const remaining = 20 - delta;
    if (remaining > 3) {
      $('#direction-text').textContent = 'Rotate right slightly';
      $('#angle-value').textContent = '+' + Math.round(remaining) + '°';
      $('#direction-arrow').textContent = '↗';
    } else if (remaining < -3) {
      $('#direction-text').textContent = 'Ease back left';
      $('#angle-value').textContent = Math.round(remaining) + '°';
      $('#direction-arrow').textContent = '↖';
    } else {
      $('#direction-text').textContent = 'Angle on target';
      $('#angle-value').textContent = 'READY';
      $('#direction-arrow').textContent = '✓';
    }
  }
  async function requestOrientation() {
    if (typeof DeviceOrientationEvent === 'undefined' || orientationEnabled) return;
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return;
      } catch { return; }
    }
    window.addEventListener('deviceorientation', (event) => {
      if (Number.isFinite(event.alpha)) {
        facingHeading = (360 - event.alpha) % 360;
        updateDirectionFromHeading();
      }
    }, { passive: true });
    orientationEnabled = true;
  }

  function readLiveFrame() {
    if (!video.videoWidth || video.readyState < 2) return null;
    sampleContext.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const rgba = sampleContext.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const gray = new Float32Array(SAMPLE_W * SAMPLE_H);
    for (let pixel = 0, index = 0; pixel < rgba.length; pixel += 4, index += 1) {
      gray[index] = rgba[pixel] * 0.299 + rgba[pixel + 1] * 0.587 + rgba[pixel + 2] * 0.114;
    }
    return gray;
  }

  function checkLiveOverlap() {
    if (!stream || !photos.length || overlapBusy) return;
    overlapBusy = true;
    try {
      const previous = photos[photos.length - 1].features;
      updateOverlap(estimateOverlap(previous, readLiveFrame()));
    } catch {
      updateOverlap(null);
    } finally {
      overlapBusy = false;
    }
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    if (overlapTimer) window.clearInterval(overlapTimer);
    overlapTimer = null;
    cameraFrame.classList.remove('active');
    placeholder.hidden = false;
    captureButton.disabled = true;
    flipButton.disabled = true;
    streamButton.innerHTML = '<span class="button-icon">◉</span> Start camera';
    $('#live-text').textContent = 'CAMERA OFF';
    $('#live-dot').classList.remove('on');
  }

  async function startCamera() {
    cameraError.hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraError.textContent = 'Camera access needs HTTPS (or localhost) and a browser that supports camera capture.';
      cameraError.hidden = false;
      return;
    }
    try {
      if (stream) stopCamera();
      await requestOrientation();
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      cameraFrame.classList.add('active');
      placeholder.hidden = true;
      captureButton.disabled = false;
      flipButton.disabled = false;
      streamButton.innerHTML = '<span class="button-icon">Ⅱ</span> Stop camera';
      $('#live-text').textContent = 'LIVE CAMERA';
      $('#live-dot').classList.add('on');
      $('#lens-label').textContent = facingMode === 'environment' ? 'REAR LENS' : 'FRONT LENS';
      overlapTimer = window.setInterval(checkLiveOverlap, 1100);
    } catch (error) {
      stream = null;
      const message = error && error.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Allow camera access in your browser settings, then try again.'
        : error && error.name === 'NotFoundError'
          ? 'No camera was found on this device.'
          : error && error.name === 'NotReadableError'
            ? 'The camera may be in use by another app. Close it and try again.'
            : 'Could not start the camera' + (error && error.message ? ': ' + error.message : '.');
      cameraError.textContent = message;
      cameraError.hidden = false;
      stopCamera();
    }
  }

  async function capturePhoto() {
    if (!stream || !video.videoWidth) return;
    const sample = readLiveFrame();
    const overlap = photos.length ? estimateOverlap(photos[photos.length - 1].features, sample) : null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      notify('The camera could not save this frame. Try again.');
      return;
    }
    const file = new File([blob], 'terra-sight-view-' + String(photos.length + 1).padStart(2, '0') + '.jpg', { type: 'image/jpeg' });
    const info = sampleImage(canvas);
    photos.push({
      file, url: URL.createObjectURL(blob), features: info.pixels, width: info.width, height: info.height,
      sharpness: info.sharpness, overlap: overlap ? overlap.percent : null,
      overlapConfidence: overlap ? overlap.confidence : null, heading: facingHeading, source: 'camera'
    });
    renderPhotos();
    resetReadiness();
    if (overlap) updateOverlap(overlap);
    notify('View ' + photos.length + ' captured. Keep the same terrain features in frame.');
  }

  function clearPhotos() {
    photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    photos.splice(0, photos.length);
    renderPhotos();
    resetReadiness();
  }

  async function getSessionId() {
    if (sessionId) return sessionId;
    try { sessionId = sessionStorage.getItem('terrasight-session-id'); } catch { /* Private browsing may block storage. */ }
    if (sessionId) return sessionId;
    const response = await fetch('/api/sessions', { method: 'POST', headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok || !result.session_id) throw new Error(result.detail || 'Could not start a processing session.');
    sessionId = result.session_id;
    try { sessionStorage.setItem('terrasight-session-id', sessionId); } catch { /* The active page retains the ID in memory. */ }
    return sessionId;
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not prepare an image for upload.')), 'image/jpeg', quality));
  }

  async function prepareAnalysisBatch() {
    const presets = [[0.76, 1600], [0.64, 1280], [0.52, 1024], [0.44, 800]];
    for (const [quality, maxEdge] of presets) {
      const encoded = [];
      let total = 0;
      for (const photo of photos) {
        const bitmap = await decodeImage(photo.file);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (typeof bitmap.close === 'function') bitmap.close();
        const blob = await canvasBlob(canvas, quality);
        total += blob.size;
        encoded.push(blob);
      }
      if (total <= 3_800_000) return encoded;
    }
    throw new Error('This image set is too large to send as one Vercel request. Remove some images and run the check again.');
  }

  function renderReadinessDetails(result) {
    const grid = $('#readiness-view-list');
    grid.replaceChildren();
    for (const view of result.views) {
      const row = document.createElement('article');
      row.className = 'readiness-view-row';
      const heading = document.createElement('div'); heading.className = 'readiness-view-heading';
      const name = document.createElement('strong'); name.textContent = 'View ' + String(view.index + 1).padStart(2, '0') + ' · ' + view.filename;
      const status = document.createElement('span'); status.className = view.quality === 'good' ? 'result-good' : 'result-review'; status.textContent = view.quality === 'good' ? 'LOOKS GOOD' : 'REVIEW';
      heading.append(name, status);
      const metrics = document.createElement('p');
      metrics.textContent = view.width + ' × ' + view.height + ' px · sharpness ' + view.blur_score + ' · ' + view.feature_count + ' features' + (view.duplicate_of == null ? '' : ' · duplicate of view ' + (view.duplicate_of + 1));
      row.append(heading, metrics);
      if (view.issues.length) {
        const issues = document.createElement('ul');
        view.issues.forEach((message) => { const item = document.createElement('li'); item.textContent = message; issues.append(item); });
        row.append(issues);
      }
      grid.append(row);
    }
    $('#readiness-limits').textContent = result.limitations.join(' ');
    $('#readiness-results').hidden = false;
  }

  async function checkReadiness() {
    if (!photos.length) return;
    const buttons = [$('#check-readiness'), $('#run-quality-check')];
    buttons.forEach((button) => { button.disabled = true; button.dataset.label = button.textContent; button.textContent = 'Analyzing images…'; });
    $('#readiness-title').textContent = 'Analyzing image batch';
    $('#readiness-detail').textContent = 'Preparing images and checking quality and feature connectivity.';
    try {
      const [id, encoded] = await Promise.all([getSessionId(), prepareAnalysisBatch()]);
      const form = new FormData();
      encoded.forEach((blob, index) => form.append('files', blob, 'view-' + String(index + 1).padStart(2, '0') + '.jpg'));
      form.append('original_dimensions', JSON.stringify(photos.map((photo) => ({ width: photo.width, height: photo.height }))));
      const response = await fetch('/api/sessions/' + encodeURIComponent(id) + '/readiness', { method: 'POST', body: form, headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Image analysis failed with status ' + response.status + '.');
      latestAnalysis = result;
      qualityReviewed = true;
      updateQuality();
      renderReadinessDetails(result);
      const ready = result.ready;
      $('#readiness-box').classList.toggle('is-ready', ready);
      $('#readiness-box').classList.toggle('is-warning', !ready);
      $('#readiness-icon').textContent = ready ? '✓' : '!';
      $('#readiness-title').textContent = result.summary;
      $('#readiness-detail').textContent = result.feedback.join(' ');
      notify(ready ? 'The image set looks promising for a reconstruction attempt.' : 'Readiness check complete. Follow the feedback before reconstruction.');
    } catch (error) {
      $('#readiness-box').classList.add('is-warning');
      $('#readiness-title').textContent = 'Could not complete the quality check';
      $('#readiness-detail').textContent = error.message || 'The API could not analyze this image set.';
      notify(error.message || 'The API could not analyze this image set.');
    } finally {
      buttons.forEach((button) => { button.textContent = button.dataset.label || 'Review quality'; delete button.dataset.label; });
      renderPhotos();
    }
  }

  function startReconstruction() {
    notify('The 3D reconstruction service is not connected yet. This action does not submit or reconstruct the photos.');
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function downloadPhotoSet() {
    if (!photos.length) return;
    const encoder = new TextEncoder();
    const chunks = [];
    const directory = [];
    let offset = 0;
    for (let index = 0; index < photos.length; index += 1) {
      const type = photos[index].file.type;
      const extension = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/heic' ? 'heic' : type === 'image/heif' ? 'heif' : 'jpg';
      const name = encoder.encode('terra-sight-view-' + String(index + 1).padStart(2, '0') + '.' + extension);
      const data = new Uint8Array(await photos[index].file.arrayBuffer());
      const checksum = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(10, 0, true); localView.setUint16(12, 33, true);
      localView.setUint32(14, checksum, true); localView.setUint32(18, data.length, true); localView.setUint32(22, data.length, true); localView.setUint16(26, name.length, true); local.set(name, 30);
      chunks.push(local, data);
      const central = new Uint8Array(46 + name.length);
      const view = new DataView(central.buffer);
      view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(10, 0, true); view.setUint16(12, 33, true);
      view.setUint32(16, checksum, true); view.setUint32(20, data.length, true); view.setUint32(24, data.length, true); view.setUint16(28, name.length, true); view.setUint32(42, offset, true); central.set(name, 46);
      directory.push(central);
      offset += local.length + data.length;
    }
    const directoryLength = directory.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, directory.length, true); endView.setUint16(10, directory.length, true);
    endView.setUint32(12, directoryLength, true); endView.setUint32(16, offset, true);
    const zip = new Blob([...chunks, ...directory, end], { type: 'application/zip' });
    const url = URL.createObjectURL(zip);
    const link = document.createElement('a');
    link.href = url; link.download = 'terra-sight-photo-set.zip';
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  $('#tab-camera').addEventListener('click', () => {
    $('#tab-camera').classList.add('selected');
    $('#tab-camera').setAttribute('aria-selected', 'true');
    $('#tab-upload').classList.remove('selected');
    $('#tab-upload').setAttribute('aria-selected', 'false');
    $('#camera-source').hidden = false;
    $('#upload-source').hidden = true;
  });
  $('#tab-upload').addEventListener('click', () => {
    if (stream) stopCamera();
    $('#tab-upload').classList.add('selected');
    $('#tab-upload').setAttribute('aria-selected', 'true');
    $('#tab-camera').classList.remove('selected');
    $('#tab-camera').setAttribute('aria-selected', 'false');
    $('#upload-source').hidden = false;
    $('#camera-source').hidden = true;
  });
  streamButton.addEventListener('click', () => stream ? stopCamera() : startCamera());
  captureButton.addEventListener('click', capturePhoto);
  flipButton.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });
  dropzone.addEventListener('click', () => fileInput.click());
  $('#add-photos').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (event) => addFiles(event.target.files));
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    addFiles(event.dataTransfer.files);
  });
  $('#clear-photos').addEventListener('click', clearPhotos);
  $('#check-readiness').addEventListener('click', () => { switchView('quality'); checkReadiness(); });
  $('#run-quality-check').addEventListener('click', checkReadiness);
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) switchView(nav.dataset.nav);
  });
  $('#mobile-menu').addEventListener('click', () => $('#mobile-nav').classList.toggle('open'));
  $('#new-session').addEventListener('click', () => {
    if (photos.length && !window.confirm('Start a new survey and clear the current images?')) return;
    clearPhotos();
    switchView('capture');
  });
  $('#library-add').addEventListener('click', () => { switchView('capture'); $('#tab-upload').click(); fileInput.click(); });
  $('#library-export').addEventListener('click', downloadPhotoSet);
  $('#quality-count-bar').style.width = '0%';
  $('#quality-resolution-bar').style.width = '0%';
  $('#quality-overlap-bar').style.width = '0%';
  $('#reconstruct-button').addEventListener('click', startReconstruction);
  document.querySelector('#download-set').addEventListener('click', downloadPhotoSet);
  window.addEventListener('pagehide', () => {
    stopCamera();
    photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  });
  document.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    if (event.code === 'Space' && stream && !event.repeat && active && !['BUTTON', 'INPUT', 'TEXTAREA'].includes(active.tagName)) {
      event.preventDefault();
      capturePhoto();
    }
  });

  renderPhotos();
  checkApi();
})();
