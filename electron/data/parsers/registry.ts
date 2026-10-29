import type { ParserAdapter } from './types'
import { formats } from '../../vendor/chatlab-parser/src/formats'
import { adapt } from './chatlab-adapter'

const parsers: readonly ParserAdapter[] = Object.freeze(formats.map(adapt))
export function getParsers(): readonly ParserAdapter[] { return parsers }
