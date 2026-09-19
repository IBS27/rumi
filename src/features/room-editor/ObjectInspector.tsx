import { useState, type FormEvent } from "react";
import { Check, RotateCcw, Trash2 } from "lucide-react";
import {
  categorySchema,
  roomObjectSchema,
  type RoomObject,
} from "../../../shared/contracts";

export function ObjectInspector({
  object,
  onSave,
  onRemove,
  onReset,
  original,
}: {
  object: RoomObject;
  onSave: (next: RoomObject) => void;
  onRemove: () => void;
  onReset: () => void;
  original: boolean;
}) {
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const number = (key: string) => Number(data.get(key));
    const parsed = roomObjectSchema.safeParse({
      ...object,
      name: String(data.get("name")).trim(),
      category: data.get("category"),
      dimensions: {
        width: number("width"),
        height: number("height"),
        depth: number("depth"),
      },
      position: { x: number("x"), y: number("y"), z: number("z") },
      rotation: { ...object.rotation, y: (number("yaw") * Math.PI) / 180 },
      measurementSource: data.get("verified") ? "confirmed" : "estimated",
      locked: data.get("locked") === "on",
    });
    if (!parsed.success || !parsed.data.name) {
      setError(
        "Enter a name and positive dimensions, with finite positions and rotation.",
      );
      return;
    }
    setError("");
    onSave(parsed.data);
  }
  return (
    <aside className="inspector" aria-label="Selected furniture">
      <div className="eyebrow">SELECTED OBJECT</div>
      <h2>{object.name}</h2>
      <p className="muted">
        Approximate shape ·{" "}
        {object.measurementSource === "confirmed"
          ? "Verified dimensions"
          : "Estimated dimensions"}
      </p>
      <form onSubmit={submit}>
        <label>
          Name
          <input
            name="name"
            defaultValue={object.name}
            required
            maxLength={120}
          />
        </label>
        <label>
          Category
          <select name="category" defaultValue={object.category}>
            {categorySchema.options.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>
            Dimensions <span>meters</span>
          </legend>
          <div className="input-grid">
            {(["width", "depth", "height"] as const).map((key) => (
              <label key={key}>
                {key}
                <input
                  aria-label={`Furniture ${key}`}
                  name={key}
                  type="number"
                  step="0.001"
                  min="0.001"
                  max="100"
                  defaultValue={Number(object.dimensions[key].toFixed(3))}
                  required
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>
            Position <span>meters</span>
          </legend>
          <div className="input-grid">
            {(["x", "y", "z"] as const).map((key) => (
              <label key={key}>
                {key.toUpperCase()}
                <input
                  aria-label={`Position ${key}`}
                  name={key}
                  type="number"
                  step="0.001"
                  defaultValue={Number(object.position[key].toFixed(3))}
                  required
                />
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Rotation <span className="muted">degrees</span>
          <input
            name="yaw"
            type="number"
            step="0.1"
            defaultValue={Number(
              ((object.rotation.y * 180) / Math.PI).toFixed(1),
            )}
            required
          />
        </label>
        <label className="checkbox">
          <input
            name="verified"
            type="checkbox"
            defaultChecked={object.measurementSource === "confirmed"}
          />{" "}
          I verified these dimensions
        </label>
        <label className="checkbox">
          <input name="locked" type="checkbox" defaultChecked={object.locked} />{" "}
          Keep this item in future designs
        </label>
        <p className="muted small">
          Detection confidence: {object.detectionConfidence ?? "unknown"}. This
          is not a measurement tolerance.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary full" type="submit">
          <Check size={16} /> Apply changes
        </button>
      </form>
      <div className="inspector-actions">
        <button disabled={!original} onClick={onReset}>
          <RotateCcw size={15} /> Reset to scan
        </button>
        <button className="danger" onClick={onRemove}>
          <Trash2 size={15} /> Remove
        </button>
      </div>
    </aside>
  );
}
