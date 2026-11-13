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

This is an independent tool, not made by or affiliated with the DeepVariant team at Google.

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

The app's code doesn't have a license yet. DeepVariant is BSD-3-Clause, © Google LLC
([license](https://github.com/google/deepvariant/blob/r1.10/LICENSE)).
