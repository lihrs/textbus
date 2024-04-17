import { Inject, Injectable, Optional } from '@viewfly/core'
import { filter, map, Observable, Subject, Subscription } from '@tanbo/stream'
import {
  AbstractSelection,
  ChangeOrigin,
  Component,
  Registry,
  Formats,
  History,
  HISTORY_STACK_SIZE,
  makeError,
  RootComponentRef,
  Scheduler,
  Selection,
  SelectionPaths,
  Slot,
  ArrayModel,
  MapModel
} from '@textbus/core'
import {
  Array as YArray,
  Doc as YDoc,
  Map as YMap,
  RelativePosition,
  Text as YText,
  Transaction,
  UndoManager,
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
  Item, YArrayEvent, YMapEvent, YTextEvent
} from 'yjs'

const collaborateErrorFn = makeError('Collaborate')

interface CursorPosition {
  anchor: RelativePosition
  focus: RelativePosition
}

class SlotMap {
  private slotAndYTextMap = new WeakMap<Slot, YText>()
  private yTextAndSLotMap = new WeakMap<YText, Slot>()

  set(key: Slot, value: YText): void
  set(key: YText, value: Slot): void
  set(key: any, value: any) {
    if (key instanceof Slot) {
      this.slotAndYTextMap.set(key, value)
      this.yTextAndSLotMap.set(value, key)
    } else {
      this.slotAndYTextMap.set(value, key)
      this.yTextAndSLotMap.set(key, value)
    }
  }

  get(key: Slot): YText | null
  get(key: YText): Slot | null
  get(key: any) {
    if (key instanceof Slot) {
      return this.slotAndYTextMap.get(key) || null
    }
    return this.yTextAndSLotMap.get(key) || null
  }

  delete(key: Slot | YText) {
    if (key instanceof Slot) {
      const v = this.slotAndYTextMap.get(key)
      this.slotAndYTextMap.delete(key)
      if (v) {
        this.yTextAndSLotMap.delete(v)
      }
    } else {
      const v = this.yTextAndSLotMap.get(key)
      this.yTextAndSLotMap.delete(key)
      if (v) {
        this.slotAndYTextMap.delete(v)
      }
    }
  }
}

interface Update {
  record: boolean
  actions: Array<() => void>
}

interface UpdateItem {
  record: boolean

  action(): void
}

export abstract class CustomUndoManagerConfig {
  abstract captureTransaction?(arg0: Transaction): boolean

  abstract deleteFilter?(arg0: Item): boolean
}

interface CollaborateHistorySelectionPosition {
  before: CursorPosition | null
  after: CursorPosition | null
}

@Injectable()
export class Collaborate implements History {
  onLocalChangesApplied: Observable<void>
  yDoc = new YDoc()
  onBack: Observable<void>
  onForward: Observable<void>
  onChange: Observable<void>
  onPush: Observable<void>

  get canBack() {
    return this.manager?.canUndo() || false
  }

  get canForward() {
    return this.manager?.canRedo() || false
  }

  private backEvent = new Subject<void>()
  private forwardEvent = new Subject<void>()
  private changeEvent = new Subject<void>()
  private pushEvent = new Subject<void>()

  private manager: UndoManager | null = null

  private subscriptions: Subscription[] = []
  private updateFromRemote = false

  private localChangesAppliedEvent = new Subject<void>()
  private selectionChangeEvent = new Subject<SelectionPaths>()
  private slotMap = new SlotMap()

  private updateRemoteActions: Array<UpdateItem> = []
  private noRecord = {}

  private historyItems: Array<CollaborateHistorySelectionPosition> = []
  private index = 0

  constructor(@Inject(HISTORY_STACK_SIZE) private stackSize: number,
              private rootComponentRef: RootComponentRef,
              private scheduler: Scheduler,
              private registry: Registry,
              private selection: Selection,
              @Optional() private undoManagerConfig: CustomUndoManagerConfig) {
    this.onBack = this.backEvent.asObservable()
    this.onForward = this.forwardEvent.asObservable()
    this.onChange = this.changeEvent.asObservable()
    this.onPush = this.pushEvent.asObservable()
    this.onLocalChangesApplied = this.localChangesAppliedEvent.asObservable()
  }

