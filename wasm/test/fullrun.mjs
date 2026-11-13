// Headless DeepVariant run with one of the inspector's models, the way the browser worker runs it (same
// pipeline.mjs, Pyodide and ONNX Runtime in Node; npm install here first):
//   node fullrun.mjs <model key> <input dir> <bam> <region or BED in input dir> <reference FASTA in input dir> <out VCF>
//        [pangenome BAM in input dir]
import { loadPyodide } from "./node_modules/pyodide/pyodide.mjs";
import * as ort from "onnxruntime-node";
import fs from "node:fs";
const dv = await import(new URL("../web/pipeline.mjs", import.meta.url));
const A = new URL("../../public/deepvariant/1.10.0", import.meta.url).pathname; // wasm/build.sh or `npm run assets`
const [key, dir, bam, region, refName, outVcf, pangenome] = process.argv.slice(2);
const info = JSON.parse(fs.readFileSync(`${A}/models/${key}/model.example_info.json`));
const smallModel = fs.existsSync(`${A}/models/smallmodels_${key}/model.npz`);
const py = await loadPyodide({ stdout: () => {}, stderr: (t) => process.env.VERBOSE && console.error(t) });
await dv.installPackages(py);
py.unpackArchive(new Uint8Array(fs.readFileSync(`${A}/pysite.zip`)), "zip", { extractDir: "/pysite" });
dv.importDeepVariant(py);
py.FS.mkdir("/models");
py.mountNodeFS("/models", `${A}/models`);
py.FS.mkdir("/in");
py.mountNodeFS("/in", dir);
py.FS.mkdir("/out");
const regions = fs.existsSync(`${dir}/${region}`) ? `/in/${region}` : region;
const session = await ort.InferenceSession.create(`${A}/models/cnn_${key}.fp16.onnx`);
const t = performance.now();
const secs = () => ((performance.now() - t) / 1000).toFixed(1);
try {
	dv.makeExamples(py, {
		ref: `/in/${refName}`,
		reads: `/in/${bam}`,
		regions,
		checkpoint: `/models/${key}/model`,
		smallModel: smallModel ? `/models/smallmodels_${key}/model.keras` : undefined,
		phaseReads: ["pacbio", "ont_r104"].includes(key),
		pangenome: pangenome ? `/in/${pangenome}` : undefined,
		out: "/out",
		phasedReads: process.env.PHASED ? "/out/phased" : undefined,
		extraFlags: process.env.RUNTIME ? ["--runtime_by_region", "/out/runtime.tsv@1", ...(process.env.EXTRA ?? "").split(" ").filter(Boolean)] : undefined
	});
	console.log(`make_examples ${secs()} s`);
	const n = await dv.callVariants(py, session, ort, { out: "/out" });
	console.log(`call_variants: ${n} examples, ${secs()} s`);
	dv.postprocessVariants(py, {
		ref: `/in/${refName}`,
		regions,
		checkpointJson: `/models/${key}/model.example_info.json`,
		smallModel,
		out: "/out"
	});
	console.log(`postprocess_variants ${secs()} s`);
} catch (e) {
	console.log("ERROR", String(e).split("\n").slice(-15).join("\n"));
	process.exit(1);
}
fs.writeFileSync(outVcf, py.FS.readFile("/out/output.vcf.gz"));
if (process.env.RUNTIME) fs.writeFileSync(process.env.RUNTIME, py.FS.readFile("/out/runtime.tsv-00000-of-00001"));
if (process.env.PHASED)
	fs.writeFileSync(outVcf.replace(/.vcf.gz$/, ".phased.bam"), py.FS.readFile("/out/phased-00000-of-00001.bam"));
console.log(`wrote ${outVcf} (image shape ${info.shape})`);
