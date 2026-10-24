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
    value.textContent = result.percent + '% estimated';
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
    $('#reconstruct-button').disabled = count < MIN_PHOTOS;
    document.querySelector('#download-set').disabled = count === 0;
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
  }

  function removePhoto(index) {
    const [photo] = photos.splice(index, 1);
    if (photo) URL.revokeObjectURL(photo.url);
    renderPhotos();
    resetReadiness();
  }

  function resetReadiness() {
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

  function checkReadiness() {
    if (!photos.length) return;
    const box = $('#readiness-box');
    const count = photos.length;
    const largeEnough = photos.filter((photo) => photo.width >= 1280 && photo.height >= 720).length;
    const overlaps = photos.slice(1).map((photo) => photo.overlap).filter((value) => value != null);
    const averageOverlap = overlaps.length ? Math.round(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length) : null;
    const resolutionOk = largeEnough >= Math.min(3, count);
    const overlapOk = averageOverlap != null && averageOverlap >= TARGET_OVERLAP;
    const countOk = count >= MIN_PHOTOS;
    const ready = countOk && resolutionOk && overlapOk;
    const caution = countOk && resolutionOk && averageOverlap != null;
    box.classList.toggle('is-ready', ready);
    box.classList.toggle('is-warning', !ready);
    $('#readiness-icon').textContent = ready ? '✓' : '!';
    $('#readiness-title').textContent = ready ? 'Capture set looks promising' : caution ? 'Review the capture coverage' : 'A few more views needed';
    const details = [];
    details.push(countOk ? count + ' views collected' : 'Need ' + Math.max(0, MIN_PHOTOS - count) + ' more views');
    details.push(largeEnough + ' high-resolution');
    details.push(averageOverlap == null ? 'overlap could not be estimated reliably' : averageOverlap + '% average estimated overlap');
    $('#readiness-detail').textContent = details.join(' · ') + '. Browser-side screening only; reconstruction quality is not verified.';
    notify(ready ? 'Initial capture checks passed. This does not confirm 3D reconstruction quality.' : 'Capture check complete. Review the items shown in the session panel.');
  }

  function startReconstruction() {
    notify('The 3D reconstruction service is not connected yet. Photos remain on this device and have not been sent.');
    $('#backend-note').textContent = 'Backend reconstruction is not available yet; your images remain in this browser.';
    $('#backend-note').classList.add('is-notice');
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
  $('#check-readiness').addEventListener('click', checkReadiness);
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