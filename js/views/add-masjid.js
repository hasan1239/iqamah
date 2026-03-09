// Add Your Masjid — 3-step wizard (Upload → Review → Done)

let selectedFile = null;
let imageDataUrl = null;
let extractedData = null;

export function render(container) {
  selectedFile = null;
  imageDataUrl = null;
  extractedData = null;

  container.innerHTML = getWizardHTML();

  setupEventListeners(container);
}

export function destroy() {
  selectedFile = null;
  imageDataUrl = null;
  extractedData = null;
}

function getWizardHTML() {
  return `
    <div class="add-masjid-view">
      <header>
        <h1>Add Your Masjid</h1>
        <p class="add-subtitle">Upload a timetable file and we'll extract the prayer times automatically</p>
        <p class="add-subtitle ai-disclaimer" id="aiDisclaimer" style="display:none; font-size:0.8rem; margin-top:6px;">Times were extracted using AI and may contain errors. Please verify and fix any mistakes.</p>
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
            <div class="upload-area" id="uploadArea">
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
            <div>Extracting prayer times from file...</div>
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
              <div class="zoom-hint">Tap to zoom</div>
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
          <div class="form-group"><label for="masjidName">Masjid Name <span class="required">*</span></label><input type="text" id="masjidName" placeholder="e.g. Masjid Al-Noor" maxlength="100" autocomplete="off"></div>
          <div class="meta-grid">
            <div class="form-group"><label for="metaAddress">Address</label><input type="text" id="metaAddress" placeholder="Full address with postcode"></div>
            <div class="form-group"><label for="metaPhone">Phone</label><input type="text" id="metaPhone" placeholder="Phone number"></div>
            <div class="form-group"><label for="metaRadio">Radio Frequency</label><input type="text" id="metaRadio" placeholder="e.g. 454.3500"></div>
            <div class="form-group"><label for="metaEid">Eid Salah</label><input type="text" id="metaEid" placeholder="e.g. 7:30am & 9:00am"></div>
            <div class="form-group"><label for="metaFitrana">Sadaqatul Fitr</label><input type="text" id="metaFitrana" placeholder="e.g. £5 per person"></div>
            <div class="form-group"><label for="metaJummah">Jumu'ah Times</label><input type="text" id="metaJummah" placeholder="e.g. 12:30pm & 1:30pm"></div>
          </div>
          <div class="form-group" style="margin-top:12px;"><label for="metaNotes">Notes</label><textarea id="metaNotes" rows="2" placeholder="Any additional notes"></textarea></div>

          <div class="btn-row">
            <button class="btn btn-secondary" id="backToUploadBtn">Back</button>
            <button class="btn btn-secondary" id="downloadJsonBtn">Download JSON</button>
            <button class="btn btn-primary" id="submitBtn">Submit Masjid</button>
          </div>
          <div class="error-msg" id="submitError"></div>
        </div>
        <div class="card" id="submittingStatus" style="display:none; margin-top:16px;">
          <div class="status-msg"><div class="spinner"></div><div>Saving your masjid...</div></div>
        </div>
      </div>

      <!-- Step 4: Done -->
      <div class="step-panel" id="step4">
        <div class="card">
          <div class="confirmation">
            <div class="check-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p id="confirmationText">It will appear on the homepage shortly.</p>
            <a href="/" class="masjid-link" id="masjidLink" data-link>
              View your masjid page
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
            </a>
            <div style="margin-top:24px;"><a href="/" class="btn btn-secondary" data-link>Back to Home</a></div>
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
  const backToUploadBtn = container.querySelector('#backToUploadBtn');
  const downloadJsonBtn = container.querySelector('#downloadJsonBtn');
  const masjidLink = container.querySelector('#masjidLink');
  const confirmationText = container.querySelector('#confirmationText');
  const masjidNameInput = container.querySelector('#masjidName');
  const reviewImg = container.querySelector('#reviewImg');
  const reviewThead = container.querySelector('#reviewThead');
  const reviewTbody = container.querySelector('#reviewTbody');

  // Step navigation
  function goToStep(num) {
    container.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
    container.querySelector('#step' + num).classList.add('active');
    for (let s = 1; s <= 4; s++) {
      const stepEl = container.querySelector('#progStep' + s);
      stepEl.classList.remove('active', 'done');
      if (s < num) stepEl.classList.add('done');
      else if (s === num) stepEl.classList.add('active');
    }
    for (let c = 1; c <= 3; c++) {
      container.querySelector('#progConn' + c).classList.toggle('done', c < num);
    }
    container.querySelector('#aiDisclaimer').style.display = num === 3 ? '' : 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  async function setFile(file) {
    const error = validateFile(file);
    if (error) { showError(uploadError, error); return; }

    if (file.type !== 'application/pdf') {
      const resError = await checkImageResolution(file);
      if (resError) { showError(uploadError, resError); return; }
    }

    clearError(uploadError);
    selectedFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
      imageDataUrl = e.target.result;
      if (file.type === 'application/pdf') {
        previewImg.style.display = 'none';
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
  extractBtn.addEventListener('click', async () => {
    if (extractBtn.disabled) return;
    clearError(extractError);
    extractBtn.disabled = true;
    goToStep(2);

    const formData = new FormData();
    formData.append('image', selectedFile);

    try {
      const resp = await fetch('/api/extract', { method: 'POST', body: formData });
      const result = await resp.json();
      if (!resp.ok || !result.success) throw new Error(result.error || 'Extraction failed');
      extractedData = result.data;
      populateReview();
      goToStep(3);
    } catch (e) {
      showError(extractError, e.message);
      goToStep(1);
    } finally {
      extractBtn.disabled = !selectedFile;
    }
  });

  // Review table population
  function getTableColumns(rows) {
    const hasMaghribJamaat = rows && rows.some(r => r.maghrib_jamaat);
    const hasFajrStart = rows && rows.some(r => r.fajr_start);
    const hasZawal = rows && rows.some(r => r.zawal);
    return [
      { key: 'date', label: 'Date', width: '58px' },
      { key: 'day', label: 'Day', width: '40px' },
      { key: 'islamic_day', label: 'Hijri', width: '36px' },
      { key: 'sehri_ends', label: 'Sehri', width: '52px' },
      hasFajrStart ? { key: 'fajr_start', label: 'Fajr', width: '52px' } : null,
      { key: 'sunrise', label: 'Sunrise', width: '52px' },
      hasZawal ? { key: 'zawal', label: 'Zawal', width: '52px' } : null,
      { key: 'zohr', label: 'Dhuhr', width: '52px' },
      { key: 'asr', label: 'Asr', width: '52px' },
      hasMaghribJamaat ? { key: 'maghrib_iftari', label: 'Maghrib', width: '56px' } : null,
      { key: 'esha', label: 'Esha', width: '52px' },
      { key: 'fajr_jamaat', label: 'Fajr J', width: '52px' },
      { key: 'zohar_jamaat', label: 'Dhuhr J', width: '52px' },
      { key: 'asr_jamaat', label: 'Asr J', width: '52px' },
      hasMaghribJamaat ? { key: 'maghrib_jamaat', label: 'Maghrib J', width: '56px' } : { key: 'maghrib_iftari', label: 'Maghrib', width: '56px' },
      { key: 'esha_jamaat', label: 'Esha J', width: '52px' },
    ].filter(Boolean);
  }

  function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function populateReview() {
    // Handle PDF vs image
    const oldEmbed = container.querySelector('#reviewPdfEmbed');
    if (oldEmbed) oldEmbed.remove();

    if (selectedFile && selectedFile.type === 'application/pdf') {
      reviewImg.style.display = 'none';
      const embed = document.createElement('embed');
      embed.id = 'reviewPdfEmbed'; embed.src = imageDataUrl; embed.type = 'application/pdf';
      embed.style.width = '100%'; embed.style.height = '100%';
      embed.style.minHeight = window.innerWidth >= 768 ? '80vh' : '400px';
      reviewImg.parentNode.insertBefore(embed, reviewImg);
      container.querySelector('.zoom-hint').style.display = 'none';
      container.querySelector('#zoomControls').style.display = 'none';
    } else {
      reviewImg.style.display = ''; reviewImg.src = imageDataUrl;
      container.querySelector('.zoom-hint').style.display = '';
      container.querySelector('#zoomControls').style.display = '';
    }

    masjidNameInput.value = extractedData.mosque_name || '';
    container.querySelector('#metaAddress').value = extractedData.address || '';
    container.querySelector('#metaPhone').value = extractedData.phone || '';
    container.querySelector('#metaJummah').value = extractedData.jummah_times || '';
    container.querySelector('#metaEid').value = extractedData.eid_salah || '';
    container.querySelector('#metaFitrana').value = extractedData.sadaqatul_fitr || '';
    container.querySelector('#metaRadio').value = extractedData.radio_frequency || '';
    container.querySelector('#metaNotes').value = extractedData.notes || '';

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
    const rows = extractedData.rows.map((row, idx) => {
      const newRow = {};
      cols.forEach(col => {
        const input = reviewTbody.querySelector(`input[data-row="${idx}"][data-key="${col.key}"]`);
        newRow[col.key] = input ? input.value : (row[col.key] || '');
      });
      if (!newRow.hasOwnProperty('maghrib_jamaat')) newRow.maghrib_jamaat = row.maghrib_jamaat || '';
      if (!newRow.hasOwnProperty('fajr_start')) newRow.fajr_start = row.fajr_start || '';
      if (!newRow.hasOwnProperty('zawal')) newRow.zawal = row.zawal || '';
      if (newRow.islamic_day === '' || newRow.islamic_day === 'null') newRow.islamic_day = null;
      else if (!isNaN(newRow.islamic_day)) newRow.islamic_day = parseInt(newRow.islamic_day, 10);
      return newRow;
    });

    return {
      mosque_name: masjidNameInput.value.trim(),
      suggested_slug: extractedData.suggested_slug || '',
      address: container.querySelector('#metaAddress').value.trim(),
      phone: container.querySelector('#metaPhone').value.trim(),
      month: extractedData.month || '',
      islamic_month: extractedData.islamic_month || '',
      jummah_times: container.querySelector('#metaJummah').value.trim(),
      eid_salah: container.querySelector('#metaEid').value.trim(),
      sadaqatul_fitr: container.querySelector('#metaFitrana').value.trim(),
      radio_frequency: container.querySelector('#metaRadio').value.trim(),
      notes: container.querySelector('#metaNotes').value.trim(),
      rows,
    };
  }

  // Submit
  submitBtn.addEventListener('click', async () => {
    clearError(submitError);
    submitBtn.disabled = true;
    submittingStatus.style.display = '';
    const data = gatherReviewData();

    try {
      const resp = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      const result = await resp.json();
      if (!resp.ok || !result.success) throw new Error(result.error || 'Submission failed');
      confirmationText.textContent = result.message || 'Your masjid has been added!';
      masjidLink.href = result.url || '/';
      masjidLink.innerHTML = 'View ' + data.mosque_name;
      goToStep(4);
    } catch (e) {
      showError(submitError, e.message);
    } finally {
      submitBtn.disabled = false;
      submittingStatus.style.display = 'none';
    }
  });

  backToUploadBtn.addEventListener('click', () => goToStep(1));

  downloadJsonBtn.addEventListener('click', () => {
    if (!extractedData) return;
    const blob = new Blob([JSON.stringify(extractedData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (extractedData.suggested_slug || 'extraction') + '.json'; a.click();
    URL.revokeObjectURL(a.href);
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
    container.querySelector('#zoomLevel').textContent = currentZoom + 'x';
  }
  container.querySelector('#zoomInBtn').addEventListener('click', () => zoomImage(0.5));
  container.querySelector('#zoomOutBtn').addEventListener('click', () => zoomImage(-0.5));
  container.querySelector('#zoomResetBtn').addEventListener('click', () => zoomImage(0));
}
