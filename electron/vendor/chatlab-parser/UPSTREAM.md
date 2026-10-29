# ChatLab parser provenance

Source: https://github.com/ChatLab/ChatLab/tree/f19beeadda27bd57eedc1bfbe75e7ed1b9e86833

License: AGPL-3.0; see LICENSE. Local integration only; public combined distribution licensing remains unresolved (GSAP). No whole-project license chosen. Original file comments retained. All fixtures are independently authored synthetic data.

Changes on 2026-10-29: relative shared-type imports; extract only parser enums/interfaces; remove native-wrapper imports and calls; remove unused preprocessing hooks. Any subsequent modifications are listed below. Runtime dependencies: stream-json 1.9.1 and stream-chain 2.2.5 (BSD-3-Clause); types 1.7.8 and 2.1.0 (MIT), pinned from upstream lockfile. No node-runtime, native binaries, samples or package entry service copied.

Additional local changes: all filesystem imports in formats and utils redirect to `electron/data/parsers/snapshot-fs.ts`. This facade authorizes only the controlled snapshot entry and explicitly listed dependencies, validates descriptors before reads, and carries scope through asynchronous generator consumption. The integration calls these modules only via its adapter; direct vendor entry points are not an application API. Source semantics, JSON safety preflight and event conversion live outside this vendor directory. The copied browser/telegram helper is required by the single-chat module; browser/weflow, validators, preprocessors, native wrappers and package entry service are excluded.

The adapter retains raw source records alongside bounded upstream results to preserve whitespace, unsafe integer identifiers, unknown records and source ordinal counts. Only ChatLab JSONL is advertised as streaming; the other modules have a 32 MiB combined input cap. See `docs/research/chatlab-parser-reuse.md` for the tested capability matrix, maximum depth/property restrictions, security advisory residuals and local-only licensing boundary.

Review fixes on 2026-10-29: `chatlab.ts`, `shuakami-qq-exporter.ts`, `tyrrrz-discord-exporter.ts`, `weflow.ts` and `telegram-native.ts` wrap parsed-record and batch-completion event callbacks with the local `electron/data/parsers/stream-guard.ts` helper. Callback exceptions reject the awaited operation, destroy its input/pipeline streams and suppress subsequent guarded callbacks. WeFlow owner scanning propagates failures instead of silently continuing. Original source hashes below remain unchanged provenance records, not hashes of modified local files. No dependency version was changed.

| Upstream file | Original SHA-256 | Local path |
|---|---|---|
| packages/parser/src/browser/line.ts | bcf62485cd94cecb990abd34e44ca73cdd35097d99289640f22a07752eebc4aa | src/browser/line.ts |
| packages/parser/src/browser/qq.ts | e4ed48defecd940a9846976bce345be157ea24d2546d2307ad15a7568c664078 | src/browser/qq.ts |
| packages/parser/src/browser/telegram.ts | e74f8b7cb921e10e6c6ef8e0504197e11b2f4ec047d9ccddc464146c82219ed4 | src/browser/telegram.ts |
| packages/parser/src/browser/whatsapp.ts | 8eeaf54ec72775fbd11f4c41aef0d11c3d5baa18d3792666970366834d4bdbe2 | src/browser/whatsapp.ts |
| packages/parser/src/format-ids.ts | d423806b7244e76447c1f9155878cd6882c61890669e841a37055a8d2329cf24 | src/format-ids.ts |
| packages/parser/src/formats/chatlab-jsonl.ts | bc63642376613d252be6167a8810b91097e333eaa17e485b30bce02972ef4ece | src/formats/chatlab-jsonl.ts |
| packages/parser/src/formats/chatlab.ts | 8c354dc33e61164092d19fcb90b329578368b5d3c2581ee9e7900da9d7ef25dc | src/formats/chatlab.ts |
| packages/parser/src/formats/google-chat-takeout.ts | ca07eda5f91d8ffb9adbda6a3d29038fd615038543da90cd347e01c518933200 | src/formats/google-chat-takeout.ts |
| packages/parser/src/formats/index.ts | abf2e4a75993af554301b010d2d84a5fc24bb85f4a95c641e2bf00194b589eab | src/formats/index.ts |
| packages/parser/src/formats/instagram-native.ts | 4705888ce553dc4d159c03d2523534fcab420a590b35314005ddd60b647b87de | src/formats/instagram-native.ts |
| packages/parser/src/formats/line-native-txt.ts | a4bac81cb9a763ec3bc2115b15c68123d1eaaf8bb10b0e0935fa6cfc017fc1c2 | src/formats/line-native-txt.ts |
| packages/parser/src/formats/qq-native-txt.ts | fd7850514bb82282c220aa5c58b86308a75db4f5d29adf763de11f8038f5b160 | src/formats/qq-native-txt.ts |
| packages/parser/src/formats/shuakami-qq-exporter-chunked.ts | 1516141752d6d7ceedc41ea66c6fe0673ddfd3340adaa7653b6322192715eff5 | src/formats/shuakami-qq-exporter-chunked.ts |
| packages/parser/src/formats/shuakami-qq-exporter.ts | fc1d2e1b5a730f1aa4ae6872c711966a769a56a22a2cf9ba1c9fa381a75455ab | src/formats/shuakami-qq-exporter.ts |
| packages/parser/src/formats/telegram-native-single.ts | 0942bc6b6f8690b17c137d097d1bf540fa82d02d5a97e59391f05c16c82a875c | src/formats/telegram-native-single.ts |
| packages/parser/src/formats/telegram-native.ts | 7a36594b8cdc0cb4a1f408d98385540594d8e2993f830b8ae181de0e8f71855e | src/formats/telegram-native.ts |
| packages/parser/src/formats/tyrrrz-discord-exporter.ts | 60bb10dd91f4f06a627354488e7d94e53e59fdcbf62aaf3cfd33e0d2f70f6544 | src/formats/tyrrrz-discord-exporter.ts |
| packages/parser/src/formats/utils/telegram-utils.ts | 3b4302c88909929238176537831699c379e30b1b2775ef5467ac9555b892a326 | src/formats/utils/telegram-utils.ts |
| packages/parser/src/formats/weflow.ts | 2f22acca6cb6cfa01dfe010b446ba7da6c34c133eb74b0ddcffeeef844c29395 | src/formats/weflow.ts |
| packages/parser/src/formats/whatsapp-native-txt.ts | 247e84b7b1639a9e767ff3acda58c390c41a6a44442f953eb66fdf9ab3237915 | src/formats/whatsapp-native-txt.ts |
| packages/parser/src/formats/ycccccccy-echotrace.ts | fb8bb2292b367ed48e541908252a3d33f35ec6f358be7df79faf3c178f3c1942 | src/formats/ycccccccy-echotrace.ts |
| packages/parser/src/types.ts | 00e046b1460859147ba813233f6c8604466c97225cc56000eff47b52e6f09fcf | src/types.ts |
| packages/parser/src/utils.ts | 49cbe3237b272b7f1aed0599cd6a2a096dcab86423f862f94205b5692856cc43 | src/utils.ts |
| packages/shared-types/index.ts | 42e421da83b9998a0a09d00a912e1390f75b23439da964ad9eadc41064c1412c | shared-types/index.ts (extracted declarations only) |
