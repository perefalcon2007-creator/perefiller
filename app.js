const $ = s => document.querySelector(s);
const { PDFDocument, rgb, StandardFonts } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Annotation coordinates are stored in PDF points, measured from the page's top-left corner.
// Form-field values are stored by field name in S.fields, with their type in S.fieldTypes.
const S = { bytes: null, pdf: null, pages: [], annots: [], tool: 'select', selected: null,
            history: [], nextId: 1, pending: null, drag: null, file: 'document-filled.pdf',
            fields: {}, fieldTypes: {} };
const DRAG = new Set(['select', 'highlight', 'redact', 'shape', 'draw']);
const COLORS = { highlight: '#ffeb3b', redact: '#000000', shape: '#e53935', draw: '#1a237e',
                 text: '#000000', check: '#1a237e', cross: '#c62828', date: '#000000' };
const MARK = {
  check: c => `<svg viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M1 5 L4 8.5 L9 1" fill="none" stroke="${c}" stroke-width="1.2"/></svg>`,
  cross: c => `<svg viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M1 1 L9 9 M9 1 L1 9" fill="none" stroke="${c}" stroke-width="1.2"/></svg>`,
};

const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const hex = h => rgb(...[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const textWidth = (t, size) => t.length * size * 0.55;
const find = id => S.annots.find(a => a.id === id);
const snap = () => { S.history.push(JSON.stringify(S.annots)); if (S.history.length > 100) S.history.shift(); };
const add = a => { a.id = S.nextId++; S.annots.push(a); drawAll(); return a; };

// ---------- Opening and rendering ----------
$('#open').onclick = () => $('#pdfIn').click();
$('#pdfIn').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  S.file = f.name.replace(/\.pdf$/i, '') + '-filled.pdf';
  S.bytes = new Uint8Array(await f.arrayBuffer());
  S.pdf = await pdfjsLib.getDocument({ data: S.bytes.slice(0) }).promise;
  S.annots = []; S.history = []; S.selected = null; S.fields = {}; S.fieldTypes = {};
  await renderDoc();
};

async function renderDoc() {
  const box = $('#pages');
  box.innerHTML = '';
  S.pages = [];
  const width = Math.min(box.clientWidth - 16, 900);
  for (let i = 1; i <= S.pdf.numPages; i++) {
    const page = await S.pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const vp = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = vp.width + 'px';
    wrap.style.height = vp.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    wrap.append(canvas, overlay);
    box.append(wrap);
    await addFormFields(page, vp, wrap);

    const p = { index: i - 1, scale, overlay };
    S.pages.push(p);
    overlay.addEventListener('pointerdown', e => down(e, p));
    overlay.addEventListener('pointermove', e => move(e, p));
    overlay.addEventListener('pointerup', e => up(e, p));
    overlay.addEventListener('pointercancel', e => up(e, p));
  }
  drawAll();
}

// Existing fillable fields in the PDF (AcroForm widgets) become real inputs on top of the page.
async function addFormFields(page, vp, wrap) {
  const annots = await page.getAnnotations();
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  wrap.append(layer);

  for (const a of annots) {
    if (a.subtype !== 'Widget' || !a.fieldName) continue;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    const name = a.fieldName;
    S.fieldTypes[name] = a.fieldType;
    let el;

    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      el.value = S.fields[name] ?? a.fieldValue ?? '';
      el.oninput = () => setField(name, el.value);
    } else if (a.fieldType === 'Btn') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = name in S.fields ? S.fields[name] : (!!a.fieldValue && a.fieldValue !== 'Off');
      el.onchange = () => setField(name, el.checked);
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      (a.options || []).forEach(o => el.append(new Option(o.displayValue ?? o.exportValue, o.exportValue)));
      el.value = S.fields[name] ?? a.fieldValue ?? '';
      el.onchange = () => setField(name, el.value);
    } else {
      continue;
    }

    el.dataset.field = name;
    el.className = 'fld';
    el.style.cssText += `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;` +
      'pointer-events:auto;box-sizing:border-box;border:1px solid rgba(233,169,74,.7);' +
      'background:rgba(233,169,74,.14);border-radius:2px;font:12px Helvetica,Arial,sans-serif;' +
      'color:#000;padding:0 3px;outline:none;margin:0;';
    if (a.fieldType === 'Btn') el.style.cssText += 'accent-color:#E9A94A;';
    layer.append(el);
  }
}

