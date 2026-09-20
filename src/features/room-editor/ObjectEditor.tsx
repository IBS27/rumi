import { useState, type FormEvent } from "react";
import {
  categorySchema,
  roomObjectSchema,
  type RoomObject,
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
}: {
  object: RoomObject;
  canReset: boolean;
  onSave: (next: RoomObject) => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const [error, setError] = useState("");
  const estimated = object.measurementSource !== "confirmed";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const number = (key: string) => Number(data.get(key));
    const parsed = roomObjectSchema.safeParse({
      ...object,
      name: String(data.get("name") ?? object.name).trim(),
      category: data.get("category") ?? object.category,
      dimensions: {
        width: number("width"),
        depth: number("depth"),
        height: number("height"),
      },
      position: { x: number("x"), y: number("y"), z: number("z") },
      rotation: { ...object.rotation, y: (number("yaw") * Math.PI) / 180 },
      measurementSource: data.get("confirmed") ? "confirmed" : "estimated",
      locked: data.get("locked") === "on",
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
      onSubmit={submit}
      aria-label={`Edit ${object.name}`}
      className="-mt-[1.5px] grid gap-1.5 rounded-b-tile border-[1.5px] border-t-0 border-teal bg-white px-2.5 pt-1.5 pb-2.5"
    >
      <div className="flex items-center gap-2 text-[11px] font-medium text-[#4e5d69]">
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
              step="0.001"
              min="0.001"
              max="100"
              required
              defaultValue={Number(object.dimensions[key].toFixed(3))}
            />
          </Field>
        ))}
      </div>
      <Checkbox
        name="confirmed"
        label="Measurements confirmed"
        defaultChecked={!estimated}
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
            <Select name="category" defaultValue={object.category}>
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
                  defaultValue={Number(object.position[key].toFixed(3))}
                />
              </Field>
            ))}
          </div>
          <Field label="Rotation" hint="degrees">
            <NumberInput
              name="yaw"
              step="0.1"
              required
              defaultValue={Number(
                ((object.rotation.y * 180) / Math.PI).toFixed(1),
              )}
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
        >
          Save changes
        </Button>
        <Button
          variant="quiet"
          size="sm"
          disabled={!canReset}
          onClick={onReset}
        >
          Reset to scan
        </Button>
        <Button variant="danger" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </form>
  );
}
