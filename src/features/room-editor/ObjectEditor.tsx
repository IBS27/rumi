import { useEffect, useRef, useState, type FormEvent } from "react";
import { EditControls, type EditControlProps } from "./EditControls";
import { formatMoney } from "../../../shared/budget";
import {
  categorySchema,
  roomObjectSchema,
  type RoomObject,
  type ProductCandidate,
} from "../../../shared/contracts";
import {
  Button,
  Checkbox,
  Field,
  NumberInput,
  Pill,
  Select,
  TextInput,
} from "../../ui";

/**
 * Inline editor for the selected scanned object. Sits directly under its row
 * in the scan dock. Size and the two flags are always visible; name, category,
 * position and rotation are behind "More".
 */
export function ObjectEditor({
  object,
  canReset,
  onSave,
  onReset,
  onRemove,
  busy,
  products = [],
  onReplace,
  onMove,
  ...controls
}: {
  object: RoomObject;
  canReset: boolean;
  onSave: (next: RoomObject) => void;
  onReset: () => void;
  onRemove: () => void;
  busy?: boolean;
  products?: ProductCandidate[];
  onReplace?: (productId: string) => Promise<void>;
  onMove?: (object: RoomObject) => void;
} & EditControlProps) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const node = form.current;
    const dock = node?.closest<HTMLElement>('[aria-label="Scan details"]');
    if (node && dock)
      dock.scrollTop +=
        node.getBoundingClientRect().top -
        dock.getBoundingClientRect().top -
        48;
  }, []);
  const [error, setError] = useState("");
  const product = products.find((item) => item.id === object.productId);
  const [replacement, setReplacement] = useState("");
  const estimated = object.measurementSource !== "confirmed";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const number = (key: string) => Number(data.get(key));
    const parsed = roomObjectSchema.safeParse({
      ...object,
      name: String(data.get("name") ?? object.name).trim(),
      category: data.get("category") ?? object.category,
      dimensions: object.productId
        ? object.dimensions
        : {
            width: number("width"),
            depth: number("depth"),
            height: number("height"),
          },
      position: { x: number("x"), y: number("y"), z: number("z") },
      rotation: { ...object.rotation, y: (number("yaw") * Math.PI) / 180 },
      measurementSource: object.productId
        ? object.measurementSource
        : data.get("confirmed")
          ? "confirmed"
          : "estimated",
      locked: data.get("locked") === "on",
      productLocked: data.get("productLocked") === "on",
    });
    if (!parsed.success || !parsed.data.name) {
      setError("Enter a name and positive sizes in meters.");
      return;
    }
    setError("");
    onSave(parsed.data);
  }

  return (
    <form
      ref={form}
      onSubmit={submit}
      aria-label={`Edit ${object.name}`}
      className="-mt-[1.5px] grid gap-1.5 rounded-b-tile border-[1.5px] border-t-0 border-teal bg-white px-2.5 pt-1.5 pb-2.5"
    >
      {product && (
        <div className="mt-2 text-xs">
          <p className="font-medium">
            {formatMoney(product.priceCents)} · {product.merchant}
          </p>
          {!product.synthetic && (
            <a
              href={product.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-teal-deep underline"
            >
              View exact product variant
            </a>
          )}
          {product.synthetic && <Pill>sample product</Pill>}
        </div>
      )}
      {onMove && (
        <EditControls
          object={object}
          busy={busy}
          onMove={onMove}
          {...controls}
        />
      )}
      <div className="flex items-center gap-2 text-[11px] font-medium text-mute">
        Size, m
        <Pill tone={estimated ? "estimated" : "ok"}>
          {estimated ? "estimated" : "confirmed"}
        </Pill>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {(["width", "depth", "height"] as const).map((key) => (
          <Field key={key} label={key}>
            <NumberInput
              name={key}
              readOnly={Boolean(object.productId)}
              step="0.001"
              min="0.001"
              max="100"
              required
              defaultValue={object.dimensions[key]}
            />
          </Field>
        ))}
      </div>
      <Checkbox
        name="confirmed"
        label="Measurements confirmed"
        defaultChecked={!estimated}
        disabled={Boolean(product)}
      />
      <Checkbox
        name="productLocked"
        label="Keep this product"
        defaultChecked={object.productLocked ?? false}
      />
      <Checkbox
        name="locked"
        label="Keep in place"
        defaultChecked={object.locked}
      />
      <details className="group">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-teal-deep">
          <span className="group-open:hidden">More</span>
          <span className="hidden group-open:inline">Less</span>
        </summary>
        <div className="mt-1.5 grid gap-1.5">
          <Field label="Name">
            <TextInput name="name" defaultValue={object.name} maxLength={120} />
          </Field>
          <Field label="Category">
            <Select
              name="category"
              defaultValue={object.category}
              disabled={Boolean(product)}
            >
              {categorySchema.options.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-1.5">
            {(["x", "y", "z"] as const).map((key) => (
              <Field key={key} label={`Position ${key}`}>
                <NumberInput
                  name={key}
                  step="0.001"
                  required
                  defaultValue={object.position[key]}
                />
              </Field>
            ))}
          </div>
          <Field label="Rotation" hint="degrees">
            <NumberInput
              name="yaw"
              step="0.1"
              required
              defaultValue={(object.rotation.y * 180) / Math.PI}
            />
          </Field>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-xs text-rust">
          {error}
        </p>
      )}
      <div className="mt-0.5 grid grid-cols-2 gap-1">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          className="col-span-2"
          disabled={busy}
        >
          Save changes
        </Button>
        <Button
          variant="quiet"
          size="sm"
          disabled={!canReset || busy}
          onClick={onReset}
        >
          {object.detectionSource === "photo"
            ? "Reset estimate"
            : "Reset to scan"}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={busy || object.productLocked || object.locked}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {onReplace &&
        !object.productLocked &&
        products.some((item) => item.id !== object.productId) && (
          <div className="mt-2 grid gap-1.5 border-t border-line pt-2">
            <Field label="Replace with">
              <Select
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
              >
                <option value="">Choose a found product</option>
                {products
                  .filter((item) => item.id !== object.productId)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {formatMoney(item.priceCents)}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              size="sm"
              disabled={busy || !replacement}
              onClick={async () => {
                setError("");
                try {
                  await onReplace(replacement);
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not replace this item.",
                  );
                }
              }}
            >
              Replace item
            </Button>
          </div>
        )}
    </form>
  );
}
