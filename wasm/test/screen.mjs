// Headless screen: make_examples with realigner diagnostics over a BAM + BED, then rank realigner windows by
// how many reads realignment changed and which indels it added.
//   node screen.mjs <bam dir> <bam name> <bed name> <out json> [reference FASTA name in <bam dir>]
import { loadPyodide } from "./node_modules/pyodide/pyodide.mjs";
import fs from "node:fs";
const dv = await import(new URL("../web/pipeline.mjs", import.meta.url));
const A = new URL("../../public/deepvariant/1.10.0", import.meta.url).pathname; // wasm/build.sh or `npm run assets`
const [dirBam, bam, bed, outJson, refName] = process.argv.slice(2);

const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
await dv.installPackages(py);
py.unpackArchive(new Uint8Array(fs.readFileSync(`${A}/pysite.zip`)), "zip", { extractDir: "/pysite" });
dv.importDeepVariant(py);
for (const d of ["data", "models"]) {
	py.FS.mkdir(`/${d}`);
	py.mountNodeFS(`/${d}`, `${A}/${d}`);
}
py.FS.mkdir("/in");
py.mountNodeFS("/in", dirBam);
py.FS.mkdir("/out");
const t = performance.now();
try {
	dv.makeExamples(py, {
		ref: refName ? `/in/${refName}` : "/data/ucsc.hg19.chr20.unittest.fasta",
		reads: `/in/${bam}`,
		regions: `/in/${bed}`,
		checkpoint: "/models/wgs/model",
		smallModel: "/models/smallmodels_wgs/model.keras",
		out: "/out",
		realignerDir: "/out/realigner"
	});
} catch (e) {
	console.log("ERROR", String(e).split("\n").slice(-12).join("\n"));
	process.exit(1);
}
console.log(`make_examples ${((performance.now() - t) / 1000).toFixed(1)} s`);
const result = py.runPython(`
import glob, json
from third_party.nucleus.io import sam
from third_party.nucleus.util import ranges
key = lambda r: (r.fragment_name, r.read_number)
aln = lambda r: (r.alignment.position.position, tuple((c.operation, c.operation_length) for c in r.alignment.cigar))
def indels(r):
    pos, ev = r.alignment.position.position, set()
    for c in r.alignment.cigar:
        if c.operation == 2: ev.add((pos, f"{c.operation_length}I"))
        if c.operation == 3: ev.add((pos, f"{c.operation_length}D"))
        if c.operation in (1, 3, 8, 9): pos += c.operation_length
    return ev
rows = []
with sam.SamReader("/in/${bam}") as orig_reader:
    for p in glob.glob("/out/realigner/*/realigned_reads.bam"):
        win = p.split("/")[3]
        orig = {key(x): x for x in orig_reader.query(ranges.parse_literal(win))}
        changed = total = 0
        gained, had = {}, {}
        with sam.SamReader(p) as r:
            for n in r:
                total += 1
                o = orig.get(key(n))
                if o is None: continue
                if aln(o) != aln(n): changed += 1
                for e in indels(n) - indels(o): gained[e] = gained.get(e, 0) + 1
                for e in indels(o): had[e] = had.get(e, 0) + 1
        top = sorted(gained.items(), key=lambda kv: -kv[1])[:3]
        rows.append({"window": win, "changed": changed, "total": total,
                     "gained": [{"pos": p + 1, "kind": k, "as_aligned": had.get((p, k), 0), "extra": g} for (p, k), g in top]})
json.dumps(sorted(rows, key=lambda r: -r["changed"]))
`);
fs.writeFileSync(outJson, result);
console.log(
	JSON.parse(result)
		.slice(0, 15)
		.map((r) => `${r.window} changed ${r.changed}/${r.total} ${JSON.stringify(r.gained)}`)
		.join("\n")
);
