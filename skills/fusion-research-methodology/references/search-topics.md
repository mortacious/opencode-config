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
