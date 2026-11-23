# Search Topics Reference

Per-topic source and query strategy, distilled from `knowledge/web-search-modules/`. Use the topic section that matches the question; each lists where the answers live and how to query for them.

## General web

Trigger: general information, news, product comparison, best practices.

Sources:

- Official documentation and changelogs - authoritative, read these first.
- Reddit topic subreddits - real-world experience and failure reports.
- Hacker News discussions - high-quality technical discourse.
- Dev.to and Medium - technical articles with worked examples.
- Project Discords and maintainer posts on X/Twitter - announcements and intent.

Query strategy:

- Look for official recommendations first, then cross-reference with community consensus.
- Find examples from production codebases, not tutorial snippets.
- Identify anti-patterns, common pitfalls, and deprecated approaches.
- Build structured comparisons with explicit criteria: performance, maintenance, learning curve, license.
- Prefer benchmarks and real usage reports over opinion pieces.

Tool: `ddgs` `search_text`, then `ddgs` `extract_content` on the best hit. Fall back to `websearch` only when ddgs surfaces nothing useful.

## Academic papers

Trigger: paper search, academic research, algorithm principles.

Sources: Semantic Scholar, arXiv, DBLP, Hugging Face Papers (trending ML/AI), Google Scholar, ResearchGate, ACM Digital Library, IEEE Xplore.

Query strategy:

- Search by author name, exact title in quotes, DOI, institution, and publication year.
- Use year ranges to separate seminal work from recent publications.
- Track citation networks to find seminal work and follow-on results.
- Search arXiv and institutional repositories for preprints and open-access PDFs.
- Note citation counts and venue quality when judging relevance.
- Hugging Face Papers is a good first stop for trending ML/AI work, not for exhaustive coverage.

BibTeX rule: provide a clean, valid entry for every recommended paper, taken from the source's own export (DBLP or Semantic Scholar), not composed from memory. Required fields: `author`, `title`, `journal` or `booktitle`, `year`, and ideally `url` or `doi`. When a key must be built by hand, use `FirstAuthorLastNameYearFirstKeyword`.

Tool order: `semantic-scholar` / `arxiv` / `dblp` first, `ddgs` for Hugging Face Papers and blog coverage, `webfetch` for Papers With Code.

## Chinese-language tech

Trigger: Chinese technical questions, Chinese vendor frameworks, solutions published in Chinese communities.

Sources: CSDN, Juejin, SegmentFault, Zhihu, Cnblogs, OSChina, V2EX, Tencent Cloud and Alibaba Cloud developer communities.

Query strategy:

- Generate queries in both English and the community's native language.
- Use native-language technical terms for errors and solutions; an English query often misses these sources entirely.
- Search the Chinese developer sites with native-language keywords, then verify any fix against the library's official docs before citing it.

Tool: `ddgs` with region and language hints where available; `websearch` as fallback.

## GitHub and error debugging

Trigger: project bugs, error debugging, issue searching, version-specific problems.

Sources: GitHub issues (open and closed), pull requests, release notes.

Query strategy:

- Search the exact error message in quotes.
- Match against issue templates and reproduction patterns.
- Look for workarounds, not just explanations.
- Check whether it is a known bug with an existing patch or PR.
- Look for near matches when the exact message finds nothing.
- Determine whether the issue is version-specific; check which releases are affected.
- Check closed issues for the resolution pattern - how it was fixed or ruled out.

Tool: `github` issue and code search first; `ddgs` on the exact quoted message as fallback.

## Stack Overflow and Q&A

Trigger: programming Q&A, code implementation, API usage.

Sources: Stack Overflow and other Stack Exchange sites, technical forums and discussion boards.

Query strategy:

- Search the exact error or API call, then a natural-language paraphrase.
- Read the accepted answer and the highest-voted competing answers; they often disagree on version boundaries.
- Check the answer date against the version in use - accepted answers go stale.
- Prefer answers that quote the official docs or link a repro.

Tool: `ddgs` with the site name in the query; `webfetch` the answer page for the full context.

## Datasets and benchmarks

Trigger: dataset selection, benchmark choice, leaderboard numbers, "what do people evaluate this on".

Sources:

- The paper that introduced the dataset or benchmark, via Semantic Scholar or arXiv.
- The benchmark's official site and its leaderboard.
- Dataset hosting pages: Hugging Face Datasets, Zenodo, OpenML, the project's own download page.

Query strategy:

- Search the task name plus "benchmark" or "dataset", then confirm the introducing paper before trusting a leaderboard.
- Read the license and access terms: research-only, gated, or redistributable decides whether it can ship with the paper.
- Note the version and the split protocol; a v1 and v2 leaderboard are not comparable.
- Check whether reported baselines used the official split or a custom one.

Tool: `semantic-scholar` for the introducing paper, `ddgs` for the official site, `github` when the loader or split files live in a repo.

## Sensor, hardware, and standards

Trigger: sensor specifications, calibration, robotics hardware, interface standards, protocol documents.

Sources:

- Vendor datasheets and product pages: Intel RealSense, Ouster, Velodyne, Livox, FLIR, Basler, ZED, Hesai.
- Standards bodies and specifications: IEEE, ISO, ROS REPs, USB/Ethernet/MIPI specs.
- Official SDK and driver repositories for the device.

Query strategy:

- Query the exact model number plus the field of interest (range, FOV, resolution, rate, accuracy); model numbers disambiguate better than product names.
- Prefer the datasheet PDF over retail listings or reviews.
- Record units, test conditions, and whether the figure is typical or guaranteed.
- Check the SDK repo for known limitations that the datasheet omits.

Tool: `ddgs` on the vendor or standards page, `webfetch` the datasheet PDF, `github` for the driver or SDK.

## Robotics and ROS documentation

Trigger: ROS, ROS 2, Nav2, MoveIt, Gazebo, tf2, message definitions, launch files, distro-specific behavior.

Sources:

- Official docs per distro (docs.ros.org, navigation.ros.org, moveit.picknik.ai).
- Package source and issue trackers on GitHub.
- ROS Answers and Robotics Stack Exchange.

Query strategy:

- Name the distro in the query (humble, jazzy, iron); behavior and APIs differ across releases.
- Prefer the versioned docs URL over the unversioned one.
- Check the package's GitHub for open issues when the docs are silent or stale.
- Confirm message and frame conventions in the source, not from memory.

Tool: `ddgs` on the docs site, `github` for source and issues, `webfetch` for the versioned page.

## Reproducibility packages and DOIs

Trigger: reference implementation, code release, archival record, "where is the code and data for this paper".

Sources:

- The paper's project page and its linked GitHub repository.
- Archival records: Zenodo, OSF, figshare, Hugging Face model and dataset hubs.
- Release tags, Docker images, and environment files inside the repo.

Query strategy:

- Start from the paper's abstract or project page; the official repo is usually linked there.
- Prefer the Zenodo or OSF DOI over a bare repo URL when citing, since the DOI is versioned and archival.
- Check the release tag or commit that matches the paper's reported numbers.
- Look for the environment pins (requirements, lockfile, Dockerfile) that make reruns possible.

Tool: `github` for the repo, `ddgs` for the Zenodo or OSF record, `webfetch` the DOI landing page.
