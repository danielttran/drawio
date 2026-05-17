// Exporter e2e: fake mxGraph -> NativePrintExporter -> real engine
// RenderPreview -> PNG. Proves the bake emits a schema-valid contract the
// engine accepts (no broker/UI involved yet).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildContract } =
  require('../../../webapp/plugins/nativeprint/exporter.js');

// Minimal fake of the drawio Graph public API the exporter uses.
function fakeGraph() {
  const cells = {
    n1: { vertex: true },
    n2: { vertex: true },
    e1: { edge: true }
  };
  const states = {
    n1: { x: 40, y: 40, width: 160, height: 60 },
    n2: { x: 40, y: 200, width: 160, height: 60 },
    e1: { absolutePoints: [{ x: 120, y: 100 }, { x: 120, y: 200 }] }
  };
  const styles = {
    n1: { fillColor: '#dae8fc', strokeColor: '#6c8ebf', fontSize: '14',
          align: 'center', verticalAlign: 'middle' },
    n2: { fillColor: '#d5e8d4', strokeColor: '#82b366', fontSize: '14',
          align: 'center', verticalAlign: 'middle' },
    e1: { strokeColor: '#000000', strokeWidth: '2' }
  };
  const labels = { n1: 'Start', n2: 'Finish', e1: '' };
  const model = {
    cells,
    isVertex: c => !!c && !!c.vertex,
    isEdge: c => !!c && !!c.edge
  };
  return {
    getModel: () => model,
    view: { getState: c => { const id = idOf(c); return states[id] || null; } },
    getCellStyle: c => styles[idOf(c)] || {},
    getLabel: c => labels[idOf(c)] || '',
    getGraphBounds: () => ({ x: 40, y: 40, width: 180, height: 220 })
  };
  function idOf(c) {
    for (const k of Object.keys(cells)) if (cells[k] === c) return k;
    return null;
  }
}

const contract = buildContract(fakeGraph());
console.log('CONTRACT', JSON.stringify(contract));

const EXE = path.join(__dirname, '..', '..', 'build', 'Debug',
  'print_engine_host.exe');
function frame(o) {
  const p = Buffer.from(JSON.stringify(o), 'utf8');
  const h = Buffer.alloc(9);
  h.writeUInt32LE(p.length + 5, 0); h.writeUInt8(1, 4); h.writeUInt32LE(0, 5);
  return Buffer.concat([h, p]);
}
const e = spawn(EXE);
let b = Buffer.alloc(0), ok = false;
e.stdout.on('data', d => {
  b = Buffer.concat([b, d]);
  while (b.length >= 4) {
    const fl = b.readUInt32LE(0); if (b.length < fl + 4) break;
    const t = b.readUInt8(4); const pl = b.slice(9, 4 + fl); b = b.slice(4 + fl);
    if (t === 1) {
      const j = JSON.parse(pl.toString());
      console.log('CTRL', j.result, j.error || '', j.detail || '');
      if (j.result === 'PreviewResult') ok = true;
    } else {
      const out = path.join(__dirname, '..', '..', 'build',
        'exporter_e2e.png');
      fs.writeFileSync(out, pl);
      console.log('PNG', pl.length, '->', out);
    }
  }
});
e.on('exit', () => process.exit(ok ? 0 : 1));
e.stdin.write(frame({ op: 'Hello', proto: { major: 1, minor: 0 } }));
e.stdin.write(frame({ op: 'RenderPreview',
  contractRef: { inline: JSON.stringify(contract) }, dpi: 150 }));
setTimeout(() => e.stdin.write(frame({ op: 'Shutdown' })), 800);
