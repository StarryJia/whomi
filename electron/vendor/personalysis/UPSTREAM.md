# Personalysis provenance

Source: https://github.com/StarryJia/personalysis-skill/tree/db0da388d78cfa12e75147c5a55798f6fe926e22

Repository: https://github.com/StarryJia/personalysis-skill

Commit: db0da388d78cfa12e75147c5a55798f6fe926e22

Version: 0.2.0

License: MIT; see LICENSE. Copyright (c) 2026 StarryJia.

SKILL.md and LICENSE are copied verbatim. SHA-256 values below use LF-normalized UTF-8 text, including the final newline. The body removes YAML frontmatter with `/^---\n[\s\S]*?\n---\n+/`. Git blobs identify the original upstream files.

| Resource | Git blob | LF SHA-256 |
|---|---|---|
| SKILL.md | a3ed5068a817b94819efed6678b167877e5d9494 | 64f1b981d6a09d8f9a3442818f9aa1441f36ddce898c6fe166207ab3d3627ab3 |
| SKILL.md body without frontmatter | Derived from SKILL.md | 0144ef7227b24f8225b479defdc716e79f7fc72ab8babb9e9c0c37d891557bf7 |
| LICENSE | 361bb3c7123dc5fe5873dc9a221ae86bb7b55ccf | f13c7b1dffaf2e151e3ee52ec20727782076b49f8644062421fbc00b6b284454 |

Local integration: index.ts verifies the statically bundled text and exposes the stripped body to both Electron processes. Whomi owns the task, authorization, report format, and storage boundaries in its host adapter; these do not modify the upstream core.

references/theory-basis.md is intentionally excluded from this bundle and routine model requests. Relative links in the core do not grant file access; the host explicitly forbids reading them or claiming to have consulted unread references. No runtime network fetch or external repository is required.
