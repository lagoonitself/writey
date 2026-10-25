import type { AiSource, Item, PageDoc } from './model'

const MAX_UNDO = 200

/**
 * Holds one page's items plus its undo history. Each edit stores the previous item
 * array; items are immutable so this is cheap (arrays of shared references).
 */
export class PageEditor {
  private _items: readonly Item[] = []
  private undoStack: (readonly Item[])[] = []
  private redoStack: (readonly Item[])[] = []
  private listeners = new Set<() => void>()
  /** AI ink sources by group. Not part of undo: entries without strokes are dropped on save. */
  private ai = new Map<string, AiSource>()
  /** Increments on every change, including undo/redo. Used for dirty tracking. */
  revision = 0

  constructor(doc?: PageDoc) {
    if (doc) {
      this._items = doc.items
      this.ai = new Map(Object.entries(doc.ai ?? {}))
    }
  }

  get items(): readonly Item[] {
    return this._items
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  toDoc(): PageDoc {
    const doc: PageDoc = { v: 1, items: [...this._items] }
    const groups = new Set(
      this._items.flatMap((i) => (i.kind === 'stroke' && i.groupId ? [i.groupId] : [])),
    )
    const ai = [...this.ai].filter(([id]) => groups.has(id))
    if (ai.length) doc.ai = Object.fromEntries(ai)
    return doc
  }

  aiSource(groupId: string): AiSource | undefined {
    return this.ai.get(groupId)
  }

  /** Adds AI ink and its sources as one undo step. */
  addAi(items: readonly Item[], sources: Record<string, AiSource>): void {
    for (const [id, src] of Object.entries(sources)) this.ai.set(id, src)
    this.add(items)
  }

  /** Replaces the whole document and clears history (used when loading). */
  load(doc: PageDoc): void {
    this._items = doc.items
    this.ai = new Map(Object.entries(doc.ai ?? {}))
    this.undoStack = []
    this.redoStack = []
    this.revision++
    this.emit()
  }

  add(items: readonly Item[]): void {
    if (items.length === 0) return
    this.commit([...this._items, ...items])
  }

  remove(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return
    const next = this._items.filter((i) => !ids.has(i.id))
    if (next.length !== this._items.length) this.commit(next)
  }

  /** Swaps in new versions of existing items (matched by id), keeping their z-order. */
  replace(updated: readonly Item[]): void {
    if (updated.length === 0) return
    const byId = new Map(updated.map((i) => [i.id, i]))
    this.commit(this._items.map((i) => byId.get(i.id) ?? i))
  }

  /**
   * Replaces each listed item with zero or more items in its place, as one undo step.
   * Used by the eraser, which splits strokes into pieces.
   */
  splice(changes: ReadonlyMap<string, readonly Item[]>): void {
    if (changes.size === 0) return
    this.commit(this._items.flatMap((i) => changes.get(i.id) ?? [i]))
  }

  undo(): void {
    const prev = this.undoStack.pop()
    if (!prev) return
    this.redoStack.push(this._items)
    this._items = prev
    this.revision++
    this.emit()
  }

  redo(): void {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push(this._items)
    this._items = next
    this.revision++
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private commit(next: readonly Item[]): void {
    this.undoStack.push(this._items)
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
    this._items = next
    this.revision++
    this.emit()
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}