  listen() {
    const root = this.yDoc.getMap('RootComponent')
    const rootComponent = this.rootComponentRef.component!
    const undoManagerConfig = this.undoManagerConfig || {}
    const manager = new UndoManager(root, {
      trackedOrigins: new Set<any>([this.yDoc]),
      captureTransaction(arg) {
        if (undoManagerConfig.captureTransaction) {
          return undoManagerConfig.captureTransaction(arg)
        }
        return true
      },
      deleteFilter(item: Item) {
        if (undoManagerConfig.deleteFilter) {
          return undoManagerConfig.deleteFilter(item)
        }
        return true
      }
    })
    this.manager = manager

    let beforePosition: CursorPosition | null = null
    this.subscriptions.push(
      this.scheduler.onLocalChangeBefore.subscribe(() => {
        beforePosition = this.getRelativeCursorLocation()
      })
    )

    manager.on('stack-item-added', (event: any) => {
      if (event.type === 'undo') {
        if (event.origin === manager) {
          this.index++
        } else {
          this.historyItems.length = this.index
          this.historyItems.push({
            before: beforePosition,
            after: this.getRelativeCursorLocation()
          })
          this.index++
        }
      } else {
        this.index--
      }
      if (manager.undoStack.length > this.stackSize) {
        this.historyItems.shift()
        manager.undoStack.shift()
      }
      if (event.origin === this.yDoc) {
        this.pushEvent.next()
      }
      this.changeEvent.next()
    })
    manager.on('stack-item-popped', (ev: any) => {
      const index = ev.type === 'undo' ? this.index : this.index - 1
      const position = this.historyItems[index] || null
      const p = ev.type === 'undo' ? position?.before : position?.after
      if (p) {
        const selection = this.getAbstractSelection(p)
        if (selection) {
          this.selection.setBaseAndExtent(
            selection.anchorSlot,
            selection.anchorOffset,
            selection.focusSlot,
            selection.focusOffset)
          return
        }
      }
      this.selection.unSelect()
    })
    this.subscriptions.push(
      this.selection.onChange.subscribe(() => {
        const paths = this.selection.getPaths()
        this.selectionChangeEvent.next(paths)
      }),
      this.scheduler.onDocChanged.pipe(
        map(item => {
          return item.filter(i => {
            return i.from !== ChangeOrigin.Remote
          })
        }),
        filter(item => {
          return item.length
        })
      ).subscribe(() => {
        const updates: Update[] = []

        let update: Update | null = null

        for (const item of this.updateRemoteActions) {
          if (!update) {
            update = {
              record: item.record,
              actions: []
            }
            updates.push(update)
          }
          if (update.record === item.record) {
            update.actions.push(item.action)
          } else {
            update = {
              record: item.record,
              actions: [item.action]
            }
            updates.push(update)
          }
        }

        this.updateRemoteActions = []

        for (const item of updates) {
          this.yDoc.transact(() => {
            item.actions.forEach(fn => {
              fn()
            })
          }, item.record ? this.yDoc : this.noRecord)
        }
        this.localChangesAppliedEvent.next()
      })
    )
    this.syncRootComponent(root, rootComponent)
  }

  back() {
    if (this.canBack) {
      this.manager?.undo()
      this.backEvent.next()
    }
  }

  forward() {
    if (this.canForward) {
      this.manager?.redo()
      this.forwardEvent.next()
    }
  }

  clear() {
    const last = this.historyItems.pop()
    this.historyItems = last ? [last] : []
    this.index = last ? 1 : 0
    this.manager?.clear()
    this.changeEvent.next()
  }

  destroy() {
    this.index = 0
    this.historyItems = []
    this.subscriptions.forEach(i => i.unsubscribe())
    this.manager?.destroy()
  }

  private syncRootComponent(root: YMap<any>, rootComponent: Component) {
    let state = root.get('state') as YMap<any>
    if (!state) {
      state = new YMap<any>()
      this.syncLocalMapToSharedMap(rootComponent.state, state, rootComponent)
      this.yDoc.transact(() => {
        root.set('state', state)
      })
    } else {
      rootComponent.state.clean()
      this.syncSharedMapToLocalMap(state, rootComponent.state, rootComponent)
    }
  }