// Keep every widget that shares a name in sync.
function setField(name, value) {
  S.fields[name] = value;
  document.querySelectorAll(`[data-field="${CSS.escape(name)}"]`).forEach(el => {
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
  });
}

// Re-render only when the width changes (rotation, window resize), never when the
// phone keyboard opens: the keyboard shrinks the height, and a re-render would
// destroy the field being typed into.
let resizeTimer, lastWidth = innerWidth;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!S.pdf || Math.abs(innerWidth - lastWidth) < 40) return;
    if (document.activeElement && document.activeElement.classList.contains('fld')) return;
    lastWidth = innerWidth;
    renderDoc();
  }, 300);
});

function drawAll() {
  S.pages.forEach(p => p.overlay.innerHTML = '');
  for (const a of S.annots) {
    const p = S.pages[a.page];
    if (!p) continue;
    const el = render(a, p.scale);
    if (S.selected === a.id) el.classList.add('sel');
    p.overlay.append(el);
  }
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
  document.body.classList.toggle('drag', DRAG.has(S.tool));
}

function render(a, s) {
  const el = document.createElement('div');
  el.className = 'annot ' + a.type;
  el.dataset.id = a.id;
  Object.assign(el.style, { left: a.x * s + 'px', top: a.y * s + 'px', width: a.w * s + 'px', height: a.h * s + 'px' });
  switch (a.type) {
    case 'text': case 'date':
      el.textContent = a.text; el.style.fontSize = a.size * s + 'px';
      el.style.lineHeight = '1'; el.style.color = a.color; break;
    case 'check': case 'cross': el.innerHTML = MARK[a.type](a.color); break;
    case 'image': { const img = new Image(); img.src = a.data; el.append(img); break; }
    case 'draw':
      el.innerHTML = `<svg viewBox="0 0 ${a.w} ${a.h}" preserveAspectRatio="none"><polyline fill="none" stroke="${a.color}" stroke-width="${a.size}" stroke-linecap="round" stroke-linejoin="round" points="${a.pts.map(q => q.join(',')).join(' ')}"/></svg>`;
      break;
    case 'highlight': el.style.background = 'rgba(255,235,59,.4)'; break;
    case 'redact': el.style.background = '#000'; break;
    case 'shape': el.style.border = `2px solid ${a.color}`; break;
  }
  return el;
}

// ---------- Pointer handling ----------
const pt = (e, p) => { const r = p.overlay.getBoundingClientRect(); return { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale }; };
const bbox = pts => {
  const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(Math.max(...xs) - x, 1), h: Math.max(Math.max(...ys) - y, 1) };
};

function down(e, p) {
  if (e.target.closest('.fld')) return;   // let form fields handle their own taps
  const q = pt(e, p);
  const hit = e.target.closest('.annot');
  const a = hit && find(+hit.dataset.id);

  if (S.tool === 'erase') {
    if (a) { snap(); S.annots = S.annots.filter(x => x !== a); drawAll(); }
    return;
  }
  if (S.tool === 'select') {
    S.selected = a ? a.id : null;
    if (a) {
      snap();
      S.drag = { mode: 'move', a, start: q, ox: a.x, oy: a.y, p };
      p.overlay.setPointerCapture(e.pointerId);
    }
    drawAll();
    return;
  }
  if (['highlight', 'redact', 'shape', 'draw'].includes(S.tool)) {
    S.drag = { mode: S.tool === 'draw' ? 'draw' : 'rect', tool: S.tool, p, start: q, cur: q, pts: [q] };
    p.overlay.setPointerCapture(e.pointerId);
    return;
  }
  place(S.tool, q, p);
}

function move(e, p) {
  const d = S.drag;
  if (!d || d.p !== p) return;
  const q = pt(e, p);
  if (d.mode === 'move') { d.a.x = d.ox + q.x - d.start.x; d.a.y = d.oy + q.y - d.start.y; drawAll(); return; }
  if (d.mode === 'rect') { d.cur = q; drawAll(); p.overlay.append(preview(d)); }
  if (d.mode === 'draw') { d.pts.push(q); drawAll(); p.overlay.append(preview(d)); }
}

function up(e, p) {
  const d = S.drag;
  if (!d || d.p !== p) return;
  S.drag = null;
  if (d.mode === 'move') return drawAll();
  if (d.mode === 'rect') {
    const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
    if (w < 3 && h < 3) return drawAll();
    snap();
    add({ type: d.tool, page: p.index, x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w, h, color: COLORS[d.tool] });
  }
  if (d.mode === 'draw') {
    if (d.pts.length < 2) return drawAll();
    const b = bbox(d.pts);
    snap();
    add({ type: 'draw', page: p.index, ...b, pts: d.pts.map(q => [q.x - b.x, q.y - b.y]), color: COLORS.draw, size: 2 });
  }
}

