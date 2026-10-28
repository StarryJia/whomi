import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'
import { StartupIntro } from './startup-intro'

let media: MediaQueryList

function renderIntro(strict = false) {
  const image = document.createElement('img')
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    x: 15, y: 19, left: 15, top: 19, width: 50, height: 50,
    bottom: 69, right: 65, toJSON: () => ({}),
  })
  const onComplete = vi.fn()
  const intro = <StartupIntro targetRef={{ current: image }} onComplete={onComplete} />
  const rendered = render(strict ? <StrictMode>{intro}</StrictMode> : intro)
  gsap.getById('whomi-startup')?.pause()
  gsap.ticker.sleep()
  return { ...rendered, onComplete }
}

function timeline() {
  const animation = gsap.getById('whomi-startup') as gsap.core.Timeline | undefined
  expect(animation).toBeDefined()
  return animation!
}

function seek(animation: gsap.core.Timeline, time: number) {
  act(() => { animation.pause().time(time, false) })
  gsap.ticker.sleep()
}

function numberProperty(element: Element, property: string) {
  return Number(gsap.getProperty(element, property))
}

beforeEach(() => {
  gsap.ticker.sleep()
  vi.useFakeTimers()
  media = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList
  vi.mocked(window.matchMedia).mockReturnValue(media)
})

afterEach(() => {
  cleanup()
  gsap.ticker.sleep()
  vi.useRealTimers()
})

