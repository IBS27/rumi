import type { RoomObject } from "../../../shared/contracts";
import type { ParametricModel as ParametricModelData } from "../../../shared/assets/model";
import type { ReconstructedObject } from "../../../shared/reconstruction/contracts";

/** A replacement keeps its instance ID, but no longer represents the captured item. */
export function furnitureModel(
  object: RoomObject,
  reconstruction: ReconstructedObject | undefined,
  productModel: ParametricModelData | undefined,
) {
  if (object.productId) return productModel;
  return reconstruction
    ? { ...reconstruction, dimensions: object.dimensions }
    : productModel;
}
