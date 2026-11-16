# Inspector for DeepVariant

Why did [DeepVariant](https://github.com/google/deepvariant) call a variant this way, when IGV shows something
else? This app reruns DeepVariant 1.10.0 in the browser on any locus of your data, with the model you used, and
shows what it actually looked at: the reads after its local realignment (short reads) or with its own phasing
(long reads), the pangenome's haplotypes (pangenome-aware), the pileup images its CNN classified, and the
genotype probabilities. With your DeepVariant VCF, it summarizes your calls, lists the ones worth a closer look,
and compares each rerun call with yours. Your files stay on your computer: nothing is uploaded.

- **Models:** WGS, WES, PacBio HiFi, ONT R10.4.1, hybrid PacBio HiFi + Illumina, and pangenome-aware WGS:
  `run_deepvariant`'s `--model_type`s except the RNA ones.
- **Examples:** hard calls in HG003 (GRCh38, chr20) from DeepVariant's own case studies, for each model.
- **Faithful:** it runs DeepVariant's own Python and C++ (compiled to WebAssembly), not a rewrite, and gives
  the official case studies' genotypes for every model (`wasm/README.md`, "Reproducing a real run").

- **No call where you expected one:** enter the position, and the page shows what DeepVariant counted there
  (each allele's reads against the thresholds a candidate has to pass) and lets you force that candidate
  (`--variant_caller=vcf_candidate_importer`), to see its pileup image and what the CNN makes of it. A
  small-model call can be rerun through the CNN the same way.
- **Share a locus:** "Download this locus" saves one `.zip` with the reads at the locus, the calls, the reads
  as DeepVariant saw them and the pileup images, made in the browser. Pick that `.zip` as the reads to open it.

This is an independent tool, not made by or affiliated with the DeepVariant team at Google.

## Your data

Only the reads are required. Without a position, the app reads the BAM's header and index to find where the
reads are and runs there: on the first low-GQ call (or no-call, or 1/2) of your VCF among the reads, if you gave
one; otherwise in the middle of a snippet BAM, or where a whole-genome BAM's reads start. The reference (GRCh38 or
GRCh37) is detected from the header's contig lengths, with contigs named `chr1` or `1` (b37, hs37d5). CRAM isn't
read (decoding it needs the reference's sequence): cut a BAM of the locus with `samtools view -b -T`.

Reads can be a local BAM of any size (with its index): it's read from disk on demand, so only the locus is read.
Or a URL, read with HTTP range requests, so only the locus is downloaded. The server has to allow requests from
other sites (CORS); for a bucket, a rule like this:

```bash
# Google Cloud Storage
echo '[{"origin": ["*"], "method": ["GET", "HEAD"], "responseHeader": ["Content-Length", "Content-Range", "Accept-Ranges"], "maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://BUCKET --cors-file=cors.json
```

To try it without your own data, the page links two whole-genome HG003 BAMs from DeepVariant's case studies
(Illumina WGS 35x, 46.8 GB; PacBio HiFi, 50.3 GB). DeepVariant's bucket has no CORS, so they're read through
[42basepairs](https://42basepairs.com), which serves it with range requests and CORS.

On AWS S3, the same as a bucket CORS configuration (AllowedMethods GET and HEAD, AllowedOrigins `*`,
ExposeHeaders Content-Length, Content-Range, Accept-Ranges). Links to a locus include the reads' URL, so a locus
of data on such a server can be shared.

## Run it locally

```bash
npm install
npm run assets   # DeepVariant for the browser (265 MB), from this repo's release; or build it: ./wasm/build.sh
npm run dev
```

| Where                                     | What                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/Inspector.svelte`                    | The app                                                                                                 |
| `src/models.js`                           | The models, their pileup channels, and the examples                                                     |
| `src/vcf.js`                              | Reads a DeepVariant VCF in the browser, without an index                                                |
| `src/bundle.js`                           | A locus as one `.zip`, written and read in the browser                                                  |
| `wasm/`                                   | DeepVariant for the browser: build, worker (`wasm/web/`), model conversion, tests. See `wasm/README.md` |
| `public/deepvariant/1.10.0/` (gitignored) | What `wasm/build.sh` makes, or `npm run assets` downloads                                               |
| `work/` (gitignored)                      | Large working files (below)                                                                             |

## Deploying

The site is static: `npm run build` writes `dist/`. `.github/workflows/pages.yml` builds and deploys it to GitHub
Pages on every push to `main` (Pages needs a public repo, or a paid plan for a private one). DeepVariant for the
browser is too big for git, so it lives in the release `assets-1.10.0`: after rebuilding it, upload it with
`./scripts/package-assets.sh`.

## `work/`

Gitignored files kept for rebuilding and checking things, none needed to run the app:

| Folder             | What                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `work/pangenome/`  | HPRC v1.1 as a GBZ-base database (6.3 GB, for `wasm/examples.sh`), and the example subgraphs |
| `work/models/`     | The models' TensorFlow SavedModels and conversions (`wasm/convert/models.sh`)                |
| `work/validation/` | Official case-study VCFs and hap.py results (HG003, chr20), slices and runs used for checks  |
| `work/bin/query`   | gbz-base's `query` (macOS arm64), for `wasm/tools/gbz_haplotypes_bam.py`                     |
| `work/tfenv/`      | Python 3.12 with TensorFlow 2.16.1 and tf2onnx, for `wasm/convert/models.sh` outside Docker  |
| `work/release/`    | The assets tarball (`scripts/package-assets.sh`, `npm run assets`)                           |
| `work/notes/`      | DeepVariant r1.10 docs and sources consulted                                                 |

## License

The app's code: MIT ([LICENSE](LICENSE)). DeepVariant is BSD-3-Clause, © Google LLC
([license](https://github.com/google/deepvariant/blob/r1.10/LICENSE)).