  private syncSharedMapToLocalMap(sharedMap: YMap<any>, localMap: MapModel<any>, parent: Component<any>) {
    sharedMap.forEach((value, key) => {
      localMap.set(key, this.createLocalModelBySharedByModel(value, parent))
    })
    this.syncObject(sharedMap, localMap, parent)
  }

  private createLocalMapBySharedMap(sharedMap: YMap<any>, parent: Component<any>): MapModel<any> {
    const localMap = new MapModel(parent)
    this.syncSharedMapToLocalMap(sharedMap, localMap, parent)
    return localMap
  }

  private createLocalArrayBySharedArray(sharedArray: YArray<any>, parent: Component<any>): ArrayModel<any> {
    const localArray = new ArrayModel(parent)
    sharedArray.forEach(item => {
      localArray.insert(this.createLocalModelBySharedByModel(item, parent))
    })
    this.syncArray(sharedArray, localArray, parent)
    return localArray
  }

  private syncLocalMapToSharedMap(localMap: MapModel<any>, sharedMap: YMap<any>, parent: Component<any>) {
    localMap.forEach((value, key) => {
      sharedMap.set(key, this.createSharedModelByLocalModel(value, parent))
    })
    this.syncObject(sharedMap, localMap, parent)
  }

  private createSharedMapByLocalMap(localMap: MapModel<any>, parent: Component<any>): YMap<any> {
    const sharedMap = new YMap<any>()
    this.syncLocalMapToSharedMap(localMap, sharedMap, parent)
    return sharedMap
  }

  private createSharedArrayByLocalArray(localArray: ArrayModel<any>, parent: Component<any>): YArray<any> {
    const sharedArray = new YArray<any>()
    localArray.forEach(value => {
      sharedArray.push([this.createSharedModelByLocalModel(value, parent)])
    })
    this.syncArray(sharedArray, localArray, parent)
    return sharedArray
  }

  private createSharedSlotByLocalSlot(localSlot: Slot): YText {
    const sharedSlot = new YText()
    sharedSlot.setAttribute('__schema__', [...localSlot.schema])
    let offset = 0
    localSlot.toDelta().forEach(i => {
      let formats: any = {}
      if (i.formats) {
        i.formats.forEach(item => {
          formats[item[0].name] = item[1]
        })
      } else {
        formats = null
      }
      if (typeof i.insert === 'string') {
        sharedSlot.insert(offset, i.insert, formats)
      } else {
        const sharedComponent = this.createSharedComponentByLocalComponent(i.insert)
        sharedSlot.insertEmbed(offset, sharedComponent, formats)
      }
      offset += i.insert.length
    })
    localSlot.getAttributes().forEach(item => {
      sharedSlot.setAttribute(item[0].name, item[1])
    })
    this.syncSlot(sharedSlot, localSlot)
    return sharedSlot
  }

  private createLocalSlotBySharedSlot(sharedSlot: YText): Slot {
    const delta = sharedSlot.toDelta()
    const localSlot = new Slot(sharedSlot.getAttribute('__schema__') || [])// TODO 这里有潜在的问题

    const attrs = sharedSlot.getAttributes()
    Object.keys(attrs).forEach(key => {
      const attribute = this.registry.getAttribute(key)
      if (attribute) {
        localSlot.setAttribute(attribute, attrs[key])
      }
    })
    for (const action of delta) {
      if (action.insert) {
        if (typeof action.insert === 'string') {
          const formats = remoteFormatsToLocal(this.registry, action.attributes)
          localSlot.insert(action.insert, formats)
        } else {
          const sharedComponent = action.insert as YMap<any>
          const component = this.createLocalComponentBySharedComponent(sharedComponent)
          localSlot.insert(component, remoteFormatsToLocal(this.registry, action.attributes))
        }
      } else {
        throw collaborateErrorFn('unexpected delta action.')
      }
    }
    this.syncSlot(sharedSlot, localSlot)
    return localSlot
  }

