# Academic Papers Module

> Academic paper search specific strategy extracted from web-search-agent.md

**Trigger scenario**: Paper search, academic research, algorithm principles

## Sources (Academic Sources)
- **Google Scholar** (scholar.google.com) - comprehensive academic search engine (Excellent for native BibTeX extraction)
- **arXiv** (arxiv.org) - preprints in physics, math, CS, and related fields
- **DBLP** (dblp.org) - Computer Science bibliography (Highly prioritized for extracting exact BibTeX records)
- **Hugging Face Papers** (huggingface.co/papers) - daily/monthly trending ML/AI papers with community upvotes
- **ResearchGate** (researchgate.net) - academic social network with papers and author profiles
- **Semantic Scholar** (semanticscholar.org) - AI-powered academic search
- **ACM Digital Library** and **IEEE Xplore** - CS and engineering papers

## Query Strategy (1.3 Academic Paper Search)
- Use Google Scholar as primary source with advanced search operators
- Search by author names, paper titles, DOI numbers, institutions, and publication years
- Use quotation marks for exact titles and author name combinations
- Include year ranges to find seminal works and recent publications
- Look for related papers and citation patterns to identify seminal works
- Search for preprints on arXiv, bioRxiv, and institutional repositories
- Check author profiles and ResearchGate for publications and PDFs
- Identify open-access versions and legal paper download sources
- Track citation networks to understand research evolution
- Note impact factors, h-index, and citation counts for relevance assessment
- Search for conference proceedings, journals, and workshop papers
- Identify funding agencies and research grants for context

## BibTeX & Citation Standards (CRITICAL)
When operating in this module, you MUST provide a clean, valid BibTeX entry for every recommended paper.
1. **Source of Truth:** Do not hallucinate citation data. Prioritize fetching the official BibTeX string directly from the source (e.g., Google Scholar's "Cite" feature, DBLP's BibTeX export, or Semantic Scholar).
2. **Completeness:** Ensure the BibTeX entry includes essential fields: `author`, `title`, `journal` or `booktitle`, `year`, and ideally `url` or `doi`.
3. **Key Formatting:** If you must construct the BibTeX manually from metadata, use a standardized citation key format (e.g., `FirstAuthorLastNameYearFirstKeyword`).

## Output Format Extension
When compiling your findings, append the BibTeX to each paper in your detailed list using the following structure:

### [Paper Title] ([Year])
- **Authors:** [List of main authors]
- **Key Contribution:** [1-2 sentences explaining relevance]
- **Link:** [Direct URL to PDF or arXiv page]
- **BibTeX:**
```bibtex
@article{key,
  title={...},
  author={...},
  ...
}