function preview(d) {
  if (d.mode === 'rect') {
    return render({ type: d.tool, x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y),
                    w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y), color: COLORS[d.tool] }, d.p.scale);
  }
  const b = bbox(d.pts);
  return render({ type: 'draw', ...b, pts: d.pts.map(q => [q.x - b.x, q.y - b.y]), color: COLORS.draw, size: 2 }, d.p.scale);
}

// ---------- Placing items (tap tools) ----------
function place(tool, q, p) {
  const page = p.index;
  if (tool === 'text') {
    const t = prompt('Text to add:');
    if (!t) return;
    snap(); add({ type: 'text', page, x: q.x, y: q.y, w: textWidth(t, 12), h: 14, size: 12, text: t, color: '#000000' });
  } else if (tool === 'check' || tool === 'cross') {
    snap(); add({ type: tool, page, x: q.x - 7, y: q.y - 7, w: 14, h: 14, color: COLORS[tool] });
  } else if (tool === 'date') {
    const t = new Date().toLocaleDateString('en-US');
    snap(); add({ type: 'date', page, x: q.x, y: q.y, w: textWidth(t, 12), h: 14, size: 12, text: t, color: '#000000' });
  } else if (tool === 'sign' || tool === 'initials') {
    const key = tool === 'sign' ? 'sig' : 'ini';
    S.pending = { tool, page, q };
    const saved = store.get(key);
    if (!saved) return openPad(key);
    placeImage(saved, tool, page, q);
  } else if (tool === 'image') {
    S.pending = { tool, page, q };
    $('#imgIn').click();
  }
}

function placeImage(saved, tool, page, q) {
  const w = tool === 'sign' ? 160 : 70;
  snap();
  add({ type: 'image', page, x: q.x, y: q.y, w, h: w * saved.ratio, data: saved.data });
}

$('#imgIn').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !S.pending) return;
  const { page, q } = S.pending; S.pending = null;
  const url = URL.createObjectURL(f);
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = url; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  const data = c.toDataURL('image/png');
  const w = 150, h = w * img.naturalHeight / img.naturalWidth;
  snap(); add({ type: 'image', page, x: q.x, y: q.y, w, h, data });
};

// ---------- Signature / initials pad ----------
const padC = $('#padC'), pc = padC.getContext('2d');
let padKey = null, padDrawing = false, last = null;
padC.width = 600; padC.height = 240;
pc.lineWidth = 5; pc.lineCap = 'round'; pc.lineJoin = 'round'; pc.strokeStyle = '#000';

function openPad(key) {
  padKey = key;
  $('#padTitle').textContent = key === 'sig' ? 'Draw your signature' : 'Draw your initials';
  pc.clearRect(0, 0, padC.width, padC.height);
  $('#pad').showModal();
}
const padPt = e => { const r = padC.getBoundingClientRect(); return { x: (e.clientX - r.left) * padC.width / r.width, y: (e.clientY - r.top) * padC.height / r.height }; };
padC.addEventListener('pointerdown', e => { padDrawing = true; last = padPt(e); padC.setPointerCapture(e.pointerId); });
padC.addEventListener('pointermove', e => {
  if (!padDrawing) return;
  const q = padPt(e);
  pc.beginPath(); pc.moveTo(last.x, last.y); pc.lineTo(q.x, q.y); pc.stroke();
  last = q;
});
padC.addEventListener('pointerup', () => padDrawing = false);
$('#padClear').onclick = () => pc.clearRect(0, 0, padC.width, padC.height);
$('#padCancel').onclick = () => { S.pending = null; $('#pad').close(); };
$('#padSave').onclick = () => {
  const trimmed = trimCanvas(padC);
  $('#pad').close();
  if (!trimmed) { S.pending = null; return; }
  store.set(padKey, trimmed);
  if (S.pending) { const { tool, page, q } = S.pending; S.pending = null; placeImage(trimmed, tool, page, q); }
};