  // private createSharedModelByLocalModel(sharedModel: YMap<any>, parent: Component<any>): MapModel<any>
  // private createSharedModelByLocalModel(sharedModel: YArray<any>, parent: Component<any>): ArrayModel<any>
  // private createSharedModelByLocalModel(sharedModel: YText, parent: Component<any>): Slot
  // private createSharedModelByLocalModel(sharedModel: any, parent: Component<any>): any
  private createSharedModelByLocalModel(sharedModel: any, parent: Component<any>) {
    if (sharedModel instanceof MapModel) {
      return this.createSharedMapByLocalMap(sharedModel, parent)
    }
    if (sharedModel instanceof ArrayModel) {
      return this.createSharedArrayByLocalArray(sharedModel, parent)
    }
    if (sharedModel instanceof Slot) {
      return this.createSharedSlotByLocalSlot(sharedModel)
    }
    return sharedModel
  }

  // private createLocalModelBySharedByModel(localModel: MapModel<any>, parent: Component<any>): MapModel<any>
  // private createLocalModelBySharedByModel(localModel: ArrayModel<any>, parent: Component<any>): YArray<any>
  // private createLocalModelBySharedByModel(localModel: Slot, parent: Component<any>): YText
  // private createLocalModelBySharedByModel(localModel: any, parent: Component<any>): any
  private createLocalModelBySharedByModel(localModel: any, parent: Component<any>) {
    if (localModel instanceof YMap) {
      return this.createLocalMapBySharedMap(localModel, parent)
    }
    if (localModel instanceof YArray) {
      return this.createLocalArrayBySharedArray(localModel, parent)
    }
    if (localModel instanceof YText) {
      return this.createLocalSlotBySharedSlot(localModel)
    }
    return localModel
  }

  private getAbstractSelection(position: CursorPosition): AbstractSelection | null {
    const anchorPosition = createAbsolutePositionFromRelativePosition(position.anchor, this.yDoc)
    const focusPosition = createAbsolutePositionFromRelativePosition(position.focus, this.yDoc)
    if (anchorPosition && focusPosition) {
      const focusSlot = this.slotMap.get(focusPosition.type as YText)
      const anchorSlot = this.slotMap.get(anchorPosition.type as YText)
      if (focusSlot && anchorSlot) {
        return {
          anchorSlot,
          anchorOffset: anchorPosition.index,
          focusSlot,
          focusOffset: focusPosition.index
        }
      }
    }
    return null
  }

  private getRelativeCursorLocation(): CursorPosition | null {
    const { anchorSlot, anchorOffset, focusSlot, focusOffset } = this.selection
    if (anchorSlot) {
      const anchorYText = this.slotMap.get(anchorSlot)
      if (anchorYText) {
        const anchorPosition = createRelativePositionFromTypeIndex(anchorYText, anchorOffset!)
        if (focusSlot) {
          const focusYText = this.slotMap.get(focusSlot)
          if (focusYText) {
            const focusPosition = createRelativePositionFromTypeIndex(focusYText, focusOffset!)
            return {
              focus: focusPosition,
              anchor: anchorPosition
            }
          }
        }
      }
    }
    return null
  }

