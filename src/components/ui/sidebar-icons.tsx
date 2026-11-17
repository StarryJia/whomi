import { createLucideIcon } from 'lucide-react'

export const OverviewIcon = createLucideIcon('sidebar-overview', [
  ['circle', { className: 'sidebar-icon-fill', cx: '8.5', cy: '8', r: '3.2', key: 'head' }],
  ['path', { className: 'sidebar-icon-fill', d: 'M2 20.5v-1A5.5 5.5 0 0 1 7.5 14h2a5.5 5.5 0 0 1 5.5 5.5v1Z', key: 'shoulders' }],
  ['path', { d: 'M18.2 2.75c.5 2 1.35 2.85 3.35 3.35-2 .5-2.85 1.35-3.35 3.35-.5-2-1.35-2.85-3.35-3.35 2-.5 2.85-1.35 3.35-3.35Z', stroke: 'none', fill: 'currentColor', key: 'sparkle' }],
])

export const InsightsIcon = createLucideIcon('sidebar-insights', [
  ['path', { className: 'sidebar-icon-fill', d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', key: 'page' }],
  ['path', { className: 'sidebar-icon-detail', d: 'M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8', key: 'fold-and-lines' }],
])

export const AskIcon = createLucideIcon('sidebar-ask', [
  ['path', { className: 'sidebar-icon-fill', d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719Z', key: 'bubble' }],
  ['path', { className: 'sidebar-icon-detail', d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01', key: 'question' }],
])

export const HeartRoomIcon = createLucideIcon('heart-room', [
  ['path', { className: 'sidebar-icon-fill', d: 'M4.5 10.5 12 3l7.5 7.5V21h-15Z', stroke: 'none', key: 'fill' }],
  ['path', { d: 'M3.5 11.5 12 3l8.5 8.5M4.5 10.5V21h15V10.5', key: 'house' }],
  ['path', { className: 'sidebar-icon-cutout', d: 'M12 8c.6 2.4 1.6 3.4 4 4-2.4.6-3.4 1.6-4 4-.6-2.4-1.6-3.4-4-4 2.4-.6 3.4-1.6 4-4Z', fill: 'currentColor', stroke: 'none', key: 'light' }],
])
