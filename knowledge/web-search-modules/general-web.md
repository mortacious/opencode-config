# General Web Module

> General web search strategy extracted from web-search-agent.md

## Local search (ddgs MCP)

For general web lookups, prefer the `ddgs` MCP server (wired for the `research` and `sparring` agents only - NOT for build/plan, which delegate search). It is quota-free (scrapes DuckDuckGo). Tools:

- `search_text` - general web search. Pass `query` (required) and optional region/max_results.
- `extract_content` - fetch a URL and return its text. Pass `url` (required) and `fmt` (`markdown` default, or `plain`/`rich`).
- `search_news`, `search_images`, `search_videos`, `search_books` - typed variants.

Fall back to the `websearch` tool only when ddgs does not surface the needed source. The `build` and `plan` agents do NOT have ddgs in their mcps - they delegate web search to `research`/`explore`.

---

**Trigger scenario**: General information, news, product comparison, best practices

## Sources
- **Reddit** (r/programming, r/webdev, r/javascript, r/python, r/linux and topic-specific subreddits) - real-world experiences
- **Official documentation** and changelogs - authoritative information
- **Blog posts** and tutorials - detailed explanations
- **Hacker News** discussions - high-quality technical discourse
- **Dev.to** (dev.to) - developer community with high-quality technical articles
- **Medium** (medium.com) - technical blog platform with in-depth articles
- **Discord** - official discussion channels for many open source projects
- **X/Twitter** - technical announcements and discussions from developers and maintainers

## Query Strategy (1.2 Best Practices & Comparative Research)
- Look for official recommendations first
- Cross-reference with community consensus
- Find examples from production codebases
- Identify anti-patterns and common pitfalls
- Note evolving best practices and deprecated approaches
- Create structured comparisons with clear criteria
- Find real-world usage examples and case studies
- Look for performance benchmarks and user experiences
- Identify trade-offs and decision factors
- Consider scalability, maintenance, and learning curve