  private syncSlot(sharedSlot: YText, localSlot: Slot) {
    const syncRemote = (ev: YTextEvent, tr: Transaction) => {
      this.runRemoteUpdate(tr, () => {
        localSlot.retain(0)
        ev.keysChanged.forEach(key => {
          const change = ev.keys.get(key)
          if (!change) {
            return
          }
          const updateType = change.action
          if (updateType === 'update' || updateType === 'add') {
            const attribute = this.registry.getAttribute(key)
            if (attribute) {
              localSlot.setAttribute(attribute, sharedSlot.getAttribute(key))
            }
          } else if (updateType === 'delete') {
            const attribute = this.registry.getAttribute(key)
            if (attribute) {
              localSlot.removeAttribute(attribute)
            }
          }
        })
        ev.delta.forEach(action => {
          if (Reflect.has(action, 'retain')) {
            if (action.attributes) {
              const formats = remoteFormatsToLocal(this.registry, action.attributes)
              if (formats.length) {
                localSlot.retain(action.retain!, formats)
              }
              localSlot.retain(localSlot.index + action.retain!)
            } else {
              localSlot.retain(action.retain!)
            }
          } else if (action.insert) {
            const index = localSlot.index
            let length = 1
            if (typeof action.insert === 'string') {
              length = action.insert.length
              localSlot.insert(action.insert, remoteFormatsToLocal(this.registry, action.attributes))
            } else {
              const sharedComponent = action.insert as YMap<any>
              const component = this.createLocalComponentBySharedComponent(sharedComponent)
              localSlot.insert(component)
            }
            if (this.selection.isSelected && tr.origin !== this.manager) {
              if (localSlot === this.selection.anchorSlot && this.selection.anchorOffset! > index) {
                this.selection.setAnchor(localSlot, this.selection.anchorOffset! + length)
              }
              if (localSlot === this.selection.focusSlot && this.selection.focusOffset! > index) {
                this.selection.setFocus(localSlot, this.selection.focusOffset! + length)
              }
            }
          } else if (action.delete) {
            const index = localSlot.index
            localSlot.delete(action.delete)
            if (this.selection.isSelected && tr.origin !== this.manager) {
              if (localSlot === this.selection.anchorSlot && this.selection.anchorOffset! >= index) {
                this.selection.setAnchor(localSlot, this.selection.startOffset! - action.delete)
              }
              if (localSlot === this.selection.focusSlot && this.selection.focusOffset! >= index) {
                this.selection.setFocus(localSlot, this.selection.focusOffset! - action.delete)
              }
            }
          }
        })
      })
    }
    sharedSlot.observe(syncRemote)

    const sub = localSlot.onContentChange.subscribe(actions => {
      this.runLocalUpdate(() => {
        let offset = 0
        let length = 0
        for (const action of actions) {
          if (action.type === 'retain') {
            const formats = action.formats
            if (formats) {
              const keys = Object.keys(formats)
              let length = keys.length
              keys.forEach(key => {
                const formatter = this.registry.getFormatter(key)
                if (!formatter) {
                  length--
                  Reflect.deleteProperty(formats, key)
                }
              })
              if (length) {
                sharedSlot.format(offset, action.offset, formats)
              }
            } else {
              offset = action.offset
            }
          } else if (action.type === 'contentInsert') {
            const delta = sharedSlot.toDelta()
            const isEmpty = delta.length === 1 && delta[0].insert === Slot.emptyPlaceholder
            if (typeof action.content === 'string') {
              length = action.content.length
              sharedSlot.insert(offset, action.content, action.formats || {})
            } else {
              length = 1
              const sharedComponent = this.createSharedComponentByLocalComponent(action.ref as Component)
              sharedSlot.insertEmbed(offset, sharedComponent, action.formats || {})
            }

            if (isEmpty && offset === 0) {
              sharedSlot.delete(sharedSlot.length - 1, 1)
            }
            offset += length
          } else if (action.type === 'delete') {
            const delta = sharedSlot.toDelta()
            if (sharedSlot.length) {
              sharedSlot.delete(offset, action.count)
            }
            if (sharedSlot.length === 0) {
              sharedSlot.insert(0, '\n', delta[0]?.attributes)
            }
          } else if (action.type === 'attrSet') {
            sharedSlot.setAttribute(action.name, action.value)
          } else if (action.type === 'attrDelete') {
            sharedSlot.removeAttribute(action.name)
          }
        }
      })
    })

    this.slotMap.set(localSlot, sharedSlot)

    localSlot.destroyCallbacks.push(() => {
      this.slotMap.delete(localSlot)
      sharedSlot.unobserve(syncRemote)
      sub.unsubscribe()
    })
  }

  private createSharedComponentByLocalComponent(component: Component): YMap<any> {
    const sharedComponent = new YMap()
    const sharedState = this.createSharedMapByLocalMap(component.state, component)
    sharedComponent.set('name', component.name)
    sharedComponent.set('state', sharedState)
    return sharedComponent
  }


