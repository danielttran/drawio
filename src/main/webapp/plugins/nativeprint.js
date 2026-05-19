/**
 * Native Print — drawio plugin (host integration spec Layer 4: the Print
 * Native UI). Adds File > Native Print, bakes the diagram via the exporter,
 * talks to the broker over same-origin HTTP, and enforces the §3.7
 * DegradationNotice acknowledgment gate: the Print button stays disabled
 * until every notice is acknowledged, and any input change re-arms it
 * (INV-5: what the operator approves is what prints).
 */
(function waitForDraw(tries) {
  tries = tries || 0;
  // A raw <script> tag may execute before drawio defines window.Draw; poll.
  if (typeof window.Draw === 'undefined' || !window.Draw.loadPlugin) {
    if (tries > 200) {  // ~10s: surface a clear diagnostic, never silent
      console.error('[native-print] window.Draw.loadPlugin never appeared — ' +
        'plugin not loaded; File > Native Print will be absent.');
      return;
    }
    return void setTimeout(function () { waitForDraw(tries + 1); }, 50);
  }
  window.Draw.loadPlugin(function (ui) {
  'use strict';
  // Debug handle: lets the print contract be inspected from the console
  // (`window.nativePrintUi`). Harmless, no behavior change.
  try { window.nativePrintUi = ui; } catch (e) { /* sandboxed */ }
  console.log('[native-print] plugin attached — File > Native Print ready.');

  var RPC = '/native-print/rpc';

  function rpc(body) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  // ===========================================================================
  // WYSIWYG runtime self-check (the guarantee).
  //
  // Principle: the printout must equal what the operator sees, OR we say
  // loudly that we could not prove it — never a silent claim. The oracle is
  // drawio's OWN SVG export (the exact on-screen rendering, real browser
  // fonts/CSS/metrics). We rasterize that and the engine preview to the same
  // pixels and compare. Any failure to measure (no SVG API, canvas tainted by
  // HTML-label <foreignObject> — a genuine browser security limit) yields a
  // loud `WysiwygUnverified` notice that flows through the SAME acknowledgment
  // gate as bake degradations, so Print stays disabled until acknowledged.
  // Every step is try-guarded: this can only ADD a notice, never break print.
  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('image load failed')); };
      im.src = src;
    });
  }

  // drawio's authoritative SVG of exactly what is on the canvas. Signature
  // differs across builds, so feature-detect defensively and never guess.
  function drawioGroundTruthSvg() {
    try {
      var g = ui.editor.graph;
      if (!g || typeof g.getSvg !== 'function') return null;
      // (background, scale, border, nocrop, crisp, ignoreSelection)
      var svg = g.getSvg(null, 1, 0, true, null, true);
      if (!svg || typeof XMLSerializer === 'undefined') return null;
      return new XMLSerializer().serializeToString(svg);
    } catch (e) { return null; }
  }

  function rasterize(src, w, h) {
    return loadImage(src).then(function (im) {
      var c = document.createElement('canvas');
      c.width = Math.max(1, w | 0);
      c.height = Math.max(1, h | 0);
      var cx = c.getContext('2d');
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, c.width, c.height);
      // Fit the source into the page top-left at 1:1 aspect, matching the
      // exporter (diagram at origin, paper is whitespace around it).
      var sa = im.width / im.height;
      var dw = c.width, dh = c.width / sa;
      if (dh > c.height) { dh = c.height; dw = c.height * sa; }
      cx.drawImage(im, 0, 0, dw, dh);
      return cx.getImageData(0, 0, c.width, c.height);   // throws if tainted
    });
  }

  // Mean per-pixel luma difference over the inked region (ignores the shared
  // white page margin so a big sheet doesn't dilute the score).
  function compare(a, b) {
    var n = Math.min(a.data.length, b.data.length), inked = 0, acc = 0;
    for (var i = 0; i < n; i += 4) {
      var la = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
      var lb = (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3;
      if (la < 250 || lb < 250) { inked++; acc += Math.abs(la - lb); }
    }
    return inked ? acc / inked / 255 : 0;     // 0 == identical, 1 == inverted
  }

  // Resolve to a notice object (or null when a faithful match is proven).
  function verifyWysiwyg(previewSrc, pageW, pageH) {
    var svg = drawioGroundTruthSvg();
    if (svg == null) {
      return Promise.resolve({ kind: 'WysiwygUnverified', detail: { detail:
        'drawio SVG export unavailable in this build — printout could not be ' +
        'proven to match the screen.', cellId: '' } });
    }
    var ref = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    var W = Math.min(900, Math.max(1, pageW | 0));
    var H = Math.max(1, Math.round(W * (pageH / Math.max(1, pageW))));
    return Promise.all([rasterize(ref, W, H), rasterize(previewSrc, W, H)])
      .then(function (imgs) {
        var score = compare(imgs[0], imgs[1]);
        if (score <= 0.06) return null;        // proven faithful
        return { kind: 'WysiwygMismatch', detail: { detail:
          'Printout differs from the on-screen drawing by ' +
          Math.round(score * 100) + '% over the inked area. Review the ' +
          'preview before printing.', cellId: '' } };
      })
      .catch(function (e) {
        return { kind: 'WysiwygUnverified', detail: { detail:
          'WYSIWYG could not be measured (' + (e && e.message || 'reader ' +
          'blocked; HTML-label diagrams taint the canvas) — printout not ' +
          'proven to match the screen.'), cellId: '' } };
      });
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }

  function openDialog() {
    if (!window.NativePrintExporter) {
      ui.showError('Native Print', 'Exporter not loaded.', 'OK');
      return;
    }
    var contract;
    var exporterNotices = [];
    try {
      var baked = window.NativePrintExporter.buildResult
        ? window.NativePrintExporter.buildResult(ui.editor.graph)
        : { contract: window.NativePrintExporter.buildContract(ui.editor.graph),
            notices: [] };
      contract = baked.contract;
      exporterNotices = baked.notices || [];
    } catch (e) {
      ui.showError('Native Print', 'Bake failed: ' + e.message, 'OK');
      return;
    }

    var root = el('div', { style:
      'padding:10px;font-family:Helvetica,Arial;font-size:13px;width:720px;' +
      'max-height:560px;overflow:auto' });
    root.appendChild(el('h3', { style: 'margin:0 0 8px' },
      'Native Print'));
    root.appendChild(el('div', { style:
      'margin:0 0 8px;color:#777;font-size:11px' },
      'Preview is rendered at the selected stock DPI and uses the same native ' +
      'trace as print. Unsupported bake details are listed below.'));

    var rowStyle = 'display:flex;gap:8px;align-items:center;margin:6px 0';
    var pRow = el('div', { style: rowStyle });
    pRow.appendChild(el('label', { style: 'width:70px' }, 'Printer'));
    var printerSel = el('select', { style: 'flex:1' });
    pRow.appendChild(printerSel);
    root.appendChild(pRow);

    var sRow = el('div', { style: rowStyle });
    sRow.appendChild(el('label', { style: 'width:70px' }, 'Stock'));
    var stockSel = el('select', { style: 'flex:1' });
    sRow.appendChild(stockSel);
    root.appendChild(sRow);

    var cRow = el('div', { style: rowStyle });
    cRow.appendChild(el('label', { style: 'width:70px' }, 'Copies'));
    var copies = el('input', { type: 'number', min: '1', value: '1',
      style: 'width:60px' });
    cRow.appendChild(copies);
    root.appendChild(cRow);

    root.appendChild(el('div', { style:
      'margin:8px 0 4px;font-weight:bold' }, 'Preview (exactly what prints)'));
    var previewWrap = el('div', { style:
      'border:1px solid #ccc;min-height:160px;display:flex;' +
      'align-items:center;justify-content:center;background:#fafafa' });
    var previewImg = el('img', { style: 'max-width:100%;max-height:300px' });
    previewWrap.appendChild(previewImg);
    root.appendChild(previewWrap);

    var noticeBox = el('div', { style:
      'margin:8px 0;padding:6px;border:1px solid #e0a800;background:#fff8e1;' +
      'display:none' });
    root.appendChild(noticeBox);

    var status = el('div', { style: 'margin:8px 0;color:#555;min-height:18px' });
    root.appendChild(status);

    var btnRow = el('div', { style:
      'display:flex;gap:8px;justify-content:flex-end;margin-top:8px' });
    var cancelBtn = el('button', null, 'Cancel');
    var printBtn = el('button', null, 'Print');
    printBtn.disabled = true;
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(printBtn);
    root.appendChild(btnRow);

    var printers = [];
    var acks = [];      // one bool per notice; Print enabled when all true
    var wysiwygNotices = [];   // runtime self-check result (gates Print too)

    function selectedStock() {
      var p = printers[printerSel.selectedIndex];
      var stocks = p ? p.stocks || [] : [];
      for (var i = 0; i < stocks.length; i++) {
        if (stocks[i].id === stockSel.value) return stocks[i];
      }
      return stocks[0] || null;
    }

    function selectedDpi() {
      var s = selectedStock();
      return s && s.dpiX ? s.dpiX : 300;
    }

    // Selected stock size in px at 96/in (25400 microns per inch). The
    // contract page is baked to this so the diagram stays 1:1 and larger
    // paper just adds whitespace instead of scaling the diagram up.
    function paperPx() {
      var s = selectedStock();
      if (!s || !s.widthMicrons || !s.heightMicrons) return null;
      return {
        wPx: Math.round(s.widthMicrons / 25400 * 96),
        hPx: Math.round(s.heightMicrons / 25400 * 96)
      };
    }

    // The contract depends on the chosen paper, so re-bake on every paper
    // (and printer) change — not just re-preview the stale single bake.
    function rebake() {
      if (!window.NativePrintExporter.buildResult) return;
      var r = window.NativePrintExporter.buildResult(
        ui.editor.graph, paperPx());
      contract = r.contract;
      exporterNotices = r.notices || [];
    }

    function refreshGate() {
      var allAck = acks.length === 0 || acks.every(Boolean);
      printBtn.disabled = !allAck || !previewImg.getAttribute('src');
    }

    function showNotices(notices) {
      acks = [];
      noticeBox.innerHTML = '';
      var combined = (exporterNotices || [])
        .concat(notices || []).concat(wysiwygNotices || []);
      if (combined.length === 0) {
        noticeBox.style.display = 'none';
        refreshGate();
        return;
      }
      noticeBox.style.display = 'block';
      noticeBox.appendChild(el('div', { style: 'font-weight:bold' },
        'Output degradations — acknowledge each to enable Print:'));
      combined.forEach(function (n, i) {
        acks.push(false);
        var line = el('div', { style: 'margin:4px 0' });
        var cb = el('input', { type: 'checkbox' });
        cb.addEventListener('change', function () {
          acks[i] = cb.checked; refreshGate();
        });
        var txt = n.kind + (n.detail && n.detail.detail ?
          ' — ' + n.detail.detail : '');
        line.appendChild(cb);
        line.appendChild(el('span', { style: 'margin-left:6px' }, txt));
        noticeBox.appendChild(line);
      });
      refreshGate();
    }

    function rearm() {            // any input change invalidates prior approval
      previewImg.removeAttribute('src');
      printBtn.disabled = true;
    }

    function doPreview() {
      rearm();
      status.textContent = 'Rendering preview…';
      rpc({ action: 'preview', contract: contract,
        dpi: selectedDpi() }).then(function (m) {
        if (m.result !== 'PreviewResult') {
          status.textContent = 'Preview error: ' +
            (m.error || '') + ' ' + (m.detail || '');
          return;
        }
        status.textContent = '';
        var psrc = m.previewUrl + '&_=' + Date.now();
        previewImg.src = psrc;
        previewImg.onload = refreshGate;
        wysiwygNotices = [];
        showNotices(m.notices);
        // Prove (or loudly disprove) WYSIWYG against drawio's own rendering.
        // Resolves to a notice or null; either way it only ADDS to the gate.
        var pg = (contract && contract.document && contract.document.pages &&
          contract.document.pages[0] && contract.document.pages[0].size) ||
          { w: 800, h: 600 };
        status.textContent = 'Verifying WYSIWYG…';
        verifyWysiwyg(psrc, pg.w, pg.h).then(function (note) {
          status.textContent = note ? '' :
            'WYSIWYG verified: printout matches the screen.';
          wysiwygNotices = note ? [note] : [];
          showNotices(m.notices);
        }).catch(function () {
          status.textContent = '';
          wysiwygNotices = [{ kind: 'WysiwygUnverified', detail: { detail:
            'self-check errored — printout not proven to match the screen.',
            cellId: '' } }];
          showNotices(m.notices);
        });
      }).catch(function (e) {
        status.textContent = 'Preview failed: ' + e.message;
      });
    }

    printerSel.addEventListener('change', function () {
      var p = printers[printerSel.selectedIndex];
      stockSel.innerHTML = '';
      (p ? p.stocks : []).forEach(function (s) {
        var o = el('option', { value: s.id },
          s.name + ' (' + Math.round(s.widthMicrons / 1000) + '×' +
          Math.round(s.heightMicrons / 1000) + ' mm)');
        stockSel.appendChild(o);
      });
      if (p && p.defaultStockId) stockSel.value = p.defaultStockId;
      rearm(); rebake(); doPreview();
    });
    stockSel.addEventListener('change', function () {
      rearm(); rebake(); doPreview();
    });
    copies.addEventListener('change', rearm);

    cancelBtn.addEventListener('click', function () { ui.hideDialog(); });

    printBtn.addEventListener('click', function () {
      printBtn.disabled = true;
      status.textContent = 'Sending to printer…';
      rpc({ action: 'print', contract: contract,
        printerId: printers[printerSel.selectedIndex].id,
        stockId: stockSel.value,
        copies: parseInt(copies.value, 10) || 1 }).then(function (m) {
        if (m.result === 'PrintResult') {
          status.textContent = 'Printed. Job ' + m.jobId + '.';
        } else {
          status.textContent = 'Print failed: ' +
            (m.error || '') + ' ' + (m.detail || '');
          refreshGate();
        }
      }).catch(function (e) {
        status.textContent = 'Print failed: ' + e.message;
        refreshGate();
      });
    });

    ui.showDialog(root, 760, 620, true, false);

    status.textContent = 'Querying printers…';
    rpc({ action: 'capabilities' }).then(function (m) {
      if (m.result !== 'Capabilities') {
        status.textContent = 'Cannot reach print engine: ' +
          (m.detail || m.error || 'unknown');
        return;
      }
      printers = m.printers || [];
      printers.forEach(function (p) {
        printerSel.appendChild(el('option', { value: p.id }, p.name));
      });
      if (printers.length) {
        printerSel.selectedIndex = 0;
        printerSel.dispatchEvent(new Event('change'));
      } else {
        status.textContent = 'No printers found.';
      }
    }).catch(function (e) {
      status.textContent = 'Cannot reach print engine: ' + e.message;
    });
  }

  // File > Native Print (standard drawio plugin menu-wrap pattern).
  ui.actions.addAction('nativePrint', openDialog);
  ui.actions.get('nativePrint').label = 'Native Print';
  var fileMenu = ui.menus.get('file');
  if (fileMenu) {
    var base = fileMenu.funct;
    fileMenu.funct = function (menu, parent) {
      base.apply(this, arguments);
      ui.menus.addMenuItems(menu, ['-', 'nativePrint'], parent);
    };
  }
  });
})();