describe('GSAP 启动动画', () => {
  it('约三点八秒完成一次并释放时间轴', () => {
    const { onComplete } = renderIntro()
    const animation = timeline()
    expect(animation.duration()).toBeCloseTo(3.8, 2)
    expect(screen.getByRole('dialog', { name: '启动动画' })).toHaveFocus()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    seek(animation, 3.79)
    expect(onComplete).not.toHaveBeenCalled()
    seek(animation, 3.8)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(gsap.getById('whomi-startup')).toBeUndefined()
    act(() => vi.advanceTimersByTime(6000))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it.each([0.6, 1.6, 2, 3.3])('第 %s 秒按 Escape 后不会重复完成', (time) => {
    const { onComplete } = renderIntro()
    seek(timeline(), time)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(gsap.getById('whomi-startup')).toBeUndefined()
    act(() => vi.advanceTimersByTime(6000))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('没有开场按钮，Tab 将焦点留在开场区域，Escape 可结束', () => {
    const { onComplete } = renderIntro()
    const intro = screen.getByRole('dialog', { name: '启动动画' })
    expect(screen.queryByRole('button', { name: '跳过开场动画' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重播开场动画' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(intro).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(gsap.getById('whomi-startup')).toBeUndefined()
  })

  it('放大镜保持开头的匀速和固定半径，终点与小脸同步停稳', () => {
    const { container } = renderIntro()
    const animation = timeline()
    const search = container.querySelector('.intro-search')!
    const face = container.querySelector('.intro-face')!
    const positions = [0.2, 0.45, 0.7, 0.95, 1.2, 1.45, 1.7, 1.95, 2.2].map((time) => {
      seek(animation, time)
      expect(numberProperty(search, 'rotation')).toBeCloseTo(0, 3)
      return { x: numberProperty(search, 'x'), y: numberProperty(search, 'y') }
    })
    const angles = positions.map((point) => {
      expect(Math.hypot(point.x, point.y - 18)).toBeCloseTo(18, 3)
      return Math.atan2(point.y - 18, point.x)
    })
    const angularSpeed = 2 * Math.PI / 1.7
    const steps = angles.slice(1).map((angle, index) => (angle - angles[index] + 2 * Math.PI) % (2 * Math.PI))
    steps.forEach((step) => expect(step / 0.25).toBeCloseTo(angularSpeed, 3))
    const distances = positions.slice(1).map((point, index) => Math.hypot(point.x - positions[index].x, point.y - positions[index].y))
    distances.forEach((distance) => expect(distance).toBeCloseTo(distances[0], 3))
    seek(animation, 2.19)
    expect(Math.hypot(numberProperty(search, 'x'), numberProperty(search, 'y'))).toBeGreaterThan(0.1)
    expect(numberProperty(face, 'scaleX')).toBeLessThan(1)
    seek(animation, 2.2)
    expect(numberProperty(search, 'x')).toBeCloseTo(0, 2)
    expect(numberProperty(search, 'y')).toBeCloseTo(0, 2)
    expect(numberProperty(face, 'scaleX')).toBeCloseTo(1, 4)
  })

  it('开场即出现不可辨认的小黑点，随后加速至约一半大小', () => {
    const { container } = renderIntro()
    const animation = timeline()
    const face = container.querySelector('.intro-face')!
    function scaleAt(time: number) {
      seek(animation, time)
      return numberProperty(face, 'scaleX')
    }
    seek(animation, 0)
    expect(numberProperty(face, 'opacity')).toBe(1)
    expect(numberProperty(face, 'scaleX')).toBeGreaterThan(0.02)
    expect(numberProperty(face, 'scaleX')).toBeLessThan(0.04)
    const initialStep = scaleAt(0.5) - scaleAt(0.3)
    const approachingStep = scaleAt(0.9) - scaleAt(0.7)
    expect(initialStep).toBeGreaterThan(0)
    expect(approachingStep).toBeGreaterThan(initialStep * 3)
    expect(scaleAt(1.45)).toBeCloseTo(0.5, 3)
    expect(numberProperty(face, 'rotation')).toBeCloseTo(0, 3)
  })

  it('两张同画布品牌图片自然合成标识，停留后一起归位', () => {
    const { container } = renderIntro()
    const animation = timeline()
    const lens = container.querySelector<HTMLImageElement>('.intro-search img')!
    const face = container.querySelector<HTMLImageElement>('.intro-face img')!
    expect(lens).not.toBeNull()
    expect(face).not.toBeNull()
    expect(lens.getAttribute('src')).toContain('whomi-lens-layer.png')
    expect(face.getAttribute('src')).toContain('whomi-face-layer.png')
    for (const layer of [lens, face]) {
      expect(layer).toHaveAttribute('width', '1254')
      expect(layer).toHaveAttribute('height', '1254')
    }
    expect(container.querySelector('svg')).not.toBeInTheDocument()
    expect(container.querySelector('.intro-symbol')).not.toBeInTheDocument()
    const search = container.querySelector('.intro-search')!
    const faceLayer = container.querySelector('.intro-face')!
    const scene = container.querySelector('.intro-scene')!
    seek(animation, 1.3)
    expect(container.querySelector('.intro-search img')).toBe(lens)
    for (const time of [2.2, 2.7]) {
      seek(animation, time)
      expect(container.querySelector('.intro-face img')).toBe(face)
      expect(numberProperty(search, 'x')).toBeCloseTo(0, 3)
      expect(numberProperty(search, 'y')).toBeCloseTo(0, 3)
      expect(numberProperty(faceLayer, 'scaleX')).toBeCloseTo(1, 4)
      expect(numberProperty(scene, 'scaleX')).toBeCloseTo(1, 4)
      expect(numberProperty(scene, 'x')).toBeCloseTo(0, 3)
      expect(numberProperty(scene, 'y')).toBeCloseTo(0, 3)
    }
    seek(animation, 3.3)
    expect(numberProperty(scene, 'scaleX')).toBeLessThan(1)
    expect(Math.hypot(numberProperty(scene, 'x'), numberProperty(scene, 'y'))).toBeGreaterThan(1)
  })

  it('第一次冲近后完全静止零点三秒，再第二次冲近组成标识', () => {
    const { container } = renderIntro()
    const animation = timeline()
    const face = container.querySelector('.intro-face')!
    function scaleAt(time: number) {
      seek(animation, time)
      return numberProperty(face, 'scaleX')
    }
    expect(scaleAt(1.45)).toBeCloseTo(0.5, 3)
    const pausedTransform = face.getAttribute('style')
    for (const time of [1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 1.749, 1.75]) {
      expect(scaleAt(time)).toBe(0.5)
      expect(face.getAttribute('style')).toBe(pausedTransform)
    }
    const rushingStep = scaleAt(2.2) - scaleAt(2)
    const rushStartStep = scaleAt(1.95) - scaleAt(1.75)
    expect(rushStartStep).toBeGreaterThan(0)
    expect(rushingStep).toBeGreaterThan(rushStartStep * 4)
    expect(scaleAt(2.2)).toBeCloseTo(1, 4)
    const finalScales = [0, 0.5, 1, 1.45, 1.6, 1.75, 2, 2.1, 2.2, 2.4, 2.7].map(scaleAt)
    expect(finalScales.every((scale) => scale <= 1)).toBe(true)
    finalScales.slice(1).forEach((scale, index) => expect(scale).toBeGreaterThanOrEqual(finalScales[index]))
  })

  it.each(['escape', 'unmount'])('%s 后停止位移时间轴，不再改变位置或触发回调', (reason) => {
    const { container, unmount, onComplete } = renderIntro()
    const animation = timeline()
    const search = container.querySelector<HTMLElement>('.intro-search')!
    seek(animation, 1)
    const before = search.style.transform
    seek(animation, 1.1)
    expect(search.style.transform).not.toBe(before)
    if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    else unmount()
    const positionAtEnd = search.style.transform
    expect(gsap.getById('whomi-startup')).toBeUndefined()
    act(() => vi.advanceTimersByTime(6000))
    expect(search.style.transform).toBe(positionAtEnd)
    expect(onComplete).toHaveBeenCalledTimes(reason === 'escape' ? 1 : 0)
  })

  it('播放中开启减少动态效果时立即结束', () => {
    const { onComplete } = renderIntro()
    seek(timeline(), 0.8)
    act(() => {
      Object.assign(media, { matches: true })
      media.dispatchEvent(new Event('change'))
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(gsap.getById('whomi-startup')).toBeUndefined()
  })

  it.each(['resize', 'hidden'])('发生 %s 时结束并清理时间轴', (reason) => {
    const { onComplete } = renderIntro()
    if (reason === 'resize') fireEvent(window, new Event('resize'))
    else {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      fireEvent(document, new Event('visibilitychange'))
    }
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(gsap.getById('whomi-startup')).toBeUndefined()
  })

  it.each(['reduced', 'target', 'failure'])('%s 时回退到封面', (reason) => {
    if (reason === 'reduced') Object.assign(media, { matches: true })
    if (reason === 'failure') vi.spyOn(gsap, 'timeline').mockImplementation(() => { throw new Error('Animation unavailable') })
    let onComplete = vi.fn()
    if (reason === 'target') render(<StartupIntro targetRef={{ current: null }} onComplete={onComplete} />)
    else onComplete = renderIntro().onComplete
    act(() => vi.advanceTimersByTime(0))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(gsap.getById('whomi-startup')).toBeUndefined()
  })

  it('卸载后移除事件订阅，不再响应后台、尺寸或键盘事件', () => {
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const removeMediaListener = vi.spyOn(media, 'removeEventListener')
    const { unmount, onComplete } = renderIntro()
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent(window, new Event('resize'))
    act(() => media.dispatchEvent(new Event('change')))
    act(() => vi.advanceTimersByTime(6000))
    expect(onComplete).not.toHaveBeenCalled()
    expect(gsap.getById('whomi-startup')).toBeUndefined()
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeWindowListener).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeMediaListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('严格模式重新挂载后仅保留一个时间轴并完成一次', () => {
    const { onComplete } = renderIntro(true)
    const matching = gsap.globalTimeline.getChildren().filter((animation) => animation.vars.id === 'whomi-startup')
    expect(matching).toHaveLength(1)
    seek(timeline(), 3.8)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