function trimCanvas(c) {
  const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 10, tw = x1 - x0 + 1 + pad * 2, th = y1 - y0 + 1 + pad * 2;
  const out = document.createElement('canvas');
  out.width = tw; out.height = th;
  out.getContext('2d').drawImage(c, x0 - pad, y0 - pad, tw, th, 0, 0, tw, th);
  return { data: out.toDataURL('image/png'), ratio: th / tw };
}

// ---------- Tools, undo ----------
document.querySelectorAll('#tools button').forEach(b => b.onclick = () => {
  S.tool = b.dataset.tool; S.selected = null; S.drag = null; drawAll();
});
$('#undo').onclick = () => {
  if (!S.history.length) return;
  S.annots = JSON.parse(S.history.pop()); S.selected = null; drawAll();
};

// ---------- Export: write annotations and form values into the PDF ----------
async function build() {
  const doc = await PDFDocument.load(S.bytes.slice(0), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Fill existing form fields the user changed.
  if (Object.keys(S.fields).length) {
    try {
      const form = doc.getForm();
      for (const [name, v] of Object.entries(S.fields)) {
        try {
          const t = S.fieldTypes[name];
          if (t === 'Btn') v ? form.getCheckBox(name).check() : form.getCheckBox(name).uncheck();
          else if (t === 'Ch') form.getDropdown(name).select(v);
          else form.getTextField(name).setText(v);
        } catch (err) { console.warn('Field skipped:', name, err.message); }
      }
      try { form.updateFieldAppearances(font); } catch { /* some forms regenerate on open */ }
    } catch (err) { console.warn('No form:', err.message); }
  }

  const pages = doc.getPages();
  const embedded = new Map();

  for (const a of S.annots) {
    const page = pages[a.page];
    if (!page) continue;
    const H = page.getHeight();
    const y0 = H - a.y - a.h;          // bottom edge of the box, PDF coordinates
    const col = hex(a.color);

    if (a.type === 'text' || a.type === 'date') {
      page.drawText(a.text, { x: a.x, y: H - a.y - a.size * 0.8, size: a.size, font, color: col });
    } else if (a.type === 'check' || a.type === 'cross') {
      const L = (x1, y1, x2, y2) => page.drawLine({
        start: { x: a.x + x1 / 10 * a.w, y: H - a.y - y1 / 10 * a.h },
        end:   { x: a.x + x2 / 10 * a.w, y: H - a.y - y2 / 10 * a.h },
        thickness: 1.5, color: col });
      if (a.type === 'check') { L(1, 5, 4, 8.5); L(4, 8.5, 9, 1); }
      else { L(1, 1, 9, 9); L(9, 1, 1, 9); }
    } else if (a.type === 'highlight') {
      page.drawRectangle({ x: a.x, y: y0, width: a.w, height: a.h, color: rgb(1, 0.92, 0.23), opacity: 0.4, borderWidth: 0 });
    } else if (a.type === 'redact') {
      page.drawRectangle({ x: a.x, y: y0, width: a.w, height: a.h, color: rgb(0, 0, 0), borderWidth: 0 });
    } else if (a.type === 'shape') {
      page.drawRectangle({ x: a.x, y: y0, width: a.w, height: a.h, borderColor: col, borderWidth: 2 });
    } else if (a.type === 'draw') {
      for (let i = 1; i < a.pts.length; i++) {
        const [x1, y1] = a.pts[i - 1], [x2, y2] = a.pts[i];
        page.drawLine({ start: { x: a.x + x1, y: H - a.y - y1 }, end: { x: a.x + x2, y: H - a.y - y2 }, thickness: a.size, color: col });
      }
    } else if (a.type === 'image') {
      if (!embedded.has(a.data)) {
        const bin = Uint8Array.from(atob(a.data.split(',')[1]), ch => ch.charCodeAt(0));
        embedded.set(a.data, await doc.embedPng(bin));
      }
      page.drawImage(embedded.get(a.data), { x: a.x, y: y0, width: a.w, height: a.h });
    }
  }
  return doc.save();
}

async function outputBlob() {
  return new Blob([await build()], { type: 'application/pdf' });
}

$('#save').onclick = async () => {
  if (!S.pdf) return alert('Open a PDF first.');
  const url = URL.createObjectURL(await outputBlob());
  const a = document.createElement('a');
  a.href = url; a.download = S.file; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

$('#share').onclick = async () => {
  if (!S.pdf) return alert('Open a PDF first.');
  const file = new File([await outputBlob()], S.file, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: S.file }); } catch { /* cancelled */ }
  } else {
    $('#save').click();
  }
};

// ---------- Offline support ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
