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
    function effectiveStockId() {
      if (stockSel.value !== 'custom') return stockSel.value;
      var wmm = parseFloat(customW.value);
      var hmm = parseFloat(customH.value);
      if (!(wmm > 0) || !(hmm > 0)) return null;
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
    function rebake() {
      if (!window.NativePrintExporter.buildResult) return true;
      try {
        var r = window.NativePrintExporter.buildResult(
          ui.editor.graph, paperPx());
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
    }

    function refreshGate() {
      var allAck = acks.length === 0 || acks.every(Boolean);
      printBtn.disabled = !allAck || !previewImg.getAttribute('src');
    }

    function showNotices(notices) {
      acks = [];
      noticeBox.innerHTML = '';
      var combined = (exporterNotices || []).concat(notices || []);
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
      rearm(); if (rebake()) doPreview();
    });
    stockSel.addEventListener('change', function () {
      customRow.style.display = (stockSel.value === 'custom') ? '' : 'none';
      rearm(); if (rebake()) doPreview();
    });
    function onCustomDim() { rearm(); if (rebake()) doPreview(); }
    customW.addEventListener('change', onCustomDim);
    customH.addEventListener('change', onCustomDim);
    copies.addEventListener('change', rearm);

    cancelBtn.addEventListener('click', function () { ui.hideDialog(); });

    printBtn.addEventListener('click', function () {
      var sid = effectiveStockId();
      if (sid == null) {
        status.textContent = 'Custom stock requires positive W and H.';
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
