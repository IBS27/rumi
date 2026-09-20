import type { DesignCommand } from "../../../shared/design";
import type { DesignState } from "../../../shared/design/state";
import type { RoomSnapshot } from "../../../shared/contracts";

export interface DesignConnection {
  projectId: string;
  state: DesignState;
  execute: (
    commands: DesignCommand[],
    revision: number,
  ) => Promise<RoomSnapshot>;
  undo: (revision: number) => Promise<RoomSnapshot>;
  retryAsset: (productId: string) => Promise<null>;
}
