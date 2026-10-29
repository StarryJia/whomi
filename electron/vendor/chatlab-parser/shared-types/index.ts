export enum MessageType {
  // ========== 基础消息类型 (0-19) ==========
  TEXT = 0,
  IMAGE = 1,
  VOICE = 2,
  VIDEO = 3,
  FILE = 4,
  EMOJI = 5,
  LINK = 7,
  LOCATION = 8,

  // ========== 交互消息类型 (20-39) ==========
  RED_PACKET = 20,
  TRANSFER = 21,
  POKE = 22,
  CALL = 23,
  SHARE = 24,
  REPLY = 25,
  FORWARD = 26,
  CONTACT = 27,

  // ========== 系统消息类型 (80-89) ==========
  SYSTEM = 80,
  RECALL = 81,

  // ========== 其他 (99) ==========
  OTHER = 99,
}

/**
 * 聊天平台类型（字符串，允许任意值）
 * 常见平台示例：qq, weixin, discord, whatsapp 等
 * 合并多平台记录时使用 'mixed'
 */
export type ChatPlatform = string

export const KNOWN_PLATFORMS = {
  QQ: 'qq',
  WECHAT: 'weixin',
  DISCORD: 'discord',
  WHATSAPP: 'whatsapp',
  TELEGRAM: 'telegram',
  INSTAGRAM: 'instagram',
  GOOGLE_CHAT: 'google-chat',
  LINE: 'line',
  UNKNOWN: 'unknown',
} as const

/**
 * 聊天类型枚举
 */
export enum ChatType {
  GROUP = 'group',
  PRIVATE = 'private',
}

export interface MemberRole {
  id: string
  name?: string
}

export interface ParsedMember {
  platformId: string
  accountName: string
  groupNickname?: string
  aliases?: string[]
  avatar?: string
  roles?: MemberRole[]
}

export interface ParsedMessage {
  platformMessageId?: string
  senderPlatformId: string
  senderAccountName: string
  senderGroupNickname?: string
  timestamp: number
  type: MessageType
  content: string | null
  replyToMessageId?: string
}

