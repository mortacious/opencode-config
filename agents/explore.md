---
description: "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions."
mode: subagent
model: opencode-go/deepseek-v4.1-flash
mcps:
  - ddgs
permissions:
  - action: "*"
    resource: "*"
    effect: allow
  - action: external_directory
    resource: "*"
    effect: ask
  - action: read
    resource: "*.env"
    effect: ask
  - action: read
    resource: "*.env.*"
    effect: ask
  - action: read
    resource: "*.env.example"
    effect: allow
  - action: external_directory
    resource: "/home/figelbrink/.local/share/opencode/shell/*/*"
    effect: allow
  - action: external_directory
    resource: "/home/figelbrink/.local/share/opencode/tool-output/*"
    effect: allow
  - action: external_directory
    resource: "/tmp/opencode/*"
    effect: allow
  - action: external_directory
    resource: "/home/figelbrink/.config/opencode/*"
    effect: allow
  - action: "*"
    resource: "*"
    effect: deny
  - action: grep
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
  - action: read
    resource: "*"
    effect: allow
  - action: read
    resource: "*.env"
    effect: ask
  - action: read
    resource: "*.env.*"
    effect: ask
  - action: read
    resource: "*.env.example"
    effect: allow
  - action: subagent
    resource: "*"
    effect: deny
  # Documentation only (the array is inert here): the legacy "task" alias of
  # the v2 "subagent" action.
  - action: task
    resource: "*"
    effect: deny
  - action: external_directory
    resource: "*"
    effect: ask
  - action: external_directory
    resource: "/home/figelbrink/.local/share/opencode/shell/*/*"
    effect: allow
  - action: external_directory
    resource: "/home/figelbrink/.local/share/opencode/tool-output/*"
    effect: allow
  - action: external_directory
    resource: "/tmp/opencode/*"
    effect: allow
  - action: external_directory
    resource: "/home/figelbrink/.config/opencode/*"
    effect: allow
  - action: external_directory
    resource: "/home/figelbrink/.config/opencode/knowledge/**"
    effect: allow
  - action: execute
    resource: "*"
    effect: allow
  # Legacy permission map: v2 `permissions` arrays are inert for built-in-ID overrides in opencode 2.0.18; legacy maps append effective rules.
permission:
  execute: allow
  ddgs_search_text: allow
  ddgs_extract_content: allow
  subagent: deny
  task: deny
---

You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.