  private createLocalComponentBySharedComponent(yMap: YMap<any>): Component {
    const componentName = yMap.get('name') as string
    const sharedState = yMap.get('state') as YMap<any>

    const instance = this.registry.createComponentByData(componentName, (component: Component<any>) => {
      return this.createLocalMapBySharedMap(sharedState, component)
    })
    if (instance) {
      return instance
    }

    throw collaborateErrorFn(`cannot find component factory \`${componentName}\`.`)
  }

  /**
   * 双向同步数组
   * @param sharedArray
   * @param localArray
   * @param parent
   * @private
   */
  private syncArray(sharedArray: YArray<any>, localArray: ArrayModel<any>, parent: Component<any>) {
    const sub = localArray.changeMarker.onChange.subscribe((op) => {
      this.runLocalUpdate(() => {
        let index = 0
        for (const action of op.apply) {
          switch (action.type) {
            case 'retain':
              index = action.offset
              break
            case 'insert': {
              const data = this.createSharedModelByLocalModel(action.ref, parent)
              sharedArray.insert(index, [data])
            }
              break
            case 'delete':
              sharedArray.delete(index, 1)
              break
          }
        }
      })
    })

    const syncRemote = (ev: YArrayEvent<any>, tr: Transaction) => {
      this.runRemoteUpdate(tr, () => {
        let index = 0
        localArray.retain(index)
        ev.delta.forEach((action) => {
          if (Reflect.has(action, 'retain')) {
            index += action.retain as number
            localArray.retain(index)
          } else if (action.insert) {
            (action.insert as Array<YMap<any>>).forEach((item) => {
              const value = this.createLocalModelBySharedByModel(item, parent)
              localArray.insert(value)
              index++
            })
          } else if (action.delete) {
            localArray.retain(index)
            localArray.delete(action.delete)
          }
        })
      })
    }

    sharedArray.observe(syncRemote)
    localArray.destroyCallbacks.push(() => {
      sub.unsubscribe()
      sharedArray.unobserve(syncRemote)
    })
  }

  /**
   * 双向同步对象
   * @param sharedObject
   * @param localObject
   * @param parent
   * @private
   */
  private syncObject(sharedObject: YMap<any>, localObject: MapModel<any>, parent: Component<any>) {
    const syncRemote = (ev: YMapEvent<any>, tr: Transaction) => {
      this.runRemoteUpdate(tr, () => {
        ev.changes.keys.forEach((item, key) => {
          if (item.action === 'add' || item.action === 'update') {
            const value = sharedObject.get(key)
            localObject.set(key, this.createLocalModelBySharedByModel(value, parent))
          } else {
            localObject.remove(key)
          }
        })
      })
    }

    sharedObject.observe(syncRemote)

    const sub = localObject.changeMarker.onChange.subscribe((op) => {
      this.runLocalUpdate(() => {
        for (const action of op.apply) {
          switch (action.type) {
            case 'propSet':
              sharedObject.set(action.key, this.createSharedModelByLocalModel(action.value, parent))
              break
            case 'propDelete':
              sharedObject.delete(action.key)
              break
          }
        }
      })
    })

    localObject.destroyCallbacks.push(function () {
      sharedObject.unobserve(syncRemote)
      sub.unsubscribe()
    })
  }

  private runLocalUpdate(fn: () => void, record = true) {
    if (this.updateFromRemote) {
      return
    }
    this.updateRemoteActions.push({
      record,
      action: fn
    })
  }

  private runRemoteUpdate(tr: Transaction, fn: () => void) {
    if (tr.origin === this.yDoc) {
      return
    }
    this.updateFromRemote = true
    if (tr.origin === this.manager) {
      this.scheduler.historyApplyTransact(fn)
    } else {
      this.scheduler.remoteUpdateTransact(fn)
    }
    this.updateFromRemote = false
  }
}

function remoteFormatsToLocal(registry: Registry, attrs?: any,) {
  const formats: Formats = []
  if (attrs) {
    Object.keys(attrs).forEach(key => {
      const formatter = registry.getFormatter(key)
      if (formatter) {
        formats.push([formatter, attrs[key]])
      }
    })
  }
  return formats
}
