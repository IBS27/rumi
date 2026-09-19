export function RoomPlaceholder() {
  return (
    <section
      className="grid h-full place-items-center bg-neutral-950 p-6"
      aria-labelledby="room-heading"
    >
      <div className="grid h-full w-full place-items-center rounded-2xl border border-dashed border-neutral-700 bg-neutral-900/40">
        <div className="max-w-sm text-center">
          <h2
            id="room-heading"
            className="mb-3 text-lg font-medium text-neutral-200"
          >
            3D room preview
          </h2>
          <p className="text-[13px] leading-6 text-neutral-500">
            Your room will render here — existing furniture, recommended
            products, and layout at real scale.
          </p>
        </div>
      </div>
    </section>
  );
}
