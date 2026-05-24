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

    // Custom-stock row (v2.0 §5: DMPAPER_USER + explicit physical dims, never
    // a named-paper enum). Hidden unless the "Custom..." stock option is
    // selected. Width/Height are entered in millimetres; we wire-encode them
    // as microns into the synthetic stockId "custom:WuxHu" that the host
    // parser (host/custom_stock.cpp) and DEVMODE merge consume.
    var customRow = el('div', { style: rowStyle + ';display:none' });
    customRow.appendChild(el('label', { style: 'width:70px' }, 'Custom'));
    var customW = el('input', { type: 'number', min: '1', step: '0.1',
      style: 'width:80px' });
    var customH = el('input', { type: 'number', min: '1', step: '0.1',
      style: 'width:80px' });
    customRow.appendChild(customW);
    customRow.appendChild(el('span', null, ' × '));
    customRow.appendChild(customH);
    customRow.appendChild(el('span', null, ' mm'));
    root.appendChild(customRow);

    // Synthesise the stockId for the currently-selected stock. "custom" is a
    // sentinel dropdown value; for it we emit "custom:WuxHu" (microns) from
    // the W/H inputs. Returns null if the inputs are invalid -- the caller
    // gates Print on that.
    // Max custom-stock dimension the host parser accepts:
    // SHRT_MAX (32767) tenths-of-mm == 3276.7 mm (~3.27 m), the largest
    // physical paper DEVMODE.dmPaperWidth/Length can express. Anything
    // larger is refused upfront with a loud UI message instead of being
    // sent and rejected at the engine boundary.
    var CUSTOM_STOCK_MAX_MM = 3276.7;

    function effectiveStockId() {
      if (stockSel.value !== 'custom') return stockSel.value;
      var wmm = parseFloat(customW.value);
      var hmm = parseFloat(customH.value);
      if (!(wmm > 0) || !(hmm > 0)) return null;
      if (wmm > CUSTOM_STOCK_MAX_MM || hmm > CUSTOM_STOCK_MAX_MM) return null;
      var wu = Math.round(wmm * 1000);
      var hu = Math.round(hmm * 1000);
      return 'custom:' + wu + 'x' + hu;
    }

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

    function selectedStock() {
      var p = printers[printerSel.selectedIndex];
      var stocks = p ? p.stocks || [] : [];
      // Custom: synthesise a StockInfo-shaped object from the W/H inputs so
      // the rest of the dialog (paperPx, selectedDpi) works unchanged.
      if (stockSel.value === 'custom') {
        var wmm = parseFloat(customW.value);
        var hmm = parseFloat(customH.value);
        if (!(wmm > 0) || !(hmm > 0)) return null;
        var refDpi = stocks[0] && stocks[0].dpiX ? stocks[0].dpiX : 300;
        return {
          id: effectiveStockId(),
          name: 'Custom (' + wmm + ' × ' + hmm + ' mm)',
          widthMicrons: Math.round(wmm * 1000),
          heightMicrons: Math.round(hmm * 1000),
          dpiX: refDpi,
          dpiY: refDpi
        };
      }
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
    // Returns false if the bake hard-failed (e.g. NativePrintFatal): the
    // contract is cleared, the operator is told loudly, and the caller must
    // NOT preview/print a stale or partial page (WYSIWYG-or-loud).
    // Returns a Promise<bool>. First resolves external (http) image URLs into
    // embedded data URIs via a bake-time fetch (so URL-referenced images print
    // their real pixels instead of a placeholder notice), then bakes. The
    // resolve step is best-effort: any failure yields an empty map and the bake
    // proceeds (unfetchable images stay loudly noticed — never silently wrong).
    function rebake() {
      var ex = window.NativePrintExporter;
      if (!ex || !ex.buildResult) return Promise.resolve(true);
      var resolve = ex.embedExternalImages
        ? ex.embedExternalImages(ui.editor.graph).catch(function () { return {}; })
        : Promise.resolve({});
      return resolve.then(function (resolvedImages) {
        try {
          var r = ex.buildResult(ui.editor.graph, paperPx(),
            { resolvedImages: resolvedImages });
          contract = r.contract;
          exporterNotices = r.notices || [];
          return true;
        } catch (e) {
          contract = null;
          exporterNotices = [];
          rearm();
          status.textContent = 'Bake failed: ' + e.message;
          ui.showError('Native Print',
            'Bake failed — nothing was printed.\n' + e.message, 'OK');
          return false;
        }
      });
    }

    function refreshGate() {
      var allAck = acks.length === 0 || acks.every(Boolean);
      printBtn.disabled = !allAck || !previewImg.getAttribute('src');
    }

    // Severity is owned by the exporter (single tested source of truth) so the
    // dialog and the bake never disagree on what blocks Print. Unknown kinds
    // (or a missing exporter) fail safe to 'degradation' — better to ask for
    // an ack than to silently let an unrecognised notice through.
    function severityOf(kind) {
      var ex = window.NativePrintExporter;
      return (ex && typeof ex.noticeSeverity === 'function')
        ? ex.noticeSeverity(kind) : 'degradation';
    }

    function noticeText(n) {
      return n.kind + (n.detail && n.detail.detail ? ' — ' + n.detail.detail : '');
    }

    // The Print gate blocks ONLY on degradations (real fidelity loss the
    // operator must consciously approve). Informational / success notices
    // (faithful external SVG render, expected edge-clip to the chosen paper)
    // are shown for traceability but never require an acknowledgment — a
    // full-fidelity WYSIWYG print should not nag on every run.
    function showNotices(notices) {
      acks = [];
      noticeBox.innerHTML = '';
      var combined = (exporterNotices || []).concat(notices || []);
      var degradations = [], infos = [];
      combined.forEach(function (n) {
        (severityOf(n.kind) === 'info' ? infos : degradations).push(n);
      });
      if (combined.length === 0) {
        noticeBox.style.display = 'none';
        refreshGate();
        return;
      }
      noticeBox.style.display = 'block';
      // Amber "needs approval" accent only when there is something to ack;
      // an info-only run (e.g. a faithful render) gets a calm neutral accent.
      noticeBox.style.borderColor = degradations.length ? '#e0a800' : '#bcd6e6';
      noticeBox.style.background = degradations.length ? '#fff8e1' : '#eef5fb';

      if (degradations.length) {
        noticeBox.appendChild(el('div', { style: 'font-weight:bold' },
          'Output degradations — acknowledge each to enable Print:'));
        degradations.forEach(function (n) {
          var idx = acks.length;       // index BEFORE push == this ack's slot
          acks.push(false);
          var line = el('div', { style: 'margin:4px 0' });
          var cb = el('input', { type: 'checkbox' });
          cb.addEventListener('change', function () {
            acks[idx] = cb.checked; refreshGate();
          });
          line.appendChild(cb);
          line.appendChild(el('span', { style: 'margin-left:6px' }, noticeText(n)));
          noticeBox.appendChild(line);
        });
      }

      if (infos.length) {
        noticeBox.appendChild(el('div', { style: 'font-weight:bold' +
          (degradations.length ? ';margin-top:8px' : '') },
          'Notes (no action needed):'));
        infos.forEach(function (n) {
          var line = el('div', { style: 'margin:4px 0;color:#456' });
          line.appendChild(el('span', null, noticeText(n)));
          noticeBox.appendChild(line);
        });
      }

      refreshGate();
    }

    function rearm() {            // any input change invalidates prior approval
      previewImg.removeAttribute('src');
      printBtn.disabled = true;
    }

    function doPreview() {
      rearm();
      if (!contract) return;   // bake hard-failed; never preview stale output
      status.textContent = 'Rendering preview…';
      rpc({ action: 'preview', contract: contract,
        dpi: selectedDpi() }).then(function (m) {
        if (m.result !== 'PreviewResult') {
          status.textContent = 'Preview error: ' +
            (m.error || '') + ' ' + (m.detail || '');
          return;
        }
        status.textContent = '';
        previewImg.src = m.previewUrl + '&_=' + Date.now();
        previewImg.onload = refreshGate;
        showNotices(m.notices);
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
      // Always offer Custom... so any printer can drive DMPAPER_USER.
      stockSel.appendChild(el('option', { value: 'custom' },
        'Custom… (set physical dimensions)'));
      if (p && p.defaultStockId) stockSel.value = p.defaultStockId;
      customRow.style.display = (stockSel.value === 'custom') ? '' : 'none';
      rearm(); rebake().then(function (ok) { if (ok) doPreview(); });
    });
    stockSel.addEventListener('change', function () {
      customRow.style.display = (stockSel.value === 'custom') ? '' : 'none';
      rearm(); rebake().then(function (ok) { if (ok) doPreview(); });
    });
    function onCustomDim() { rearm(); rebake().then(function (ok) { if (ok) doPreview(); }); }
    customW.addEventListener('change', onCustomDim);
    customH.addEventListener('change', onCustomDim);
    copies.addEventListener('change', rearm);

    cancelBtn.addEventListener('click', function () { ui.hideDialog(); });

    printBtn.addEventListener('click', function () {
      var sid = effectiveStockId();
      if (sid == null) {
        var wmm = parseFloat(customW.value);
        var hmm = parseFloat(customH.value);
        if (!(wmm > 0) || !(hmm > 0)) {
          status.textContent = 'Custom stock requires positive W and H.';
        } else {
          status.textContent = 'Custom stock W and H must each be ≤ ' +
            CUSTOM_STOCK_MAX_MM + ' mm (DEVMODE limit).';
        }
        return;
      }
      printBtn.disabled = true;
      status.textContent = 'Sending to printer…';
      rpc({ action: 'print', contract: contract,
        printerId: printers[printerSel.selectedIndex].id,
        stockId: sid,
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
