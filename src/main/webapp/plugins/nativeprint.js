/**
 * Native Print — drawio plugin (host integration spec Layer 4: the Print
 * Native UI). Adds File > Native Print, bakes the diagram via the exporter,
 * talks to the broker over same-origin HTTP, and enforces the §3.7
 * DegradationNotice acknowledgment gate: the Print button stays disabled
 * until every notice is acknowledged, and any pixel-affecting input change
 * re-arms it (INV-5: what the operator approves is what prints; Copies only
 * repeats the approved sheet, so it never re-arms).
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

  // Native print is headless-only: the UI sends the raw diagram XML to the
  // broker, which bakes it headlessly (the same low-level path the unattended
  // service uses) and forwards a frozen contract to the engine. There is no
  // browser/live-DOM bake — printing has zero browser dependency.

  // Get the diagram XML for the headless bake. Multi-page files send the
  // FULL <mxfile> (the bake produces ALL pages per spec §3.2 — the old
  // current-page-model export silently never printed pages 2..N); a
  // single-page editor still sends the bare <mxGraphModel>.
  function getDiagramXml() {
    try {
      if (ui.pages != null && ui.pages.length > 1 &&
          typeof ui.getFileData === 'function') {
        // getFileData(forceVisible, .., .., uncompressed): full file, all
        // pages, uncompressed XML (the parser also accepts deflate).
        var fileXml = ui.getFileData(true, null, null, null, null, null,
          null, null, null, true);
        if (typeof fileXml === 'string' && fileXml.indexOf('<mxfile') >= 0) {
          return fileXml;
        }
      }
      var codec = new mxCodec();
      var node = codec.encode(ui.editor.graph.getModel());
      return mxUtils.getXml(node);
    } catch (e) {
      throw new Error('cannot serialise diagram: ' + e.message);
    }
  }

  function rpc(body) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (txt) {
        try { return JSON.parse(txt); }
        catch (_) {
          // Non-JSON responses (e.g. "forbidden origin" from the broker
          // origin check) — surface the actual server message.
          throw new Error(txt || ('HTTP ' + r.status));
        }
      });
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

    // ── Diagram compatibility classification ─────────────────────────────────
    // Native print renders every shape from its stencil XML geometry directly —
    // no browser, no live DOM. These notice kinds flag shapes the render cannot
    // reproduce; the compatibility panel below surfaces them before print.
    var PROBE_BLOCKING = ['ExporterUnsupportedShape', 'ExporterUnsupportedStencilFeature',
      'ExporterUnsupportedImage'];
    var NOTICE_HUMAN = {
      'ExporterUnsupportedShape':
        'Shape not yet supported in headless mode',
      'ExporterUnsupportedStencilFeature':
        'Shape uses a rendering feature not supported headlessly (rounded paths, ' +
        'embedded images, or shape composition)',
      'ExporterUnsupportedImage':
        'Image references an external URL that could not be embedded',
      'GradientDirectionApprox':
        'Gradient direction may differ slightly from screen (headless limitation)',
      'FontMetricApprox':
        'A text font is not metric-compatible with the core Arial/Times/Courier ' +
        'tables — wrap points and alignment may shift from screen',
      'GlyphMetricApprox':
        'Text contains glyphs outside the measured set (non-Latin scripts, ' +
        'arrows, symbols or emoji) — their spacing/box sizing may shift from screen',
      'RichApproximate':
        'Rich-text layout is approximated (word-wrap requires font metrics)',
      'RichApproximateAlpha':
        'Text color uses rgba transparency — alpha dropped (print is opaque)',
      'NativePrintFatal':
        'Fatal rendering error — diagram cannot be printed',
    };

    // Diagram compatibility panel — reports per-diagram shape support before
    // the operator commits to print. Native print renders every shape from its
    // stencil XML geometry (no browser, no live DOM), so this lists any shapes
    // the render cannot reproduce.
    var compatSection = el('div', { style: 'margin:8px 0' });
    compatSection.appendChild(el('div', {
      style: 'font-weight:bold;margin-bottom:4px' }, 'Diagram compatibility'));
    var compatPanel = el('div', { style:
      'padding:6px 8px;border-radius:3px;font-size:11px;' +
      'background:#f5f5f5;border:1px solid #e0e0e0;color:#555' });
    compatPanel.textContent = 'Checking diagram…';
    compatSection.appendChild(compatPanel);
    root.appendChild(compatSection);

    // Count shape-producing vertices in the live graph model (text-only cells excluded).
    function countShapeVerts() {
      try {
        var cells = ui.editor.graph.getModel().cells;
        var n = 0;
        Object.keys(cells).forEach(function (k) {
          var c = cells[k];
          if (c.vertex && c.id !== '0' && c.id !== '1') {
            var s = c.style || '';
            // text-only cells don't produce a shape node
            if (s.indexOf('shape=text') < 0 && s !== 'text' &&
                s.indexOf('text;') !== 0) n++;
          }
        });
        return n;
      } catch (e) { return null; }
    }

    // Resolve a cellId to a human-readable label for display.
    function cellLabel(cellId) {
      try {
        var c = ui.editor.graph.getModel().cells[cellId];
        var v = c && c.value != null ? String(c.value) : '';
        // Strip HTML tags from rich labels
        v = v.replace(/<[^>]+>/g, '').trim();
        if (v.length > 30) v = v.slice(0, 27) + '…';
        return v || ('#' + cellId);
      } catch (e) { return '#' + cellId; }
    }

    function runSupportProbe() {
      var ex = window.NativePrintExporter;
      if (!ex || !ex.buildResult) {
        compatPanel.style.background = '#fce4ec'; compatPanel.style.borderColor = '#ef9a9a';
        compatPanel.style.color = '#c62828';
        compatPanel.textContent = 'Exporter not loaded.';
        return;
      }
      try {
        // Probe with the SAME inputs the broker bake uses: the document's
        // own page (no stock-size override), so the compatibility verdict
        // is about the contract that actually prints. Baking the probe at
        // the stock size could disagree with the production bake.
        var probeResult = ex.buildResult(ui.editor.graph, null, { headless: true });
        var blocking = (probeResult.notices || []).filter(function (n) {
          return PROBE_BLOCKING.indexOf(n.kind) >= 0;
        });
        var total = countShapeVerts();
        var totalStr = total != null ? total + ' shape' + (total === 1 ? '' : 's') : 'shapes';
        if (blocking.length === 0) {
          compatPanel.style.background = '#e8f5e9'; compatPanel.style.borderColor = '#a5d6a7';
          compatPanel.style.color = '#2e7d32';
          compatPanel.textContent = '✓ All ' + totalStr + ' render headlessly — fully print-ready.';
        } else {
          compatPanel.style.background = '#fff8e1'; compatPanel.style.borderColor = '#ffe082';
          compatPanel.style.color = '#7a4500';
          // Show which specific shapes the headless render can't reproduce
          var ul = el('ul', { style: 'margin:4px 0 0;padding-left:16px;list-style:disc' });
          blocking.forEach(function (n) {
            var li = el('li', { style: 'margin:2px 0' });
            var lbl = n.detail && n.detail.cellId ? '"' + cellLabel(n.detail.cellId) + '"' : '';
            var reason = NOTICE_HUMAN[n.kind] || n.kind;
            li.textContent = lbl ? lbl + ' — ' + reason : reason;
            ul.appendChild(li);
          });
          // Header with shape counts
          var hdr = el('div');
          var supported = total != null ? (total - blocking.length) : null;
          hdr.textContent = '⚠ ' + blocking.length + ' of ' + totalStr +
            (supported != null ? ' (' + supported + ' render headlessly' : '') +
            (supported != null ? ', ' + blocking.length + ' not supported)' : ' not supported') + ':';
          compatPanel.innerHTML = '';
          compatPanel.appendChild(hdr);
          compatPanel.appendChild(ul);
        }
      } catch (e) {
        compatPanel.style.background = '#fce4ec'; compatPanel.style.borderColor = '#ef9a9a';
        compatPanel.style.color = '#c62828';
        compatPanel.textContent = 'Headless check failed: ' + e.message;
      }
    }

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
    var acks = [];       // one bool per notice; Print enabled when all true
    var ackedKinds = []; // notice kind per ack slot — sent to the broker so
                         // bake-and-print only refuses UNacknowledged kinds

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

    // NOTE: the dialog does NOT bake locally. The broker bakes the raw
    // diagram XML headlessly for BOTH preview and print (the same low-level
    // path the unattended service uses), and its bake notices come back on
    // the bake-and-preview reply — they are the single source of truth for
    // the ack list below. An earlier in-dialog bake built a contract that
    // was never sent and double-counted its notices against the broker's.

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
      var label = NOTICE_HUMAN[n.kind] || n.kind;
      var cellInfo = (n.detail && n.detail.cellId)
        ? ' [' + cellLabel(n.detail.cellId) + ']' : '';
      return label + cellInfo;
    }

    // The Print gate blocks ONLY on degradations (real fidelity loss the
    // operator must consciously approve). Informational notices (expected
    // edge-clip to the chosen paper) are shown for traceability but never
    // require an acknowledgment. 'silent' notices (a faithful external SVG
    // render) are not shown at all — a full-fidelity WYSIWYG print produces
    // no warning. The engine may still emit them on the wire for audit.
    function showNotices(notices) {
      acks = [];
      ackedKinds = [];
      noticeBox.innerHTML = '';
      // Single source: the broker's reply already carries bake + engine
      // notices (vite.config.mjs bake-and-preview concatenates them once).
      var combined = notices || [];
      var degradations = [], infos = [];
      combined.forEach(function (n) {
        var sev = severityOf(n.kind);
        if (sev === 'silent') return;     // faithful render: nothing to surface
        (sev === 'info' ? infos : degradations).push(n);
      });
      if (degradations.length === 0 && infos.length === 0) {
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
          ackedKinds.push(n.kind);     // kind for the broker-side ack gate
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
      status.textContent = 'Rendering preview…';
      // Headless-only: send the raw diagram XML and let the broker bake it.
      var previewRpc = rpc({ action: 'bake-and-preview',
        drawioXml: getDiagramXml(),
        dpi: selectedDpi() });
      previewRpc.then(function (m) {
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
      runSupportProbe(); doPreview();
    });
    stockSel.addEventListener('change', function () {
      customRow.style.display = (stockSel.value === 'custom') ? '' : 'none';
      runSupportProbe(); doPreview();
    });
    function onCustomDim() { runSupportProbe(); doPreview(); }
    customW.addEventListener('change', onCustomDim);
    customH.addEventListener('change', onCustomDim);
    // Copies deliberately does NOT re-arm: it changes how many identical
    // sheets come out, not a single pixel of what the operator approved.
    // Re-arming here disabled Print permanently (nothing ever re-ran the
    // preview after a copies change).

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
      // Headless-only: send the raw diagram XML; the broker bakes it low-level
      // and forwards the contract to the engine. Zero browser dependency.
      // §3.7 ack gate, honored end-to-end: the kinds the operator ticked are
      // forwarded so the broker refuses ONLY unacknowledged degradations.
      // (Print is only enabled when every ack box is ticked, so ackedKinds
      // is exactly the set of approved kinds.)
      var acknowledgedKinds = [];
      ackedKinds.forEach(function (k, i) {
        if (acks[i] && acknowledgedKinds.indexOf(k) < 0) acknowledgedKinds.push(k);
      });
      var printRpc = rpc({ action: 'bake-and-print',
        drawioXml: getDiagramXml(),
        printerId: printers[printerSel.selectedIndex].id,
        stockId: sid,
        copies: parseInt(copies.value, 10) || 1,
        acknowledgedKinds: acknowledgedKinds });
      printRpc.then(function (m) {
        if (m.result === 'PrintResult') {
          status.textContent = 'Printed. Job ' + m.jobId + '.';
          // PRINT-TIME notices exist that the preview can never produce
          // (FontSubstituted on the device, StubbedSvgArtwork on a raster
          // failure, MergeClip): discarding them meant the sheet was
          // already out with a silent post-print fidelity loss. Surface
          // them in the same notice panel (degradations show loudly; the
          // job is done, so this is the operator's record, not a gate).
          if (m.notices && m.notices.length) {
            showNotices(m.notices);
            var printedDegradations = (m.notices || []).filter(function (n) {
              return severityOf(n.kind) === 'degradation';
            });
            if (printedDegradations.length) {
              status.textContent = 'Printed. Job ' + m.jobId + ' — with ' +
                printedDegradations.length + ' degradation notice(s); see below.';
            }
          }
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
    // Run the support probe immediately so the status panel shows before printers load.
    runSupportProbe();

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
