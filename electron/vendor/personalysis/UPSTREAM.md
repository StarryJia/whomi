# Personalysis provenance

Personalysis 0.3.1 is bundled from commit `f52abd7b49aecab92dba4ab4cb985c2a11ab5d5e`. [Upstream repository at this commit](https://github.com/StarryJia/personalysis-skill/tree/f52abd7b49aecab92dba4ab4cb985c2a11ab5d5e)

Copyright (c) 2026 StarryJia. Distributed under the [MIT license](LICENSE).

`SKILL.md` and `LICENSE` are verbatim upstream files. Their SHA-256 checksums use LF-normalized UTF-8 text including the final newline. The body removes the frontmatter with `/^---\n[\s\S]*?\n---\n+/` and trims surrounding whitespace. Each slice joins the trimmed core and its trimmed task section, including its heading, with two newlines.

| Resource | Git blob | LF SHA-256 |
|---|---|---|
| SKILL.md | 20ae427ca0c280945918a0e9bf40a25aadf19602 | 4fbec1ceb6eaf5c30ca7e3e283ca41517dcf7d52d60770cc8bbfc4f3e37a2d11 |
| Trimmed body | Derived from SKILL.md | 69a9871404372c408c1d975b79e3e8ff5112026a0a45a046ac5a2b6107cc06fa |
| Core + Task: Material analysis | Derived from SKILL.md | d8b6a555eea788a2ec0ebc2f737fffd03833fe2d3fcb348ba3fb95ff9fef9bd4 |
| Core + Task: Interactive dialogue | Derived from SKILL.md | 3ea201431221acc679416d2de9b014c3b83c46a90f9358cd5f418a988c9986b7 |
| LICENSE | 361bb3c7123dc5fe5873dc9a221ae86bb7b55ccf | f13c7b1dffaf2e151e3ee52ec20727782076b49f8644062421fbc00b6b284454 |

The loader verifies the pinned manifest, source, body, final two level-two headings and both task slices. Insight requests receive the material analysis slice. Dialogue requests receive the interactive dialogue slice. Whomi supplies the task, authorization, report format and storage boundaries through its host adapter.

The core describes how to use the methodology when local references are unavailable. Whomi bundles only the skill and license from upstream and loads the methodology locally.
