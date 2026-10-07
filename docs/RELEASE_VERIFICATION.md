# Publication verification

Prepared on **6 October 2026** from the instructor's course applications. Only the two selected reference projects and public contribution documentation were imported into the existing repository. The reference websites were published on **7 October 2026** from merged application commit [`7b8df04e540ab76ab17c07abc5b0e26b49d35175`](https://github.com/adnanmasood/fintech-samples/commit/7b8df04e540ab76ab17c07abc5b0e26b49d35175).

| Website | Public URL | Verified production artifact |
|---|---|---|
| Fintech Algorithms | [Open the learning app](https://usf-fintech-algorithms.vercel.app) | `dpl_5LAWk9kdPWG5MPdeFtn3DiRyYBPo` |
| Payment Rails | [Open the project guide](https://usf-payment-rails.vercel.app) | `dpl_F7TR9MRnboLDTFSchNYYWkKRymZd` |

Both standard domains return HTTP 200 without Vercel authentication. Protected previews were tested with short-lived OIDC headers scoped to the deployment origin. Production builds were staged with `--prod --skip-domain`, checked through authenticated Vercel HTTP access, and promoted without rebuilding. Domain inspection confirms that each public site serves the exact checked production artifact.

## Fintech Algorithms

| Check | Result |
|---|---|
| Reproducible installation | Frozen lock file; Node 24.19.0 and pnpm 11.25.0 |
| Teaching content | 12 algorithms, 39 measures, 64 exercises, 61 topics, 319 lessons, 732 explained questions |
| Types and components | Zero Astro errors; zero Svelte errors or warnings; existing informational hints remain |
| Production build | Static pages and Pagefind search built successfully |
| Unit tests | 756 passed in 22 files |
| Clean-checkout browser suite | 301 passed, including browser Python, search, navigation, saved progress, keyboard access, layouts, and offline preparation |
| Clean-checkout notebooks | All 12 examples executed and printed their primary metrics; offline reload and return to the course passed |

Ordinary visits do not download the complete course. The optional offline control exposes its download size, progress, retry, update, and removal behavior. Tests cover interrupted downloads, retention of the previous complete cache, successful retry, offline reload, and preservation of learner progress after removal. The complete optional inventory is approximately **116.9 MiB** before transfer compression.

Clean-checkout testing identified a required OpenBLAS ZIP excluded by an archive ignore rule. That library is now tracked with its upstream license. The publication check verifies that every pinned scientific package is present, staged or tracked, and matches its lock-file hash. Browser checks also cover narrow-screen text reflow and navigation controls when text is doubled; fixes retain the existing teaching and progress behavior.

## Payment Rails

| Check | Result |
|---|---|
| Python suite | 25 passed, including financial rules, exact fee arithmetic, six-process integration, HTTP commands, launcher startup, shutdown, and source packaging |
| Static guide | Built successfully with the selected PDFs, diagrams, screenshots, and downloadable source ZIP |
| Desktop/mobile | Checked at 1,440 px and 390 px; no page overflow, serious automated accessibility findings, or browser errors |
| Links/downloads | Internal links, anchors, PDF downloads, images, and source download verified locally |
| Document review | All 30 pages across the two PDFs and the selected screenshots reviewed; metadata identifies the course |

The illustrative $50 purchase shows a $50 authorization hold, a $450 posted payer balance after clearing, and **$48.75 merchant proceeds** after $1.25 in demonstration fees. The hosted site is a guide; the unchanged Python simulator runs locally or in Docker. Project 0 remains an instructor reference with an unscored exploration checklist.

## Privacy and release controls

- Private course folders, individual assignment packets, raw authoring sources, caches, dependencies, local configuration, generated QA, and old distributions are excluded.
- The original private roster comparison found no known student-name matches in the selected instructor source files or PDF text. The comparison list is not published.
- Screenshots, notebook examples, course datasets, and payment fixtures contain fictional demonstration data. No learner progress, student records, grades, or real financial records are included.
- Source and deployment inventories passed the publication check. The CLI upload contains 1,244 regular files; its paths and hashes exactly match the isolated instructor export. Vercel's received source inventory was also compared with the dry-run upload inventory. Required Python archives and component license notices are retained.
- Instructor authorship and the repository's existing license history are preserved. Public GitHub identities and commit metadata remain visible.

[Repository CI](https://github.com/adnanmasood/fintech-samples/actions/workflows/verify.yml) repeats content validation, type checks, unit tests, the full browser suite, notebook execution, Payment Rails tests, and publication checks. The full suite passed for the packaging PR and for the [merged application commit in GitHub CI](https://github.com/adnanmasood/fintech-samples/actions/runs/37569514280): 756 unit tests, 301 browser tests, 12 notebook examples, and 25 Payment Rails tests.

## Hosted verification

- Fresh unauthenticated production browser contexts passed at 1,440 px and 390 px, with no page errors, horizontal overflow, or serious/critical automated accessibility findings on the checked pages. Keyboard skip links, course search, deep links, and persisted defense responses were verified.
- The public Algorithms site completed its real Python baseline and executed the logistic regression notebook in JupyterLite. The browser check waits for kernel readiness and active code-cell selection before running the notebook. Normal service-worker behavior is preserved.
- All Payment Rails anchors, images, PDF links, and the source download passed on the public site. The published ZIP contents exactly match the audited, tested preview/staged package; its 55 members contain the Docker-ignore policy, guide build inputs, manifests, and license.
- The actual preview source download passed all 25 tests after extraction and rebuilt the static guide. The missing-`.dockerignore` build, policy drift rejection, and missing-required-input rejection passed in CI.
- The deployment export admits only committed `fintech-algorithms/`, `project-0-payment-rails/`, `LICENSE`, and `.vercelignore`. Existing student contributions, including folders outside `student-projects/`, are excluded. No Git metadata, dependencies, local environment/configuration, old distributions, or generated QA are uploaded.
- The simulator remains local; its Python code and APIs are unchanged. Docker launch was documented but not executed because the local Docker daemon was not running. No paid services, GitHub integration, hosted payment backend, or student accounts were added.

These README and release-record updates do not change the deployed application files. Later GitHub commits may include documentation or student contributions; the application commit above identifies the code actually published.

## Repository reorganization

The current repository places the existing loan-review and fraud-screening submissions at `student-projects/ahmad-abuadas/` and `student-projects/huei-en-cho/`. The Payment Rails instructor sample now lives at `student-projects/project-0-payment-rails/`. The [project index](../student-projects/README.md) links to all three.

The paths and verification results above describe the historical published application commit. This move updates repository documentation, the guide source link, and repository check paths. Vercel settings, deployment configuration, export utilities, and published artifacts remain unchanged. No builds, PDF regeneration, or archive regeneration were performed for this move. The already published Payment Rails guide retains its earlier GitHub source link until a future deployment.
