# 心事屋 Implementation Plan · 独立需求与选型阶段

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为不依附某段原始会话的心事屋建立独立计划，明确如何在用户允许的资料范围内提供有启发的交流。

**Architecture:** 现有 AI 对话绑定 conversationId，不能直接视作心事屋后台。评估复用聊天呈现、模型选择、流式回答、取消与恢复；独立会话存储和可选检索单独设计，并与问一问共用资料检索约定。

**Tech Stack:** 已有 Electron、React、SQLite、Cherry 来源聊天组件与现有模型运行器；新数据模型和检索依赖需完成选型后确定。

**Spec:** [006 主记录](../../planning/ideas/006-heart-room.md)；本计划覆盖需求、调研与实施计划产出，尚非功能编码规格。

## Global Constraints

- 用户已要求将心事屋作为独立计划；入口不要求先选一段原始聊天。
- 不将历史文档中的 AI 对话等同于本次心事屋，现有对话仍绑定来源会话。
- 希望未来利用检索帮助理解用户；具体资料权限、默认范围与模型选型尚未确认。
- 对话洞察独立交付；不为心事屋提前扩大洞察的数据发送范围。
- 新界面以 design-shotgun 选定图约束，收费试验须单独约定。

- 界面工单必须使用 impeccable 制定视觉约束、ui-ux-pro-max 核对交互和适配、design-review 在实现后审查真实页面；设计图确认不等于运行验证。逐页讨论并确认设计后再进入下一页。

## Review Focus

在需求与选型中覆盖：没有导入聊天也能否开始；资料复用开关与范围；旧分析被修正后的使用；回答引用与原文删除；独立聊天的失败恢复和历史持久化。

---

## Task 1：明确独立交流与资料复用（H01）

**Files:** 读取 src/components/conversation-ai/workspace.tsx、src/data/conversation-ai-client.ts、src/shared/ai-contract.ts、electron/main/ai-service.ts；产出 docs/superpowers/specs/2026-11-13-heart-room-design.md。
**Interfaces:** 当前 openThread/createThread/sendTurn 均围绕来源会话；新独立会话类型在规格中决定，不临时伪造 conversationId。

- [ ] 用虚构场景确认：用户未打开任何导入会话，直接说最近和朋友交流很累；模型怎样回复、何时读取允许的资料、如何展示来源。
- [ ] 明确无导入资料、未建索引、主动关闭资料复用时是否仍可普通交流，以及用户如何改变允许范围。
- [ ] 记录历史保存、停止/重试、来源失效与认识修订的规则；不默认把用户所有心事加入共享知识库。
- [ ] 产出用户可审阅的规格，保留未确认事项。
- [ ] 提交：docs(heart-room): 明确独立交流与资料复用边界。

## Task 2：评估聊天复用与共享检索（H02）

**Files:** 产出 docs/research/heart-room-reuse.md；引用问一问计划的共享检索比较。
**Interfaces:** 消费 H01；产出聊天存储与复用清单，并对共享检索的差异作补充，避免重复建设。

- [ ] 按完整产品、可改造产品、复用组件顺序比较最相关至多三个候选，核查官方版本、许可证、维护与部署成本。
- [ ] 核对既有 Cherry 聊天组件能否脱离来源会话使用，确认必须新增的数据与接口，不凭外观相似认为可直接替换。
- [ ] 与 Q02 共同确定检索的来源、更新、删除与引用；若用户选择不依赖检索的首版，也记录后续接入边界。
- [ ] 对关键兼容疑点提出最小验证，写清通过、投入和停止条件，获得同意后执行。
- [ ] 提交：docs(heart-room): 记录聊天复用与共享检索选型。

## Task 3：页面设计与实施拆分（H03）

**Files:** 产出 docs/designs/heart-room/ 下的选定图与状态清单；更新本计划为实施版。
**Interfaces:** 消费已确认规格与 H02 结果；产出独立聊天契约、实施文件与测试、工单依赖。

- [ ] 使用 design-shotgun 出候选图，选定入口、聊天和来源呈现方式。
- [ ] 覆盖新会话、历史、无资料、引用失效、停止、失败重试与窄窗，图和验收标准附入工单。
- [ ] 使用 writing-plans 补充代码实施任务；不将当前研究清单标为开发完成。
- [ ] 提交：docs(heart-room): 补充心事屋设计与实施任务。

当前进度：独立计划已整理，[规划工单 #19](https://github.com/StarryJia/whomi/issues/19)已发布；以上待办均未执行，不承诺交付日期。
