# DeepVariant → WebAssembly

DeepVariant 1.10.0, from BAM to VCF, running in the browser for the [inspector](../src/Inspector.svelte): WGS,
WES, PacBio HiFi, ONT R10.4.1, hybrid PacBio + Illumina, and pangenome-aware WGS. CPU only, no server.

It runs DeepVariant's **own code**, not a rewrite:

- **Python** (`make_examples`, `postprocess_variants`, `show_examples`, …) runs unmodified in
  [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly), version 314.0.7.
- **C++** (BAM/FASTA reading, candidate finding, pileup images, local realignment, VCF writing — all of
  DeepVariant's and Nucleus' pybind11 modules) is compiled with Emscripten into one Pyodide extension
  module, `_dv_native.so` (5.5 MB).
- **The CNN** (`call_variants`) runs in [ONNX Runtime Web](https://onnxruntime.ai) (CPU build); the
  **small model** runs as numpy. TensorFlow isn't used anywhere.

On DeepVariant's quick-start data (chr20:10,000,000–10,010,000) every candidate gets the same genotype as the
official Docker image, and the VCF has the same 78 records and 72 PASS variants; 70 of 78 lines are
identical, the rest differ only in QUAL by ≤ 0.3 (see [Accuracy](#accuracy)). On HG003, every model gives
the official case studies' genotypes (see [Reproducing a real run](#reproducing-a-real-run)).

This was first built for [sandbox.bio](https://sandbox.bio) (where the quick-start page still lives) and moved
here with the inspector.

## Build

```bash
./wasm/build.sh
```

Requires Docker. Takes ~15 minutes the first time (mostly compiling the C++ dependencies); downloads and
intermediate files go to `wasm/build/` (gitignored) and are reused, so delete that folder to start over.
Output goes to `public/deepvariant/1.10.0/` (gitignored), which Vite serves and copies into the site. To
skip the build, `npm run assets` downloads the files of the latest release instead (see the
[top-level README](../README.md)).

| Step | Where                              | What                                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `Dockerfile`, `container-build.sh` | Emscripten 5.0.3 + Python 3.14 + pyodide-build 0.39.1 (must match Pyodide 314.0.7). Fetches DeepVariant v1.10.0 and its C++ dependencies, applies `patches/`, builds the dependencies, generates the protobuf code, compiles `_dv_native.so` (`native/CMakeLists.txt`) and bundles it with the Python into `pysite.zip`.                |
| 2    | `convert/models.sh`                | In the official `google/deepvariant:1.10.0` image (or anywhere with TensorFlow 2.16.1 and tf2onnx), for each model from `gs://deepvariant/models/DeepVariant/1.10.0`: the CNN → ONNX (`tf2onnx`) → float16 weights (`shrink_cnn.py`), checked against TensorFlow (`verify_cnn.py`); the small model → `.npz` (`export_small_model.py`). |
| 3    | `build.sh`                         | Copies everything below into `public/deepvariant/1.10.0/`, with the examples if `examples.sh` made them (see [Examples](#examples)).                                                                                                                                                                                                    |

| File                                            | Size   |                                                                                                  |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `worker.mjs`, `pipeline.mjs`                    | 20 KB  | The web worker the page starts: loads Pyodide + ONNX Runtime, runs each step (from `web/`)       |
| `pysite.zip`                                    | 1.8 MB | DeepVariant's Python + `_dv_native.so` + the stand-ins below (unpacked into Pyodide)             |
| `models/cnn_<model>.fp16.onnx`                  | 44 MB  | Each model's CNN, weights stored as float16 (6 models; WGS loads on start, the rest when picked) |
| `models/smallmodels_<model>/model.npz`          | 2.5 MB | Small-model weights (WGS, PacBio, ONT)                                                           |
| `models/<model>/model.example_info.json`        | 1 KB   | Pileup shape, channels and the model's `make_examples` flags (read by `make_examples`)           |
| `data/HG003.*.inspect_examples*.bam` (+ `.bai`) | 5.5 MB | The inspect page's examples, one BAM per model                                                   |
| `tools/gbz_haplotypes_bam.py`                   | 4 KB   | Makes the pangenome BAM pangenome-aware runs need (linked from the page)                         |

Pyodide, its packages (numpy, protobuf, Pillow) and ONNX Runtime come from jsDelivr; the references (hg19,
hg38) from igv.js's bucket on S3.

### Range requests

The reference is read with HTTP range requests (Pyodide's `FS.createLazyFile`, 1 MB at a time), so a
locus downloads a few MB of it, not 3 GB; reads and pangenomes are `File`s from the page, read from disk on
demand (Emscripten's WORKERFS). Pyodide only uses ranges if a HEAD response shows `Accept-Ranges: bytes`,
which isn't always visible even when ranges work: cross-origin, the browser hides it unless the server lists
it in `Access-Control-Expose-Headers`, and Vite's dev server leaves it out of HEAD responses. So the worker
tests ranges itself (a 2-byte range request must return 206; not `bytes=0-0`, which Vite answers with the
whole file) and answers Pyodide's header check accordingly. If a server really can't do ranges, the file is
downloaded whole and the log shows a warning.

## How DeepVariant's Python and C++ run together

Natively, DeepVariant's Python calls its C++ through ~36 pybind11 extension modules (e.g.
`deepvariant.python.allelecounter`). Here they're all compiled into the one `_dv_native.so`: each
`PYBIND11_MODULE(name, m)` becomes a function that fills in a submodule (`native/pybind_rename.h`,
`native/gen_module.py`), and `dv_bootstrap.py` registers each submodule in `sys.modules` under its
original import path. So `from deepvariant.python import allelecounter` in DeepVariant's own code gets
the WebAssembly version.

The page's worker (`web/worker.mjs`, `web/pipeline.mjs`) then runs the same steps as
`run_deepvariant`, each with the same command-line flags:

1. `make_examples` (Python + C++): finds candidates, calls the easy ones with the small model, and
   writes pileup images for the rest.
2. `call_variants`: the CNN on those images in ONNX Runtime Web. The results are written by DeepVariant's
   own `call_variants.write_variant_call`, so the rounding and file format are the same.
3. `postprocess_variants` (Python + C++): genotypes, GQ, QUAL, filters → VCF.
4. `show_examples` (on request): DeepVariant's script that draws the pileup images as PNGs.

DeepVariant's tools are separate programs that define some command-line flags with the same name; here
they share one Python, so `browser/dv_browser.py` gives each tool its own set of absl flags.

## What's changed

### DeepVariant (`patches/deepvariant-v1.10.0.patch`)

| Change                                                   | Why                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std::max(x, 0L)` → `std::max(x, int64_t{0})` (6 places) | On wasm32 `long` is 32-bit, so `0L` and `int64_t` are different types and `std::max` doesn't compile.                                                                                                                                                               |
| `proto_utils.py`: accept protobuf's `upb` backend        | DeepVariant insists on the "cpp" protobuf backend to avoid the slow pure-Python one; Pyodide's protobuf uses `upb`, which is also C.                                                                                                                                |
| Nucleus' proto casters copy instead of sharing memory    | Natively, Python and C++ share protobuf messages by pointer, which only works with the old "cpp" Python backend. Here reads etc. are serialized across instead (and C++ results copied back). Same results; this copying is a large share of `make_examples`' time. |

### pybind11_protobuf (`patches/pybind11_protobuf-a50899c.patch`)

Two fixes backported from upstream main: it must not clash with pybind11 3's own enum caster, and it
must use `GetMessageClass` (protobuf ≥ 4 removed `MessageFactory.GetPrototype`).

### Stand-ins (`tfshim/`, `pyshim/`)

DeepVariant imports these, but the browser path either doesn't need them or needs only a sliver. Each
stand-in provides just that sliver; anything else fails loudly if it's ever called.

| Stand-in                                      | Provides                                                                | Instead of                                             |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `tfshim/` (C++)                               | TFRecord reading/writing (same framing and CRCs), file access, `Status` | TensorFlow's C++                                       |
| `pyshim/tensorflow`                           | `gfile`, TFRecord writer/reader, the `Example` protos                   | TensorFlow                                             |
| `pyshim/keras`                                | `keras.models.load_model` → the small model in numpy                    | Keras                                                  |
| `pyshim/pysam`                                | `FastaFile`'s contig names and lengths, via Nucleus' FASTA reader       | pysam (7 MB)                                           |
| `pyshim/pandas`                               | nothing (only `show_examples --curate` uses it)                         | pandas (4 MB)                                          |
| `pyshim/{resource,psutil}`                    | zeros                                                                   | run-time metrics only                                  |
| `pyshim/IPython`, `bazel_tools`, `gbz_reader` | nothing                                                                 | notebook display, Bazel runfiles, the pangenome reader |

Left out of the C++: tests, the streaming mode (`stream_examples`, needs shared memory between
processes) and the pangenome reader (`gbz_reader`, needs extra libraries).

## Accuracy

Checked against the official `google/deepvariant:1.10.0` run on chr20:10,000,000–10,010,000:

- `make_examples`: 24/24 pileup images and variant records identical; the small model makes the same
  60/24 split, probabilities within 1.2e-7.
- CNN: 24/24 same genotype, probabilities within 1.7e-6 (float32 weights) / 7e-4 (float16).
- VCF: same 78 records and 72 PASS; 70/78 lines identical. The other 8 differ only in QUAL by ≤ 0.3: 7
  are small-model 1/1 calls, where QUAL comes from a tiny P(0/0) (~3e-6) and numpy vs TensorFlow
  float32 summation order moves it by ~1e-7; 1 is from the float16 CNN weights (57.6 → 57.7).
- `show_examples`: pileups pixel-identical; only the strip of channel names differs (Pillow 12's default
  font).

float16 vs float32 CNN weights on all 304 candidates of the quick-start BAM: same genotype and GQ
304/304, QUAL within 0.1. int8 weights (19 MB) changed GQ on 32/304 and QUAL by up to 1.3, so they
aren't used.

## Inspecting a call

[The inspector](../src/Inspector.svelte)
answers the question users ask most on GitHub: "why did DeepVariant call this, when IGV shows something
else?" Pick the model (`--model_type`) the data was called with, give it the reads (the whole BAM is fine: it's
read on demand) and a position, and DeepVariant runs again on that locus. For each call the page shows:

- **The genotype probabilities** (from PL), and whether the small model or the CNN made the call.
- **IGV with what DeepVariant used**: the reads as aligned and after local realignment (short-read models;
  `make_examples --realigner_diagnostics --emit_realigned_reads`, one BAM per ~1 kb window, with how many reads
  it changed), the reads with DeepVariant's own phasing grouped by haplotype (long-read models, which don't
  realign; `--output_local_read_phasing`), and the pangenome's haplotypes (pangenome-aware).
- **The pileup images the CNN classified** (`show_examples`), with each channel of that model explained.
  Calls made by the small model have none.

With the user's DeepVariant VCF, it also summarizes their calls (what `vcf_stats_report` shows), lists the
ones worth a closer look (PASS with GQ < 20, no-calls, 1/2 calls; one click reruns DeepVariant there), and
compares each rerun call with their record. The VCF is read in the browser without an index (`src/vcf.js`: each
BGZF block is decompressed with `DecompressionStream`; 3 s for HG003's chr20). The model, example or region
go in the URL, so a locus can be shared.

Uploads don't need to be sorted or indexed (or even BAM): if there's no index, biowasm's samtools sorts
and indexes the file first. The reference is igv.js's own hg19/hg38 on S3
(`s3.amazonaws.com/igv.broadinstitute.org`), read on demand, so contig names must be UCSC-style
(`chr1`). A snippet must keep its full header (`samtools view -b` does): `make_examples` refuses BAMs
whose contigs cover < 90% of the reference.

### Models

All of DeepVariant 1.10's `run_deepvariant` models except the RNA ones, plus pangenome-aware WGS. Since 1.10 each
model's `make_examples` flags are in its `model.example_info.json` (`flags_for_calling`), which `make_examples`
reads from the checkpoint's directory, so the worker only adds what `run_deepvariant` adds itself: the small
model where there is one, `--output_phase_info` for PacBio and ONT, and `--small_model_cvo_records` for
`postprocess_variants` when the small model ran.

| Model (`--model_type`) | Pileup (rows × width × channels) | Realigns | Small model | Partition |
| ---------------------- | -------------------------------- | -------- | ----------- | --------- |
| WGS                    | 100 × 221 × 7                    | yes      | yes         | 1 kb      |
| WES                    | 100 × 221 × 7                    | yes      | no          | 1 kb      |
| PACBIO                 | 100 × 147 × 10                   | no       | yes         | 25 kb     |
| ONT_R104               | 100 × 199 × 10                   | no       | yes         | 25 kb     |
| HYBRID_PACBIO_ILLUMINA | 100 × 221 × 6                    | yes      | no          | 1 kb      |
| WGS, pangenome-aware   | 200 × 221 × 7                    | yes      | no          | 1 kb      |

Each CNN gives the same top genotype as TensorFlow on random pileups, with probabilities within 1.3e-3
(`verify_cnn.py`); the small models match Keras to 1e-28.

**Pangenome-aware DeepVariant** (`make_examples_pangenome_aware_dv`) normally reads the pangenome from a GBZ
(3.3 GB for HPRC v1.1, loaded whole into memory), which is out of reach in the browser, and our build leaves
out the GBZ reader. But `--pangenome` also takes a BAM of the pangenome's haplotypes aligned to the reference.
`tools/gbz_haplotypes_bam.py` makes one for a locus the way DeepVariant's GBZ reader turns the graph into reads
(`third_party/nucleus/io/gbz_reader.cc`): the subgraph around the locus with 1 kb of context, from
[gbz-base](https://github.com/jltsiren/gbz-base)'s `query --cigar` on the graph's GBZ-base database, and each
haplotype walk as a read at the reference walk's start, with its CIGAR, mapping quality 90 and base qualities 30.

### Reproducing a real run

A rerun on one locus only matches a whole-genome run if `make_examples` sees the locus the same way, so the
page widens what you enter to:

- **Whole partitions of the contig.** `make_examples` splits regions into `partition_size` chunks from each
  region's start, and a whole-genome run starts at the contig's start. This matters most for long reads:
  PacBio and ONT phase reads within one 25 kb partition, so a 1 kb region phases from less context and the
  haplotype channel differs. (ONT at chr20:238,845 gave 1/1 GQ 11 on ±500 bp, and the official 0/1 GQ 4 on its
  25 kb partition.)
- **For WES, the capture interval** (from the capture BED given to `--regions`), since partitions then start at
  each interval.

What still can't be reproduced exactly: where more reads cover a site than fit in a pileup image, DeepVariant
samples them with a random number generator whose state depends on what that `make_examples` task processed
before. At a WES site with 256 reads (chr20:3,122,228) the rerun gave NoCall where the official run has 0/1. The
phase set IDs (PS) of long-read calls are assigned across the whole run, so a rerun's phased genotypes have
none.

Checked against the official 1.10 case-study VCFs of HG003 (`gs://deepvariant/case-study-outputs/1.10.0/`),
headlessly with the same `pipeline.mjs`:

| Model                | Region (chr20)                               | Records (ours) | Genotype and filter  | GQ, PL                                          |
| -------------------- | -------------------------------------------- | -------------- | -------------------- | ----------------------------------------------- |
| WGS                  | the 5 examples' 1 kb partitions              | 57             | all identical        | all identical                                   |
| WES                  | capture interval 62,064,451–62,065,810       | 1              | identical            | identical                                       |
| PACBIO               | 800,001–825,000                              | 133            | all identical        | 1 GQ and 3 PL values off by 1                   |
| ONT_R104             | 225,001–250,000                              | 83             | all identical        | 2 GQs off by 1; no PS (see above)               |
| HYBRID               | 4,761,001–4,762,000                          | 11             | all identical        | one PL: P(0/1) 10^-7.2 vs 10^-9.9               |
| WGS, pangenome-aware | 26,263,001–26,264,000; 35,438,001–35,439,000 | 18 (20)        | PASS calls identical | a few GQs; 2 extra RefCalls, 1 NoCall → RefCall |

The pangenome-aware differences are from the haplotype BAM: DeepVariant's GBZ reader queries each partition
with a cache, while the BAM holds one query per partition. The ONT case-study VCF comes from
`HG003_PAY87794.calls.sorted.bam` (its read depths match exactly), not the 80x BAM the ONT case study names.

### Examples

Each model has hard examples: HG003 on GRCh38, chr20 (the sample and chromosome DeepVariant's case studies
evaluate on; chr20 is held out of training), at sites where the official 1.10 run disagrees with GIAB v4.2.1
(the case studies' hap.py output) or makes a low-confidence call, cut from that case study's own BAM
(`examples.sh`). The page lists each site's truth and official call (`src/models.js`).

- **WGS**: `make_examples --realigner_diagnostics` was run headlessly on ±300 bp around all 359 chr20 errors,
  and the five with the most reads changed by realignment were kept: missed insertions, wrong genotypes at
  repeats, and an extra allele in a homopolymer.
- **Pangenome-aware WGS**: two of those five that the pangenome-aware model gets right, on the same reads.
- **PacBio**, **ONT**: errors in homopolymers, and a 1 bp deletion both miss (chr20:348,853).
- **Hybrid**: a 1/1 SNP called 0/1 though all 63 reads support it. **WES**: a 1/1 deletion with GQ 9 (chr20 has
  only 3 WES errors: two have no reads, one is the 256-read site above).

```bash
./wasm/examples.sh work/pangenome/hprc-v1.1-mc-grch38.gbz.db   # then ./wasm/build.sh copies them to data/
```

## Notes

- **Pyodide version.** `_dv_native.so` only works with the Pyodide it was built for (ABI), so the
  Dockerfile's Emscripten/Python/pyodide-build versions and the Pyodide URL in `web/worker.mjs` must
  change together.
- **Your own BAM.** It's mounted with WORKERFS and read from disk on demand, never uploaded.
- **Speed.** ~2.5 s to load, then 2–7 s per locus (a 1 kb partition for short reads, 25 kb for long reads).
  The quick-start's 10 kb region took ~2.3 s `make_examples`, ~1.4 s CNN and ~0.1 s `postprocess_variants`.
  Chrome slows background tabs ~3×. WebAssembly SIMD (`-msimd128`) made no difference.
- **Checking against official runs.** `test/` runs the same `pipeline.mjs` headlessly (Pyodide and ONNX Runtime
  in Node): `test/compare.sh` diffs a region against an official VCF, `test/screen.mjs` ranks realigner windows
  by how many reads realignment changed (how the WGS examples were found).
