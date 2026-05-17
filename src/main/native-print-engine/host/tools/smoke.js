// Manual engine smoke driver. Frames control ops over the engine's stdio,
// prints replies, saves any preview PNG. Not a unit test; a dev aid.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXE = path.join(__dirname, "..", "..", "build", "Debug",
  "print_engine_host.exe");

function frame(obj) {
  const p = Buffer.from(JSON.stringify(obj), "utf8");
  const h = Buffer.alloc(9);
  h.writeUInt32LE(p.length + 5, 0);
  h.writeUInt8(1, 4);
  h.writeUInt32LE(0, 5);
  return Buffer.concat([h, p]);
}

const contract = JSON.stringify({
  schema: { major: 1, minor: 0 },
  document: {
    units: "px",
    pages: [{
      id: "p1",
      size: { w: 200, h: 120 },
      tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 120 } }],
      paint: [
        { kind: "path", d: "M 10 10 L 190 10 L 190 110 L 10 110 Z",
          stroke: { color: "#000000", width: 2 } },
        { kind: "text", box: { x: 20, y: 45, w: 160, h: 30 },
          font: { family: "Arial", sizePx: 18, weight: 400, italic: false,
                  color: "#000000" },
          align: { h: "center", v: "middle" },
          content: { type: "static", lines: ["Hello Print Engine"] } }
      ]
    }]
  }
});

const e = spawn(EXE);
let buf = Buffer.alloc(0);
e.stdout.on("data", d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const fl = buf.readUInt32LE(0);
    if (buf.length < fl + 4) break;
    const t = buf.readUInt8(4);
    const pl = buf.slice(9, 4 + fl);
    buf = buf.slice(4 + fl);
    if (t === 1) {
      console.log("CTRL", pl.toString("utf8"));
    } else {
      const out = path.join(__dirname, "..", "..", "build",
        "preview_smoke.png");
      fs.writeFileSync(out, pl);
      console.log("BLOB", pl.length, "bytes -> " + out);
    }
  }
});
e.stderr.on("data", d => console.log("ERR", d.toString()));
e.on("exit", c => console.log("engine exit", c));

e.stdin.write(frame({ op: "Hello", proto: { major: 1, minor: 0 } }));
e.stdin.write(frame({ op: "GetCapabilities" }));
e.stdin.write(frame({ op: "RenderPreview",
  contractRef: { inline: contract }, dpi: 150 }));
setTimeout(() => e.stdin.write(frame({ op: "Shutdown" })), 1000);
