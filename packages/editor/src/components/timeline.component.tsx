import {
  ComponentInitData,
  ComponentInstance,
  ContentType,
  defineComponent, RenderMode,
  Slot,
  SlotRender,
  useContext,
  useSlots,
  VElement
} from '@textbus/core'
import { ComponentLoader, SlotParser } from '@textbus/platform-browser'
import { Injector } from '@tanbo/di'

import { blockComponent } from './block.component'
import { colorFormatter, fontSizeFormatter } from '../formatters/_api'
import { boldFormatter } from '../formatters/inline-element.formatter'
import { paragraphComponent } from './paragraph.component'

const timelineTypes = ['primary', 'info', 'success', 'warning', 'danger', 'dark', 'gray']

export type TimelineType = 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'dark' | 'gray';

export interface TimelineSlotState {
  type: TimelineType
}

export function createTimelineItem(injector: Injector, type: TimelineType = 'primary') {
  const slot = new Slot<TimelineSlotState>([
    ContentType.BlockComponent,
    ContentType.Text,
    ContentType.InlineComponent
  ], {
    type
  })

  const title = blockComponent.createInstance(injector)
  title.slots.first!.insert('时间主题', [
    [fontSizeFormatter, '18px'],
    [boldFormatter, true]
  ])
  title.slots.first!.insert(' 2020-02-02', [
    [fontSizeFormatter, '15px'],
    [colorFormatter, '#777']
  ])

  const desc = paragraphComponent.createInstance(injector)
  desc.slots.first!.insert('描述信息...')
  slot.insert(title)
  slot.insert(desc)
  return slot
}

export const timelineComponent = defineComponent({
  type: ContentType.BlockComponent,
  name: 'TimelineComponent',
  setup(initData?: ComponentInitData<void, TimelineSlotState>) {
    const injector = useContext()
    const slots = useSlots<TimelineSlotState>(initData?.slots || [
      createTimelineItem(injector)
    ])

    if (slots.length === 0) {
      slots.push(createTimelineItem(injector))
    }
    return {
      render(slotRender: SlotRender, renderMode): VElement {
        return (
          <tb-timeline>
            {
              slots.toArray().map(slot => {
                const type = slot.state!.type
                const classes = ['tb-timeline-item']
                if (type) {
                  classes.push('tb-timeline-item-' + type)
                }
                return (
                  <div class={classes.join(' ')}>
                    <div class="tb-timeline-line"/>
                    <div class="tb-timeline-icon" title={renderMode === RenderMode.Editing ? null : '点击切换颜色'} onClick={() => {
                      if (!type) {
                        slot.updateState(draft => {
                          draft.type = timelineTypes[0] as TimelineType
                        })
                      } else {
                        slot.updateState(draft => {
                          draft.type = timelineTypes[timelineTypes.indexOf(type) + 1] as TimelineType || null
                        })
                      }
                    }}/>
                    {
                      renderMode === RenderMode.Editing && <span class="tb-timeline-add" onClick={() => {
                        const index = slots.indexOf(slot) + 1
                        slots.insertByIndex(createTimelineItem(injector, type), index)
                      }}/>
                    }
                    {
                      slotRender(slot, children => {
                        return <div class="tb-timeline-content">{children}</div>
                      })
                    }
                  </div>
                )
              })
            }
          </tb-timeline>
        )
      }
    }
  }
})

export const timelineComponentLoader: ComponentLoader = {
  match(element: HTMLElement): boolean {
    return element.nodeName.toLowerCase() === 'tb-timeline'
  },
  read(element: HTMLElement, context: Injector, slotParser: SlotParser): ComponentInstance {
    return timelineComponent.createInstance(context, {
      slots: Array.from(element.children).map(child => {
        let type: TimelineType = 'primary'
        for (const k of timelineTypes) {
          if (child.classList.contains('tb-timeline-item-' + k)) {
            type = k as TimelineType
            break
          }
        }
        const slot = new Slot<TimelineSlotState>([
          ContentType.InlineComponent,
          ContentType.Text,
          ContentType.BlockComponent
        ], {
          type
        })
        return slotParser(slot, child.querySelector('div.tb-timeline-content') || document.createElement('div'))
      })
    })
  }
}