// Update Masjid Timetable — 3-step wizard (Upload → Review → Done)
// Adapted from add-masjid.js for updating existing masjid timetables

const USE_DUMMY_DATA = false;

let pdfjsLoaded = false;
async function loadPdfJs() {
  if (pdfjsLoaded) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs';
    script.type = 'module';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';
  window._pdfjsLib = pdfjsLib;
  pdfjsLoaded = true;
}

async function pdfToImageDataUrl(dataUrl) {
  await loadPdfJs();
  const pdfjsLib = window._pdfjsLib;
  const data = atob(dataUrl.split(',')[1]);
  const uint8 = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) uint8[i] = data.charCodeAt(i);
  const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
  const page = await pdf.getPage(1);
  const scale = 2;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/png');
}

const TURNSTILE_SITE_KEY = '0x4AAAAAACq8qcWOcA9r5EqM';
let turnstileToken = null;
let turnstileWidgetId = null;
let isSubmitting = false;
let selectedFile = null;
let imageDataUrl = null;
let extractedData = null;
let _resizeObserver = null;
let _syncImageHeight = null;
let masjidConfig = null;
let masjidSlug = null;

export async function render(container, { slug }) {
  selectedFile = null;
  imageDataUrl = null;
  extractedData = null;
  masjidConfig = null;
  masjidSlug = slug;

  if (!slug) {
    container.innerHTML = '<div class="error">No masjid specified.</div>';
    return;
  }

  // Fetch existing config
  try {
    const configRes = await fetch(`/data/mosques/${slug}.json`);
    if (!configRes.ok) {
      container.innerHTML = `<div class="not-found">
        <div class="not-found-code">404</div>
        <p class="not-found-message">Masjid not found.</p>
        <a href="/" class="not-found-link" data-link>Go Home</a>
      </div>`;
      return;
    }
    masjidConfig = await configRes.json();
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load masjid data.</div>`;
    return;
  }

  document.title = `Update ${masjidConfig.display_name} - Iqamah`;
  container.innerHTML = getWizardHTML();
  setupEventListeners(container);
  loadTurnstile(container);
}

function loadTurnstile(container) {
  const widgetEl = container.querySelector('#turnstileWidget');
  if (!widgetEl) return;

  function renderWidget() {
    if (turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.remove(turnstileWidgetId);
    }
    turnstileToken = null;
    turnstileWidgetId = window.turnstile.render('#turnstileWidget', {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: 'interaction-only',
      'refresh-expired': 'auto',
      callback: (token) => { turnstileToken = token; },
      'expired-callback': () => {
        turnstileToken = null;
        if (window.turnstile && turnstileWidgetId !== null) {
          window.turnstile.reset(turnstileWidgetId);
        }
      },
      'error-callback': () => { turnstileToken = null; },
    });
  }

  if (window.turnstile) {
    renderWidget();
  } else {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
    script.async = true;
    window.onTurnstileLoad = renderWidget;
    document.head.appendChild(script);
  }
}

export function destroy() {
  if (turnstileWidgetId !== null && window.turnstile) {
    window.turnstile.remove(turnstileWidgetId);
    turnstileWidgetId = null;
  }
  turnstileToken = null;
  isSubmitting = false;
  selectedFile = null;
  imageDataUrl = null;
  extractedData = null;
  masjidConfig = null;
  masjidSlug = null;
  if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
  if (_syncImageHeight) { window.removeEventListener('resize', _syncImageHeight); _syncImageHeight = null; }
  document.title = 'Iqamah';
}

function getWizardHTML() {
  const name = masjidConfig ? masjidConfig.display_name : '';
  return `
    <div class="add-masjid-view">
      <header>
        <h1>Update Timetable <span class="beta-badge">BETA</span></h1>
        <p class="add-subtitle" id="uploadSubtitle">Upload the latest timetable for ${escapeHtml(name)}</p>
        <p class="add-subtitle" id="aiDisclaimer" style="display:none;">Times were extracted using AI and may contain errors.<br>Please verify before submitting.</p>
      </header>

      <div class="progress-bar">
        <div class="progress-step active" id="progStep1"><span class="step-number">1</span><span class="step-label">Upload</span></div>
        <div class="progress-connector" id="progConn1"></div>
        <div class="progress-step" id="progStep2"><span class="step-number">2</span><span class="step-label">Extract</span></div>
        <div class="progress-connector" id="progConn2"></div>
        <div class="progress-step" id="progStep3"><span class="step-number">3</span><span class="step-label">Review</span></div>
        <div class="progress-connector" id="progConn3"></div>
        <div class="progress-step" id="progStep4"><span class="step-number">4</span><span class="step-label">Done</span></div>
      </div>

      <!-- Step 1: Upload -->
      <div class="step-panel active" id="step1">
        <div class="card">
          <div class="form-group">
            <label>Timetable File <span class="required">*</span></label>
            <div class="upload-area" id="uploadArea" style="user-select:none;-webkit-user-select:none;">
              <div class="upload-icon">&#128247;</div>
              <div class="upload-text"><strong>Upload timetable</strong></div>
              <div class="upload-hint">JPG, PNG, or PDF, max 10MB</div>
              <div class="upload-tip">Hold your phone directly above the timetable. Make sure all columns and rows are visible, with good lighting and no shadows.</div>
              <input type="file" class="upload-input" id="fileInput" accept="image/*,.pdf,application/pdf">
            </div>
            <div class="error-msg" id="uploadError"></div>
            <div class="image-preview" id="imagePreview">
              <img id="previewImg" alt="Timetable preview">
              <div class="file-info" id="fileInfo"></div>
              <span class="change-btn" id="changeBtn">Change file</span>
            </div>
          </div>
          <div id="turnstileWidget" class="turnstile-container"></div>
          <div class="btn-row">
            <button class="btn btn-primary" id="extractBtn" disabled>Extract Prayer Times</button>
          </div>
          <div class="error-msg" id="extractError"></div>
        </div>
      </div>

      <!-- Step 2: Extracting -->
      <div class="step-panel" id="step2">
        <div class="card">
          <div class="status-msg">
            <div class="spinner"></div>
            <div>Extracting prayer times...</div>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:8px;">This usually takes 15-30 seconds</div>
          </div>
        </div>
      </div>

      <!-- Step 3: Review -->
      <div class="step-panel" id="step3">
        <div class="card">
          <div class="section-label">Extracted Timetable</div>
          <div class="review-layout">
            <div class="review-image-wrap" id="reviewImageWrap">
              <div class="review-image" id="reviewImageContainer">
                <img id="reviewImg" alt="Original timetable">
              </div>
              <div class="zoom-hint"><span class="zoom-hint-mobile">Pinch to zoom</span><span class="zoom-hint-desktop">Use buttons to zoom</span></div>
              <div class="zoom-controls" id="zoomControls">
                <button class="zoom-btn" id="zoomInBtn" title="Zoom in">+</button>
                <div class="zoom-level" id="zoomLevel">1x</div>
                <button class="zoom-btn" id="zoomOutBtn" title="Zoom out">&minus;</button>
                <button class="zoom-btn" id="zoomResetBtn" title="Reset zoom" style="font-size:0.7rem;">&#8634;</button>
              </div>
            </div>
            <div class="review-table-wrap">
              <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;">Tap any cell to edit.</p>
              <table class="review-table" id="reviewTable">
                <thead id="reviewThead"></thead>
                <tbody id="reviewTbody"></tbody>
              </table>
            </div>
          </div>

          <div class="section-label">Masjid Details</div>
          <div class="form-group"><label for="masjidName">Masjid Name</label><input type="text" id="masjidName" value="${escapeAttr(name)}" readonly style="opacity:0.6;cursor:not-allowed;" maxlength="100"></div>
          <div class="meta-grid">
            <div class="form-group"><label for="metaAddress">Address</label><input type="text" id="metaAddress" placeholder="Full address with postcode" maxlength="200"></div>
            <div class="form-group"><label for="metaPhone">Phone</label><input type="text" id="metaPhone" placeholder="Phone number" maxlength="30"></div>
            <div class="form-group"><label for="metaRadio">Radio Frequency</label><input type="text" id="metaRadio" placeholder="e.g. 454.3500" maxlength="20"></div>
            <div class="form-group"><label for="metaEid">Eid Salah</label><input type="text" id="metaEid" placeholder="e.g. 7:30am & 9:00am" maxlength="100"></div>
            <div class="form-group"><label for="metaFitrana">Sadaqatul Fitr</label><input type="text" id="metaFitrana" placeholder="e.g. \u00a35 per person" maxlength="50"></div>
            <div class="form-group"><label for="metaJummah">Jumu'ah Times</label><input type="text" id="metaJummah" placeholder="e.g. 12:30pm & 1:30pm" maxlength="100"></div>
          </div>
          <div class="form-group" style="margin-top:12px;"><label for="metaNotes">Notes</label><textarea id="metaNotes" rows="2" placeholder="Any additional notes" maxlength="500"></textarea></div>

          <div class="btn-row review-btn-row">
            <button class="btn btn-primary" id="submitBtn">Update Timetable</button>
          </div>
          <div class="error-msg" id="submitError"></div>
        </div>
        <div class="card" id="submittingStatus" style="display:none; margin-top:16px;">
          <div class="status-msg"><div class="spinner"></div><div>Saving timetable update...</div></div>
        </div>
      </div>

      <!-- Step 4: Done -->
      <div class="step-panel" id="step4">
        <div class="card">
          <div class="confirmation">
            <div class="check-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p id="confirmationText">Timetable has been updated</p>
            <p class="confirmation-note" id="confirmationNote">The updated times are live but will show a "Pending Review" tag until approved.</p>
            <div style="margin-top:24px;">
              <a href="/${masjidSlug}" class="btn btn-primary" data-link>View ${escapeHtml(name)}</a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Lightbox -->
    <div class="lightbox" id="lightbox">
      <button class="lightbox-close" id="lightboxClose">&times;</button>
      <img id="lightboxImg" alt="Timetable zoomed">
    </div>
  `;
}

function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escapeAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function setupEventListeners(container) {
  const uploadArea = container.querySelector('#uploadArea');
  const fileInput = container.querySelector('#fileInput');
  const imagePreview = container.querySelector('#imagePreview');
  const previewImg = container.querySelector('#previewImg');
  const fileInfo = container.querySelector('#fileInfo');
  const changeBtn = container.querySelector('#changeBtn');
  const uploadError = container.querySelector('#uploadError');
  const extractBtn = container.querySelector('#extractBtn');
  const extractError = container.querySelector('#extractError');
  const submitBtn = container.querySelector('#submitBtn');
  const submitError = container.querySelector('#submitError');
  const submittingStatus = container.querySelector('#submittingStatus');
  const masjidNameInput = container.querySelector('#masjidName');
  const reviewImg = container.querySelector('#reviewImg');
  const reviewThead = container.querySelector('#reviewThead');
  const reviewTbody = container.querySelector('#reviewTbody');
  const confirmationText = container.querySelector('#confirmationText');

  function goToStep(num) {
    document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('step' + num)?.classList.add('active');
    for (let s = 1; s <= 4; s++) {
      const stepEl = document.getElementById('progStep' + s);
      if (!stepEl) continue;
      stepEl.classList.remove('active', 'done');
      if (s < num) stepEl.classList.add('done');
      else if (s === num) stepEl.classList.add('active');
    }
    for (let c = 1; c <= 3; c++) {
      document.getElementById('progConn' + c)?.classList.toggle('done', c < num);
    }
    const uploadSub = document.getElementById('uploadSubtitle');
    const disclaimer = document.getElementById('aiDisclaimer');
    if (uploadSub) uploadSub.style.display = num === 3 ? 'none' : '';
    if (disclaimer) disclaimer.style.display = num === 3 ? '' : 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function parseTime(str) {
    if (!str || !str.trim()) return null;
    const parts = str.trim().split(':');
    if (parts.length !== 2) return null;
    const h = parseInt(parts[0]), m = parseInt(parts[1]);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  function parseTimePM(str) {
    const mins = parseTime(str);
    if (mins === null) return null;
    return mins > 0 && mins < 720 ? mins + 720 : mins;
  }

  function validateExtractedData(data) {
    const rows = data?.rows;
    if (!rows || rows.length === 0) {
      return "We couldn't extract any prayer times from this image. Please make sure the image is clear and shows the full timetable, then try again.";
    }
    let failures = 0;
    for (const row of rows) {
      const sehri = parseTime(row.sehri_ends);
      const fajrJ = parseTime(row.fajr_jamaat);
      const sunrise = parseTime(row.sunrise);
      const asr = parseTimePM(row.asr);
      const maghrib = parseTimePM(row.maghrib_iftari);
      const maghribJ = parseTimePM(row.maghrib_jamaat);
      const esha = parseTimePM(row.esha);
      const eshaJ = parseTimePM(row.esha_jamaat);
      if (fajrJ && sunrise && fajrJ >= sunrise) failures++;
      if (sehri && sunrise && sehri >= sunrise) failures++;
      if (asr && maghrib && maghrib <= asr) failures++;
      if (esha && maghrib && (esha - maghrib) < 30) failures++;
      if (maghribJ && eshaJ && maghribJ === eshaJ) failures++;
    }
    if (failures > rows.length / 2) {
      return "We couldn't extract the times accurately from this image. Please make sure the image is clear, well-lit, and shows the full timetable, then try again.";
    }
    return null;
  }

  function showReviewOverlay() {
    if (localStorage.getItem('iqamah-review-hint-dismissed')) return;
    const overlay = document.createElement('div');
    overlay.className = 'review-overlay';
    overlay.innerHTML = `
      <div class="review-overlay-card">
        <h3>Review the extracted times</h3>
        <ul>
          <li>Times were extracted using AI and may contain errors</li>
          <li>Tap any cell in the table to edit it</li>
          <li>Check the details are correct</li>
        </ul>
        <button class="review-overlay-btn" id="reviewOverlayBtn">Got it</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
    overlay.querySelector('#reviewOverlayBtn').addEventListener('click', () => {
      overlay.classList.remove('visible');
      overlay.addEventListener('transitionend', () => overlay.remove());
      localStorage.setItem('iqamah-review-hint-dismissed', '1');
    });
  }

  // File validation
  function validateFile(file) {
    if (!file) return 'Please select a file.';
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(file.type)) return 'Please upload a JPG, PNG, WebP, or PDF file.';
    if (file.size > 10 * 1024 * 1024) return 'File is too large. Maximum size is 10MB.';
    return null;
  }

  function checkImageResolution(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const minSide = Math.min(img.naturalWidth, img.naturalHeight);
        resolve(minSide < 800 ? `Image resolution too low (${img.naturalWidth}x${img.naturalHeight}). Min 800px.` : null);
      };
      img.onerror = () => resolve('Could not read image file.');
      img.src = URL.createObjectURL(file);
    });
  }

  function showError(el, msg) { el.textContent = msg; el.classList.add('visible'); }
  function clearError(el) { el.classList.remove('visible'); }

  function resizeImage(file, maxSide = 2000) {
    return new Promise((resolve) => {
      if (file.type === 'application/pdf') { resolve(file); return; }
      const img = new Image();
      img.onload = () => {
        if (Math.max(img.naturalWidth, img.naturalHeight) <= maxSide) {
          resolve(file); return;
        }
        const ratio = maxSide / Math.max(img.naturalWidth, img.naturalHeight);
        const w = Math.round(img.naturalWidth * ratio);
        const h = Math.round(img.naturalHeight * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  }

  async function setFile(file) {
    const error = validateFile(file);
    if (error) { showError(uploadError, error); return; }
    if (file.type !== 'application/pdf') {
      const resError = await checkImageResolution(file);
      if (resError) { showError(uploadError, resError); return; }
    }
    clearError(uploadError);
    selectedFile = await resizeImage(file);
    const reader = new FileReader();
    reader.onload = async (e) => {
      imageDataUrl = e.target.result;
      if (file.type === 'application/pdf') {
        try {
          fileInfo.textContent = 'Converting PDF...';
          const pdfImageUrl = await pdfToImageDataUrl(imageDataUrl);
          imageDataUrl = pdfImageUrl;
          previewImg.src = pdfImageUrl;
          previewImg.style.display = '';
        } catch (err) {
          showError(uploadError, 'Could not render PDF. Try converting to an image first.');
          return;
        }
      } else {
        previewImg.src = imageDataUrl;
        previewImg.style.display = '';
      }
      fileInfo.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      imagePreview.classList.add('visible');
      uploadArea.style.display = 'none';
      extractBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  // Upload events
  uploadArea.addEventListener('click', () => fileInput.click());
  changeBtn.addEventListener('click', () => {
    selectedFile = null; imageDataUrl = null; fileInput.value = '';
    previewImg.style.display = ''; imagePreview.classList.remove('visible');
    uploadArea.style.display = ''; extractBtn.disabled = true;
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('dragover'); if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]); });

  // Extract
  let isExtracting = false;
  extractBtn.addEventListener('click', async () => {
    if (extractBtn.disabled || isExtracting) return;
    if (!USE_DUMMY_DATA && !turnstileToken) {
      clearError(extractError);
      const origText = extractBtn.textContent;
      extractBtn.textContent = 'Verifying...';
      extractBtn.disabled = true;
      for (let i = 0; i < 10 && !turnstileToken; i++) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (!turnstileToken) {
        if (window.turnstile && turnstileWidgetId !== null) {
          window.turnstile.reset(turnstileWidgetId);
        }
        showError(extractError, 'Security check failed to load. Please refresh page.');
        extractBtn.textContent = origText;
        extractBtn.disabled = false;
        return;
      }
      extractBtn.textContent = origText;
    }
    clearError(extractError);
    isExtracting = true;
    extractBtn.disabled = true;
    goToStep(2);

    try {
      let result;
      if (USE_DUMMY_DATA) {
        await new Promise(r => setTimeout(r, 1000));
        const dummyRows = [];
        const startDate = new Date(2026, 2, 20);
        const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
        for (let i = 0; i < 30; i++) {
          const d = new Date(startDate); d.setDate(d.getDate() + i);
          const dayStr = d.getDate() + ' ' + ['Jan','Feb','Mar','Apr'][d.getMonth()];
          dummyRows.push({
            date: dayStr, day: days[d.getDay() === 0 ? 6 : d.getDay() - 1],
            islamic_day: i + 1,
            sehri_ends: '', fajr_start: `${4}:${String(30 + Math.floor(i/3)).padStart(2,'0')}`,
            sunrise: `${6}:${String(10 - Math.floor(i/5)).padStart(2,'0')}`,
            zawal: '', zohr: `12:${String(20 + Math.floor(i/10)).padStart(2,'0')}`,
            asr: `${4}:${String(30 + Math.floor(i/3)).padStart(2,'0')}`,
            maghrib_iftari: `${7}:${String(20 + i).padStart(2,'0')}`,
            esha: `${9}:${String(10 + Math.floor(i/3)).padStart(2,'0')}`,
            fajr_jamaat: `${4}:${String(45 + Math.floor(i/3)).padStart(2,'0')}`,
            zohar_jamaat: '1:30', asr_jamaat: `${5}:${String(15 + Math.floor(i/3)).padStart(2,'0')}`,
            maghrib_jamaat: `${7}:${String(25 + i).padStart(2,'0')}`,
            esha_jamaat: `${9}:${String(30 + Math.floor(i/3)).padStart(2,'0')}`,
          });
        }
        result = { success: true, data: { mosque_name: masjidConfig.display_name, rows: dummyRows, year: 2026, month: 'March-April 2026', islamic_month: 'Shawwal 1447' } };
      } else {
        const formData = new FormData();
        formData.append('image', selectedFile);
        formData.append('action', 'update');
        formData.append('slug', masjidSlug);
        formData.append('cf-turnstile-response', turnstileToken);
        const resp = await fetch('/api/extract', { method: 'POST', body: formData });
        result = await resp.json();
        if (!resp.ok || !result.success) throw new Error(result.error || 'Extraction failed');
      }
      extractedData = result.data;

      const validationError = validateExtractedData(extractedData);
      if (validationError) throw new Error(validationError);

      if (window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId);
        turnstileToken = null;
      }
      populateReview();
      goToStep(3);
      showReviewOverlay();
      setTimeout(setupResizeObserver, 100);
    } catch (e) {
      showError(extractError, e.message);
      goToStep(1);
    } finally {
      isExtracting = false;
      extractBtn.disabled = !selectedFile;
    }
  });

  // Review table
  function getTableColumns(rows) {
    const has = (key) => rows && rows.some(r => r[key]);
    const cols = [
      { key: 'date', label: 'Date', width: '58px' },
      { key: 'day', label: 'Day', width: '40px' },
      { key: 'islamic_day', label: 'Hijri', width: '36px' },
    ];
    if (has('sehri_ends'))     cols.push({ key: 'sehri_ends', label: 'Sehri', width: '52px' });
    if (has('fajr_start'))     cols.push({ key: 'fajr_start', label: 'Fajr Start', width: '52px' });
    if (has('sunrise'))        cols.push({ key: 'sunrise', label: 'Sunrise', width: '52px' });
    if (has('zawal'))          cols.push({ key: 'zawal', label: 'Zawal', width: '52px' });
    if (has('zohr'))           cols.push({ key: 'zohr', label: 'Dhuhr', width: '52px' });
    if (has('asr'))            cols.push({ key: 'asr', label: 'Asr', width: '52px' });
    if (has('maghrib_iftari')) cols.push({ key: 'maghrib_iftari', label: 'Maghrib', width: '56px' });
    if (has('esha'))           cols.push({ key: 'esha', label: 'Esha', width: '52px' });
    if (has('fajr_jamaat'))    cols.push({ key: 'fajr_jamaat', label: 'Fajr J', width: '52px' });
    if (has('zohar_jamaat'))   cols.push({ key: 'zohar_jamaat', label: 'Dhuhr J', width: '52px' });
    if (has('asr_jamaat'))     cols.push({ key: 'asr_jamaat', label: 'Asr J', width: '52px' });
    if (has('maghrib_jamaat')) cols.push({ key: 'maghrib_jamaat', label: 'Maghrib J', width: '56px' });
    if (has('esha_jamaat'))    cols.push({ key: 'esha_jamaat', label: 'Esha J', width: '52px' });
    return cols;
  }

  function populateReview() {
    reviewImg.style.display = ''; reviewImg.src = imageDataUrl;
    document.querySelector('.zoom-hint').style.display = '';
    document.querySelector('#zoomControls').style.display = '';

    // Pre-populate metadata from existing config
    masjidNameInput.value = masjidConfig.display_name || '';
    const metaFields = [
      { sel: '#metaAddress', configKey: 'address', extractKey: 'address' },
      { sel: '#metaPhone', configKey: 'phone', extractKey: 'phone' },
      { sel: '#metaJummah', configKey: 'jummah_times', extractKey: 'jummah_times' },
      { sel: '#metaEid', configKey: 'eid_salah', extractKey: 'eid_salah' },
      { sel: '#metaFitrana', configKey: 'sadaqatul_fitr', extractKey: 'sadaqatul_fitr' },
      { sel: '#metaRadio', configKey: 'radio_frequency', extractKey: 'radio_frequency' },
      { sel: '#metaNotes', configKey: 'notes', extractKey: 'notes' },
    ];
    for (const f of metaFields) {
      const el = document.querySelector(f.sel);
      const originalVal = masjidConfig[f.configKey] || '';
      el.value = originalVal;
      // Override with extracted data where non-empty
      if (extractedData[f.extractKey]) {
        el.value = extractedData[f.extractKey];
      }
      // Highlight if value changed from original
      if (el.value !== originalVal && el.value !== '') {
        el.classList.add('field-changed');
      } else {
        el.classList.remove('field-changed');
      }
    }

    const cols = getTableColumns(extractedData.rows);
    reviewThead.innerHTML = '<tr><th>#</th>' + cols.map(c => `<th>${c.label}</th>`).join('') + '</tr>';
    reviewTbody.innerHTML = extractedData.rows.map((row, idx) => {
      return '<tr><td class="row-num">' + (idx + 1) + '</td>' +
        cols.map(col => {
          const val = row[col.key] != null ? String(row[col.key]) : '';
          return `<td><input type="text" data-row="${idx}" data-key="${col.key}" value="${escapeAttr(val)}" style="max-width:${col.width}"></td>`;
        }).join('') + '</tr>';
    }).join('');
  }

  function gatherReviewData() {
    const cols = getTableColumns(extractedData.rows);
    const allRowKeys = [
      'date', 'day', 'islamic_day', 'sehri_ends', 'fajr_start', 'sunrise',
      'zawal', 'zohr', 'asr', 'esha', 'fajr_jamaat', 'zohar_jamaat',
      'asr_jamaat', 'maghrib_iftari', 'maghrib_jamaat', 'esha_jamaat',
    ];
    const rows = extractedData.rows.map((row, idx) => {
      const newRow = {};
      cols.forEach(col => {
        const input = reviewTbody.querySelector(`input[data-row="${idx}"][data-key="${col.key}"]`);
        newRow[col.key] = input ? input.value : (row[col.key] || '');
      });
      allRowKeys.forEach(key => {
        if (!newRow.hasOwnProperty(key)) newRow[key] = row[key] || '';
      });
      if (newRow.islamic_day === '' || newRow.islamic_day === 'null') newRow.islamic_day = null;
      else if (!isNaN(newRow.islamic_day)) newRow.islamic_day = parseInt(newRow.islamic_day, 10);
      return newRow;
    });

    return {
      mosque_name: masjidConfig.display_name,
      address: document.querySelector('#metaAddress').value.trim(),
      phone: document.querySelector('#metaPhone').value.trim(),
      year: extractedData.year || null,
      month: extractedData.month || '',
      islamic_month: extractedData.islamic_month || '',
      jummah_times: document.querySelector('#metaJummah').value.trim(),
      eid_salah: document.querySelector('#metaEid').value.trim(),
      sadaqatul_fitr: document.querySelector('#metaFitrana').value.trim(),
      radio_frequency: document.querySelector('#metaRadio').value.trim(),
      notes: document.querySelector('#metaNotes').value.trim(),
      rows,
    };
  }

  // Submit
  submitBtn.addEventListener('click', async () => {
    if (isSubmitting) return;
    clearError(submitError);

    isSubmitting = true;
    submitBtn.disabled = true;
    submittingStatus.style.display = '';
    const data = gatherReviewData();

    if (USE_DUMMY_DATA) {
      await new Promise(r => setTimeout(r, 1000));
      confirmationText.textContent = `Timetable for ${masjidConfig.display_name} has been updated!`;
      const confirmNote = document.getElementById('confirmationNote');
      if (confirmNote) confirmNote.textContent = 'The updated times are live but will show a "Pending Review" tag until approved.';
      goToStep(4);
      isSubmitting = false;
      submitBtn.disabled = false;
      submittingStatus.style.display = 'none';
      return;
    }

    try {
      // Wait for turnstile token
      if (!turnstileToken) {
        for (let i = 0; i < 10 && !turnstileToken; i++) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (!turnstileToken) {
          if (window.turnstile && turnstileWidgetId !== null) {
            window.turnstile.reset(turnstileWidgetId);
          }
          throw new Error('Security check expired. Please scroll up and try again.');
        }
      }

      const payload = {
        data,
        slug: masjidSlug,
        image: imageDataUrl,
        'cf-turnstile-response': turnstileToken,
      };
      const resp = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await resp.json();

      if (!resp.ok || !result.success) throw new Error(result.error || 'Update failed');

      confirmationText.textContent = result.message || 'Timetable has been updated!';
      const confirmNote = document.getElementById('confirmationNote');
      if (confirmNote) confirmNote.textContent = 'The updated times are live but will show a "Pending Review" tag until approved.';
      goToStep(4);
    } catch (e) {
      showError(submitError, e.message);
    } finally {
      isSubmitting = false;
      submitBtn.disabled = false;
      submittingStatus.style.display = 'none';
    }
  });

  // Lightbox
  const lightbox = container.querySelector('#lightbox');
  const lightboxImg = container.querySelector('#lightboxImg');
  const lightboxClose = container.querySelector('#lightboxClose');

  reviewImg.addEventListener('click', () => {
    lightboxImg.src = reviewImg.src;
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  });
  lightboxClose.addEventListener('click', () => { lightbox.classList.remove('open'); document.body.style.overflow = ''; });
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) { lightbox.classList.remove('open'); document.body.style.overflow = ''; } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { lightbox.classList.remove('open'); document.body.style.overflow = ''; } });

  // Zoom controls
  let currentZoom = 1;
  function zoomImage(delta) {
    if (delta === 0) currentZoom = 1;
    else currentZoom = Math.min(4, Math.max(0.5, currentZoom + delta));
    reviewImg.style.width = (currentZoom * 100) + '%';
    document.querySelector('#zoomLevel').textContent = currentZoom + 'x';
  }
  container.querySelector('#zoomInBtn').addEventListener('click', () => zoomImage(0.5));
  container.querySelector('#zoomOutBtn').addEventListener('click', () => zoomImage(-0.5));
  container.querySelector('#zoomResetBtn').addEventListener('click', () => zoomImage(0));

  // Pinch-to-zoom
  function getTouchDist(e) {
    const t = e.touches;
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let panStartX = 0, panStartY = 0;
  let scrollLeftStart = 0, scrollTopStart = 0;
  let isPanning = false;

  const reviewImageContainer = container.querySelector('#reviewImageContainer');

  reviewImageContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      pinchStartDist = getTouchDist(e);
      pinchStartZoom = currentZoom;
    } else if (e.touches.length === 1 && currentZoom > 1) {
      isPanning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      scrollLeftStart = reviewImageContainer.scrollLeft;
      scrollTopStart = reviewImageContainer.scrollTop;
    }
  }, { passive: false });

  reviewImageContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = getTouchDist(e);
      const scale = dist / pinchStartDist;
      currentZoom = Math.min(4, Math.max(0.5, pinchStartZoom * scale));
      reviewImg.style.width = (currentZoom * 100) + '%';
      document.querySelector('#zoomLevel').textContent = currentZoom.toFixed(1) + 'x';
    } else if (e.touches.length === 1 && isPanning) {
      e.preventDefault();
      const dx = panStartX - e.touches[0].clientX;
      const dy = panStartY - e.touches[0].clientY;
      reviewImageContainer.scrollLeft = scrollLeftStart + dx;
      reviewImageContainer.scrollTop = scrollTopStart + dy;
    }
  }, { passive: false });

  reviewImageContainer.addEventListener('touchend', () => { isPanning = false; });

  // Sync image height with table on desktop
  function syncImageHeight() {
    const imgContainer = document.getElementById('reviewImageContainer');
    if (!imgContainer) return;
    if (window.innerWidth < 768) { imgContainer.style.maxHeight = ''; return; }
    const tableWrap = document.querySelector('.review-table-wrap');
    if (tableWrap) {
      const tableH = tableWrap.scrollHeight;
      if (tableH > 200) imgContainer.style.maxHeight = tableH + 'px';
    }
  }

  function setupResizeObserver() {
    const tableWrap = document.querySelector('.review-table-wrap');
    if (!tableWrap) return;
    if (_resizeObserver) _resizeObserver.disconnect();
    _resizeObserver = new ResizeObserver(() => syncImageHeight());
    _resizeObserver.observe(tableWrap);
    syncImageHeight();
  }

  _syncImageHeight = syncImageHeight;
  window.addEventListener('resize', syncImageHeight);
}
