"use client"

import { Component, type ReactNode } from "react"

type Props<T extends { id: string }> = {
  items: readonly T[]
  scope: string
  children: (item: T) => ReactNode
  className?: string
}
type Snapshot = { positions: Map<string, number>; focus: HTMLElement | null }

/** FLIP only real list changes. React keeps keyed rows, focus, and event handlers;
 * animation changes their visual position without delaying the new DOM order. */
export class ActivityList<T extends { id: string }> extends Component<Props<T>> {
  private root: HTMLDivElement | null = null
  private animations = new Set<Animation>()
  private reduced: MediaQueryList | null = null
  private stop = () => { for (const animation of this.animations) animation.cancel(); this.animations.clear() }
  componentDidMount() {
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)")
    this.reduced.addEventListener("change", this.stop)
  }
  componentWillUnmount() { this.stop(); this.reduced?.removeEventListener("change", this.stop) }
  getSnapshotBeforeUpdate(previous: Props<T>): Snapshot | null {
    if (!this.root || previous.scope !== this.props.scope || previous.items.map(item => item.id).join("|") === this.props.items.map(item => item.id).join("|")) return null
    const top = this.root.getBoundingClientRect().top
    const positions = new Map([...this.root.children].map(node => [(node as HTMLElement).dataset.activityId!, node.getBoundingClientRect().top - top]))
    return { positions, focus: this.root.contains(document.activeElement) ? document.activeElement as HTMLElement : null }
  }
  componentDidUpdate(previous: Props<T>, _state: unknown, snapshot: Snapshot | null) {
    if (previous.scope !== this.props.scope) { this.stop(); return }
    if (!snapshot || !this.root) return
    this.stop()
    // Reparenting a keyed node can blur it in some browsers. Restore only focus
    // lost to the document, never override a user's deliberate focus change.
    if (snapshot.focus?.isConnected && document.activeElement === document.body) snapshot.focus.focus({ preventScroll: true })
    if (this.reduced?.matches || typeof Element.prototype.animate !== "function") return
    const styles = getComputedStyle(this.root)
    const duration = Number.parseFloat(styles.getPropertyValue("--motion-list")) || 200
    const easing = styles.getPropertyValue("--motion-ease").trim() || "ease-out"
    const top = this.root.getBoundingClientRect().top
    // Batch all layout reads before animation writes.
    const moves = [...this.root.children].map(node => ({ node: node as HTMLElement, from: snapshot.positions.get((node as HTMLElement).dataset.activityId!), to: node.getBoundingClientRect().top - top }))
    for (const { node, from, to } of moves) {
      if (from === undefined || Math.abs(from - to) < 1) continue
      const animation = node.animate([{ transform: `translateY(${from - to}px)` }, { transform: "translateY(0)" }], { duration, easing })
      this.animations.add(animation)
      animation.finished.then(() => this.animations.delete(animation), () => this.animations.delete(animation))
    }
  }
  render() {
    return <div ref={node => { this.root = node }} className={this.props.className} data-activity-list>
      {this.props.items.map(item => <div key={item.id} data-activity-id={item.id}>{this.props.children(item)}</div>)}
    </div>
  }
}
