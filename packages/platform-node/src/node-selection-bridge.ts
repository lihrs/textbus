import { NativeSelectionBridge, SelectionPosition } from '@textbus/core'
import { Injectable } from '@viewfly/core'

@Injectable()
export class NodeSelectionBridge implements NativeSelectionBridge {
  connect() {
    //
  }

  disConnect() {
    //
  }

  restore() {
    //
  }

  getNextLinePositionByCurrent(position: SelectionPosition): SelectionPosition | null {
    return position
  }

  getPreviousLinePositionByCurrent(position: SelectionPosition): SelectionPosition | null {
    return position
  }
}
